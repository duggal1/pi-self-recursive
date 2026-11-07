import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DesktopConfig } from "../src/desktop.ts";
import {
	APP_LEASE_TTL_MS,
	acquireAppLease,
	bashInvokesAgentDesktop,
	checkDesktopAccess,
	cleanupExpiredArtifacts,
	executeDesktopVerb,
	extractEventMetadata,
	getDesktopConfig,
	isSafeRetry,
	leaseHolder,
	parseEnvelope,
	releaseAppLease,
	runDesktopCommand,
	saveArtifact,
} from "../src/desktop.ts";
import ext from "../src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const SHIM = join(here, "fake-agent-desktop.mjs");

function freshDirs(): { root: string; artifacts: string; leases: string } {
	const root = mkdtempSync(join(tmpdir(), "orch-desktop-"));
	return { root, artifacts: join(root, "art"), leases: join(root, "leases") };
}

function desktopConfig(artifacts: string, leases: string, bin: string = SHIM): DesktopConfig {
	return {
		bin,
		binSource: "PATH",
		capabilities: ["desktop"],
		allowedApps: ["TextEdit"],
		artifactsDir: artifacts,
		leasesDir: leases,
		ttlMs: 60_000,
		enabled: true,
	};
}

describe("capability gate (off by default)", () => {
	it("is disabled without env", () => {
		const config = getDesktopConfig({});
		expect(config.enabled).toBe(false);
		expect(config.bin).toBe("agent-desktop");
		expect(config.binSource).toBe("PATH");
		expect(checkDesktopAccess("TextEdit", config)).toMatch(/capability not declared/);
	});
	it("enabled only when desktop is declared", () => {
		const config = getDesktopConfig({
			ORCHESTRA_DESKTOP_CAPABILITIES: "filesystem, desktop",
			ORCHESTRA_DESKTOP_ALLOWED_APPS: "TextEdit, Finder",
		});
		expect(config.enabled).toBe(true);
		expect(checkDesktopAccess("TextEdit", config)).toBeNull();
		expect(checkDesktopAccess("Finder", config)).toBeNull();
	});
	it("refuses apps outside the allowlist", () => {
		const config = getDesktopConfig({
			ORCHESTRA_DESKTOP_CAPABILITIES: "desktop",
			ORCHESTRA_DESKTOP_ALLOWED_APPS: "TextEdit",
		});
		expect(checkDesktopAccess("Slack", config)).toMatch(/not in/);
	});
	it("refuses every app when allowlist empty", () => {
		const config = getDesktopConfig({ ORCHESTRA_DESKTOP_CAPABILITIES: "desktop" });
		expect(checkDesktopAccess("TextEdit", config)).toMatch(/no apps allowlisted/);
	});
	it("does not build the gate from task caps — env only", () => {
		const config = getDesktopConfig({
			ORCHESTRA_CAPABILITIES: "desktop",
			ORCHESTRA_DESKTOP_ALLOWED_APPS: "TextEdit",
		});
		expect(config.enabled).toBe(true);
	});
	it("detects bash agent-desktop invocations", () => {
		expect(bashInvokesAgentDesktop("agent-desktop snapshot --app TextEdit")).toBe(true);
		expect(bashInvokesAgentDesktop("/opt/homebrew/bin/agent-desktop click @s1:e1")).toBe(true);
		expect(bashInvokesAgentDesktop("ls -la")).toBe(false);
		// Over-match is deliberate: any agent-desktop word blocks the bash path.
		expect(bashInvokesAgentDesktop("my-agent-desktop-helper --help")).toBe(true);
	});
	it("desktop tool returns error (not silent block) when capability missing", async () => {
		const { root, artifacts, leases } = freshDirs();
		try {
			const config: DesktopConfig = { ...desktopConfig(artifacts, leases), enabled: false, capabilities: [] };
			const result = await executeDesktopVerb({ verb: "snapshot", app: "TextEdit" }, { config, agentId: "a1" });
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(/capability not declared/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("envelope + retry dispositions", () => {
	it("parses the real envelope shape", () => {
		const envelope = parseEnvelope(
			JSON.stringify({
				version: "2.6",
				ok: false,
				command: "click",
				error: { code: "STALE_REF", message: "gone", disposition: { delivery: "not_delivered", retry: "safe" } },
			}),
		);
		expect(envelope?.error?.code).toBe("STALE_REF");
		expect(isSafeRetry(envelope!)).toBe(false); // ref action: never retry same argv
	});
	it("safe read-only errors retry once", async () => {
		const { root } = freshDirs();
		try {
			const countFile = join(root, "count.txt");
			const run = await runDesktopCommand(SHIM, ["snapshot", "--app", "TextEdit"], async (bin, args) => {
				const { execFile } = await import("node:child_process");
				return new Promise((resolve) => {
					execFile(
						bin,
						args,
						{ env: { ...process.env, FAKE_DESKTOP_MODE: "error-safe", FAKE_DESKTOP_COUNT_FILE: countFile } },
						(error, stdout, stderr) => {
							resolve({
								stdout: String(stdout ?? ""),
								stderr: String(stderr ?? ""),
								exitCode: error
									? typeof (error as { code?: unknown }).code === "number"
										? ((error as { code: number }).code as number)
										: 1
									: 0,
							});
						},
					);
				});
			});
			expect(run.attempts).toBe(2);
			expect(run.envelope?.ok).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("unsafe errors never retry", async () => {
		const { root } = freshDirs();
		try {
			let calls = 0;
			const run = await runDesktopCommand(SHIM, ["click", "@s1:e1"], async () => {
				calls++;
				return {
					stdout: JSON.stringify({
						version: "2.6",
						ok: false,
						command: "click",
						error: {
							code: "ACTION_FAILED",
							message: "may have landed",
							disposition: { delivery: "unknown", retry: "unsafe" },
						},
					}),
					stderr: "",
					exitCode: 1,
				};
			});
			expect(calls).toBe(1);
			expect(run.attempts).toBe(1);
			expect(run.envelope?.ok).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("app leases (non-blocking)", () => {
	it("conflicts without blocking and releases", async () => {
		const { root, leases } = freshDirs();
		try {
			const first = await acquireAppLease(leases, "TextEdit", "agent-a", "task-1", 1000);
			expect(first.ok).toBe(true);
			const second = await acquireAppLease(leases, "TextEdit", "agent-b", "task-2", 1001);
			expect(second.ok).toBe(false);
			if (!second.ok) {
				expect(second.owner).toBe("agent-a");
			}
			const holder = await leaseHolder(leases, "TextEdit", 1002);
			expect(holder?.agentId).toBe("agent-a");
			await releaseAppLease(leases, "TextEdit", "agent-a");
			const third = await acquireAppLease(leases, "TextEdit", "agent-b", "task-2", 1003);
			expect(third.ok).toBe(true);
			const sameAgent = await acquireAppLease(leases, "TextEdit", "agent-b", "task-2", 1004);
			expect(sameAgent.ok).toBe(false); // O_EXCL: even same agent must release first
			await releaseAppLease(leases, "TextEdit", "agent-b");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("expired lease is reclaimable", async () => {
		const { root, leases } = freshDirs();
		try {
			const first = await acquireAppLease(leases, "TextEdit", "a", "t", 1000, 100);
			expect(first.ok).toBe(true);
			const holder = await leaseHolder(leases, "TextEdit", 1000 + APP_LEASE_TTL_MS + 1);
			expect(holder).toBeNull();
			const third = await acquireAppLease(leases, "TextEdit", "b", "t", 1000 + APP_LEASE_TTL_MS + 2);
			expect(third.ok).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("privacy: payloads never in results", () => {
	it("snapshot results carry hashes only; tree secret never leaks", async () => {
		const { root, artifacts, leases } = freshDirs();
		try {
			const config = desktopConfig(artifacts, leases);
			const result = await executeDesktopVerb(
				{ verb: "snapshot", app: "TextEdit" },
				{
					config,
					agentId: "a1",
					exec: async (bin, args) => {
						const { execFile } = await import("node:child_process");
						return new Promise((resolve) => {
							execFile(
								bin,
								args,
								{ env: { ...process.env, FAKE_DESKTOP_MODE: "secret" } },
								(error, stdout, stderr) => {
									resolve({
										stdout: String(stdout ?? ""),
										stderr: String(stderr ?? ""),
										exitCode: error ? 1 : 0,
									});
								},
							);
						});
					},
				},
			);
			expect(result.isError).toBe(false);
			expect(result.text).not.toContain("SECRET_PAYLOAD_DO_NOT_LOG");
			expect(JSON.stringify(result.details)).not.toContain("SECRET_PAYLOAD_DO_NOT_LOG");
			// event metadata is command/app/ok/error/refcount only
			const meta = result.details;
			expect(meta.command).toBe("snapshot");
			expect(meta.app).toBe("TextEdit");
			expect(meta.ok).toBe(true);
			expect(meta.refCount).toBe(1);
			// artifact is 0600 and contains the secret (payload lives only there)
			const saved = readFileSync(String(meta.path), "utf8");
			expect(saved).toContain("SECRET_PAYLOAD_DO_NOT_LOG");
			expect(statSync(String(meta.path)).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("event metadata strips tree and error.details", () => {
		const envelope = parseEnvelope(
			JSON.stringify({
				version: "2.6",
				ok: false,
				command: "click",
				error: {
					code: "ACTION_FAILED",
					message: "failed",
					disposition: { delivery: "unknown", retry: "unsafe" },
					details: { payload: "SECRET_PAYLOAD_DO_NOT_LOG" },
				},
				data: { app: "TextEdit", tree: { children: [{ name: "SECRET_PAYLOAD_DO_NOT_LOG" }] } },
			}),
		)!;
		const meta = extractEventMetadata(envelope);
		expect(meta).toEqual({
			command: "click",
			app: "TextEdit",
			ok: false,
			errorCode: "ACTION_FAILED",
			refCount: null,
		});
		expect(JSON.stringify(meta)).not.toContain("SECRET_PAYLOAD_DO_NOT_LOG");
	});
	it("screenshot returns artifact hashes, never base64", async () => {
		const { root, artifacts, leases } = freshDirs();
		try {
			const config = desktopConfig(artifacts, leases);
			const result = await executeDesktopVerb({ verb: "screenshot", app: "TextEdit" }, { config, agentId: "a1" });
			expect(result.isError).toBe(false);
			expect(result.text).not.toMatch(/iVBORw0KGgo/);
			expect(String(result.details.modelViewSha)).toHaveLength(64);
			expect(statSync(String(result.details.modelViewPath)).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("artifacts clean up on TTL", async () => {
		const { root, artifacts } = freshDirs();
		try {
			const artifact = await saveArtifact(artifacts, Buffer.from("hello"), "txt");
			expect(statSync(artifact.path).mode & 0o777).toBe(0o600);
			const removed = await cleanupExpiredArtifacts(artifacts, -1, Date.now());
			expect(removed).toContain(artifact.path);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("act never retries; stale refs re-snapshot", () => {
	it("unsafe act failure surfaces code and asks for fresh snapshot without retrying", async () => {
		const { root, artifacts, leases } = freshDirs();
		try {
			let calls = 0;
			const config = desktopConfig(artifacts, leases);
			const result = await executeDesktopVerb(
				{ verb: "act", ref: "@s1:e1", action: "click" },
				{
					config,
					agentId: "a1",
					exec: async () => {
						calls++;
						return {
							stdout: JSON.stringify({
								version: "2.6",
								ok: false,
								command: "click",
								error: {
									code: "ACTION_FAILED",
									message: "may have landed",
									disposition: { delivery: "unknown", retry: "unsafe" },
								},
							}),
							stderr: "",
							exitCode: 1,
						};
					},
				},
			);
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(/ACTION_FAILED/);
			expect(calls).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("lease conflict fails fast without spawning", async () => {
		const { root, artifacts, leases } = freshDirs();
		try {
			await acquireAppLease(leases, "TextEdit", "holder", "t", Date.now());
			let calls = 0;
			const config = desktopConfig(artifacts, leases);
			const result = await executeDesktopVerb(
				{ verb: "snapshot", app: "TextEdit" },
				{
					config,
					agentId: "other",
					exec: async () => {
						calls++;
						return { stdout: "{}", stderr: "", exitCode: 0 };
					},
				},
			);
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(/lease held by holder/);
			expect(calls).toBe(0);
			await releaseAppLease(leases, "TextEdit", "holder");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("guard: tool_call handler (index.ts)", () => {
	function loadGuard(): (event: {
		toolName: string;
		input: Record<string, unknown>;
	}) => Promise<{ block: boolean; reason: string } | undefined> {
		const handlers = new Map<string, (event: never) => Promise<unknown>>();
		const tools: string[] = [];
		const fakePi = {
			on: (event: string, fn: (event: never) => Promise<unknown>) => handlers.set(event, fn),
			registerTool: (t: { name: string }) => tools.push(t.name),
		} as unknown as Parameters<typeof ext>[0];
		ext(fakePi);
		expect(tools).toContain("desktop");
		const guard = handlers.get("tool_call");
		if (!guard) throw new Error("tool_call handler missing");
		return guard as never;
	}

	it("blocks desktop tool calls without capability", async () => {
		const guard = loadGuard();
		const verdict = await guard({ toolName: "desktop", input: { verb: "snapshot", app: "TextEdit" } });
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason ?? "").toMatch(/desktop capability/);
	});

	it("blocks bash invoking agent-desktop without capability", async () => {
		const guard = loadGuard();
		const verdict = await guard({ toolName: "bash", input: { command: "agent-desktop snapshot --app TextEdit" } });
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason ?? "").toMatch(/agent-desktop without desktop capability/);
	});

	it("allows ordinary bash without desktop invocation", async () => {
		const guard = loadGuard();
		const verdict = await guard({ toolName: "bash", input: { command: "ls -la" } });
		expect(verdict ?? undefined).toBeUndefined();
	});

	it("allowed reads still pass (existing guard intact)", async () => {
		const guard = loadGuard();
		expect(await guard({ toolName: "read", input: { path: "x.ts" } })).toBeUndefined();
	});
});

describe("real smoke (gated — never in CI)", () => {
	it("runs only when ORCHESTRA_DESKTOP_REAL_SMOKE=1 and permission granted", async () => {
		if (process.env.ORCHESTRA_DESKTOP_REAL_SMOKE !== "1") return;
		const { root, artifacts, leases } = freshDirs();
		try {
			const config: DesktopConfig = {
				bin: process.env.AGENT_DESKTOP_BIN ?? "agent-desktop",
				binSource: "PATH",
				capabilities: ["desktop"],
				allowedApps: ["TextEdit", "Finder"],
				artifactsDir: artifacts,
				leasesDir: leases,
				ttlMs: 60_000,
				enabled: true,
			};
			for (const app of ["TextEdit", "Finder"]) {
				const result = await executeDesktopVerb({ verb: "snapshot", app }, { config, agentId: "smoke" });
				expect(result.text).toContain(app);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
