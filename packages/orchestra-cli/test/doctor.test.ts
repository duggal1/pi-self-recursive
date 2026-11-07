import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	countNamedRefs,
	DESKTOP_PINNED_VERSION,
	parseDesktopStatus,
	parseDesktopVersion,
	parseDoctorArgs,
	resolveDesktopBinary,
	runDoctor,
} from "../src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const SHIM = join(here, "fake-agent-desktop.mjs");

describe("doctor: binary + version", () => {
	it("reports exact pinned version and status ok", async () => {
		const report = await runDoctor({ env: { AGENT_DESKTOP_BIN: SHIM }, args: [] });
		expect(report.ok).toBe(true);
		expect(report.exitCode).toBe(0);
		expect(report.version).toBe(DESKTOP_PINNED_VERSION);
		expect(report.lines.join("\n")).toMatch(/1\.0\.2/);
	});
	it("fails closed on version mismatch", async () => {
		const prev = process.env.FAKE_DESKTOP_MODE;
		process.env.FAKE_DESKTOP_MODE = "mismatch";
		try {
			const report = await runDoctor({ env: { AGENT_DESKTOP_BIN: SHIM }, args: [] });
			expect(report.ok).toBe(false);
			expect(report.exitCode).toBe(1);
			expect(report.lines.join("\n")).toMatch(/MISMATCH/);
		} finally {
			if (prev === undefined) delete process.env.FAKE_DESKTOP_MODE;
			else process.env.FAKE_DESKTOP_MODE = prev;
		}
	});
	it("fails closed when binary missing", async () => {
		const report = await runDoctor({ env: { AGENT_DESKTOP_BIN: "/nonexistent/agent-desktop" }, args: [] });
		expect(report.ok).toBe(false);
		expect(report.exitCode).toBe(1);
		expect(report.lines.join("\n")).toMatch(/binary not found/);
	});
	it("fails closed when status envelope is an error", async () => {
		const prev = process.env.FAKE_DESKTOP_MODE;
		process.env.FAKE_DESKTOP_MODE = "status-denied";
		try {
			const report = await runDoctor({ env: { AGENT_DESKTOP_BIN: SHIM }, args: [] });
			expect(report.ok).toBe(false);
			expect(report.lines.join("\n")).toMatch(/PERM_DENIED/);
		} finally {
			if (prev === undefined) delete process.env.FAKE_DESKTOP_MODE;
			else process.env.FAKE_DESKTOP_MODE = prev;
		}
	});
	it("resolves AGENT_DESKTOP_BIN over PATH", () => {
		expect(resolveDesktopBinary({ AGENT_DESKTOP_BIN: "/x/y" })).toEqual({ bin: "/x/y", source: "AGENT_DESKTOP_BIN" });
		expect(resolveDesktopBinary({})).toEqual({ bin: "agent-desktop", source: "PATH" });
	});
});

describe("doctor: permissions guidance only", () => {
	it("prints macOS guidance and never opens System Settings", async () => {
		const report = await runDoctor({ env: { AGENT_DESKTOP_BIN: SHIM }, args: [] });
		const text = report.lines.join("\n");
		expect(text).toMatch(/Accessibility/);
		expect(text).toMatch(/Screen Recording/);
		expect(text).toMatch(/never grants permissions and never opens System Settings/);
		// doctor deliberately never invokes open/deeplink commands
		expect(text).not.toMatch(/open\s+x-apple|open\s+System Settings/i);
	});
});

describe("doctor: bench", () => {
	it("measures latency + completeness, poor trees say so plainly", async () => {
		const report = await runDoctor({
			env: { AGENT_DESKTOP_BIN: SHIM },
			args: ["--bench", "--app", "TextEdit"],
		});
		expect(report.ok).toBe(true);
		const benchLine = report.lines.find((l) => l.startsWith("bench:"));
		expect(benchLine).toMatch(/app=TextEdit latency=\d+ms/);
		expect(benchLine).toMatch(/complete=true/);
	});
	it("poor tree exits non-zero and is labelled POOR in plain words", async () => {
		const prev = process.env.FAKE_DESKTOP_MODE;
		process.env.FAKE_DESKTOP_MODE = "poor";
		try {
			const report = await runDoctor({
				env: { AGENT_DESKTOP_BIN: SHIM },
				args: ["--bench", "--app", "TextEdit"],
			});
			expect(report.ok).toBe(false);
			expect(report.exitCode).toBe(1);
			expect(report.lines.join("\n")).toMatch(/POOR TREE/);
		} finally {
			if (prev === undefined) delete process.env.FAKE_DESKTOP_MODE;
			else process.env.FAKE_DESKTOP_MODE = prev;
		}
	});
	it("counts named refs only", () => {
		expect(
			countNamedRefs({ role: "window", name: "x", children: [{ role: "button", name: "OK", ref_id: "@s1:e1" }] }),
		).toBe(1);
		expect(countNamedRefs({ role: "window", children: [{ role: "button", name: "", ref_id: "@s1:e2" }] })).toBe(0);
	});
	it("parses bench args", () => {
		expect(parseDoctorArgs(["--bench", "--app", "TextEdit", "--app=Finder"])).toEqual({
			bench: true,
			apps: ["TextEdit", "Finder"],
		});
		expect(parseDoctorArgs([])).toEqual({ bench: false, apps: [] });
	});
});

describe("version/status parsers", () => {
	it("parseDesktopVersion handles envelope and --version", () => {
		expect(parseDesktopVersion('{"version":"2.6","ok":true,"command":"version","data":{"version":"1.0.2"}}')).toBe(
			"1.0.2",
		);
		expect(parseDesktopVersion("agent-desktop 1.0.2\n")).toBe("1.0.2");
		expect(parseDesktopVersion("garbage")).toBeNull();
	});
	it("parseDesktopStatus rejects non-JSON and ok:false", () => {
		expect(parseDesktopStatus("not json").ok).toBe(false);
		expect(
			parseDesktopStatus(
				'{"version":"2.6","ok":false,"command":"status","error":{"code":"PERM_DENIED","message":"denied"}}',
			).ok,
		).toBe(false);
		const good = parseDesktopStatus(
			'{"version":"2.6","ok":true,"command":"status","data":{"platform":"macos","version":"1.0.2","permissions":{"accessibility":true,"screen_recording":true},"supported_surfaces":["window"]}}',
		);
		expect(good.ok).toBe(true);
	});
});

describe("keeps existing commands working", () => {
	it("renderStatus still renders agents", async () => {
		const { Store } = await import("@earendil-works/pi-orchestra-core");
		const { renderStatus } = await import("../src/index.ts");
		const dir = mkdtempSync(join(tmpdir(), "orch-cli-doc-"));
		const store = new Store({ path: join(dir, "c.db") });
		try {
			const agent = store.createAgent({ name: "ada", role: "lead" });
			store.createTask({ title: "plan", spec: "split", ownerAgentId: agent.id });
			const out = renderStatus(store);
			expect(out).toContain("ada");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
