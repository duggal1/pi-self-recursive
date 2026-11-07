// Orchestra CLI rendering helpers (pure, testable).
import { execFile } from "node:child_process";
import type { Store } from "@earendil-works/pi-orchestra-core";

export function renderStatus(store: Store, opts: { runId?: string; elapsedMs?: number } = {}): string {
	const agents = store.listAgents();
	const tasks = store.listTasks();
	const leases = store.listLeases();
	const escalations = store.listEscalations().filter((e) => e.state === "open");
	const elapsed = opts.elapsedMs !== undefined ? formatElapsed(opts.elapsedMs) : "—";
	const lines: string[] = [];
	lines.push(
		`ORCHESTRA ${opts.runId ?? "dev"}  elapsed ${elapsed}  agents ${agents.length}  escalations ${escalations.length}`,
	);
	lines.push("AGENTS");
	lines.push("  name     role      task  state");
	for (const a of agents)
		lines.push(
			`  ${a.name.slice(0, 8).padEnd(8)} ${a.role.slice(0, 9).padEnd(9)} ${(a.taskId?.slice(0, 6) ?? "—").padEnd(6)} ${a.state}`,
		);
	lines.push("TASKS");
	for (const t of tasks.slice(0, 20))
		lines.push(`  ${t.id.slice(0, 6)} ${t.state} ${t.title.slice(0, 60)} attempt ${t.attempts}`);
	lines.push("LEASES");
	for (const l of leases.slice(0, 20)) {
		const owner = store.getAgent(l.agentId);
		lines.push(`  ${l.path} → ${owner?.name ?? l.agentId}`);
	}
	lines.push(`ESCALATIONS (${escalations.length})`);
	for (const e of escalations.slice(0, 10)) lines.push(`  ${e.id.slice(0, 6)} ${e.reason.slice(0, 100)}`);
	return lines.join("\n");
}

export function renderReport(store: Store): string {
	const runs = store.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT 5`).all() as Record<
		string,
		unknown
	>[];
	const lines: string[] = ["ORCHESTRA REPORT"];
	if (runs.length === 0) lines.push("  (no runs yet)");
	for (const r of runs) {
		const reprompts = store.db.prepare(`SELECT COUNT(*) AS n FROM reprompts`).get() as { n: number } | undefined;
		lines.push(
			`  run ${String(r.run_id)} goal=${String(r.goal).slice(0, 80)} finished=${r.finished_at == null ? "no" : "yes"} reprompts=${String(r.reprompt_rounds ?? 0)}`,
		);
		lines.push(`    gap types: ${String(r.gap_types ?? "[]")}`);
		lines.push(
			`    spend: ${String(r.spend_per_agent ?? "{}")} thinking: ${String(r.thinking_per_agent ?? "{}")} timeToDone: ${r.time_to_done_ms ?? "—"}`,
		);
		void reprompts;
	}
	lines.push(
		`  agents: ${store.listAgents().length} tasks: ${store.listTasks().length} escalations: ${store.listEscalations().filter((e) => e.state === "open").length} open`,
	);
	return lines.join("\n");
}

export function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	const hh = Math.floor(s / 3600);
	const mm = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// --- agent-desktop doctor (Part C) ---

/** Pinned upstream release; doctor compares `agent-desktop` version against this. */
export const DESKTOP_PINNED_VERSION = "1.0.2";
/** Env var that overrides the `agent-desktop` binary location. */
export const DESKTOP_BIN_ENV = "AGENT_DESKTOP_BIN";

export interface DoctorExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type DoctorExec = (bin: string, args: string[], opts?: { timeoutMs?: number }) => Promise<DoctorExecResult>;

function defaultDoctorExec(bin: string, args: string[], opts?: { timeoutMs?: number }): Promise<DoctorExecResult> {
	return new Promise((resolve) => {
		execFile(
			bin,
			args,
			{ timeout: opts?.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
					resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: 127 });
					return;
				}
				if (error) {
					// Non-zero exit still carries stdout (JSON envelope); surface it.
					const code =
						typeof (error as { code?: unknown }).code === "number"
							? ((error as { code: number }).code as number)
							: 1;
					resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: code });
					return;
				}
				resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: 0 });
			},
		);
	});
}

export function resolveDesktopBinary(env: Record<string, string | undefined>): {
	bin: string;
	source: string;
} {
	const override = env[DESKTOP_BIN_ENV];
	if (override && override.length > 0) return { bin: override, source: DESKTOP_BIN_ENV };
	return { bin: "agent-desktop", source: "PATH" };
}

/** Parse `agent-desktop version` (JSON envelope) or `--version` output into an exact version string. */
export function parseDesktopVersion(stdout: string): string | null {
	const text = stdout.trim();
	if (!text) return null;
	try {
		const parsed = JSON.parse(text) as { data?: { version?: unknown } };
		if (parsed && typeof parsed.data?.version === "string" && parsed.data.version.length > 0) {
			return parsed.data.version;
		}
	} catch {
		// `--version` is plain text ("agent-desktop 1.0.2"); fall through.
	}
	const match =
		text.match(/\b(\d+\.\d+\.\d+[-+a-zA-Z0-9.]*)\s*$/m) ?? text.match(/\b(\d+\.\d+\.\d+[-+a-zA-Z0-9.]*)\b/);
	return match?.[1] ?? null;
}

export interface DesktopStatusData {
	platform?: string;
	version?: string;
	permissions?: { accessibility?: boolean; screen_recording?: boolean; automation?: boolean };
	supportedSurfaces?: unknown;
	snapshotId?: string | null;
	refCount?: number | null;
}

/** Parse `agent-desktop status` envelope; `ok:false` and non-JSON both fail. */
export function parseDesktopStatus(
	stdout: string,
): { ok: true; data: DesktopStatusData } | { ok: false; error: string } {
	let parsed: { ok?: unknown; data?: unknown; error?: unknown };
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		return { ok: false, error: "status output is not JSON" };
	}
	if (parsed.ok !== true) {
		const err = parsed.error as { code?: unknown; message?: unknown } | undefined;
		return {
			ok: false,
			error:
				typeof err?.message === "string" && err.message.length > 0
					? `${String(err.code ?? "ERROR")}: ${err.message}`
					: "status envelope ok:false",
		};
	}
	const data = (parsed.data ?? {}) as Record<string, unknown>;
	const perms = (data.permissions ?? {}) as Record<string, unknown>;
	const enabled = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
	const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	return {
		ok: true,
		data: {
			platform: asString(data.platform),
			version: asString(data.version),
			permissions: {
				accessibility: enabled(perms.accessibility),
				screen_recording: enabled(perms.screen_recording),
				automation: enabled(perms.automation),
			},
			supportedSurfaces: data.supported_surfaces,
			snapshotId: typeof data.snapshot_id === "string" ? data.snapshot_id : null,
			refCount: typeof data.ref_count === "number" ? data.ref_count : null,
		},
	};
}

export interface BenchRow {
	app: string;
	latencyMs: number;
	refCount: number | null;
	namedCount: number | null;
	complete: boolean;
	verdict: "ok" | "poor" | "error";
	error?: string;
}

interface TreeNode {
	role?: unknown;
	name?: unknown;
	ref_id?: unknown;
	children?: unknown;
}

/** Count nodes that carry both a ref and a non-empty accessible name. */
export function countNamedRefs(tree: unknown): number {
	let named = 0;
	const walk = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const n = node as TreeNode;
		if (typeof n.ref_id === "string" && n.ref_id.length > 0 && typeof n.name === "string" && n.name.length > 0) {
			named++;
			return;
		}
		if (Array.isArray(n.children)) {
			for (const child of n.children) walk(child);
		}
	};
	walk(tree);
	return named;
}

export function parseDoctorArgs(argv: string[]): { bench: boolean; apps: string[] } {
	let bench = false;
	const apps: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--bench") bench = true;
		else if (arg === "--app" && argv[i + 1]) {
			apps.push(argv[i + 1]!);
			i++;
		} else if (arg.startsWith("--app=")) {
			const value = arg.slice("--app=".length);
			if (value) apps.push(value);
		}
	}
	return { bench, apps };
}

export async function runDesktopBench(app: string, exec: DoctorExec, bin: string): Promise<BenchRow> {
	const started = Date.now();
	let result: DoctorExecResult;
	try {
		result = await exec(bin, ["snapshot", "--app", app, "-i", "--compact"], { timeoutMs: 30_000 });
	} catch (error) {
		return {
			app,
			latencyMs: Date.now() - started,
			refCount: null,
			namedCount: null,
			complete: false,
			verdict: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const latencyMs = Date.now() - started;
	let parsed: { ok?: unknown; data?: Record<string, unknown>; error?: { code?: unknown; message?: unknown } };
	try {
		parsed = JSON.parse(result.stdout.trim());
	} catch {
		return {
			app,
			latencyMs,
			refCount: null,
			namedCount: null,
			complete: false,
			verdict: "error",
			error: `exit ${result.exitCode} non-JSON output`,
		};
	}
	if (parsed.ok !== true) {
		const err = parsed.error;
		return {
			app,
			latencyMs,
			refCount: null,
			namedCount: null,
			complete: false,
			verdict: "error",
			error: `${String(err?.code ?? "ERROR")}: ${String(err?.message ?? "snapshot failed")}`,
		};
	}
	const data = (parsed.data ?? {}) as Record<string, unknown>;
	const refCount = typeof data.ref_count === "number" ? data.ref_count : null;
	const complete = data.complete === true;
	const namedCount = countNamedRefs(data.tree);
	if (refCount === 0 || !complete || refCount === null || namedCount < refCount) {
		return { app, latencyMs, refCount, namedCount, complete, verdict: "poor" };
	}
	return { app, latencyMs, refCount, namedCount, complete, verdict: "ok" };
}

export interface DoctorInput {
	exec?: DoctorExec;
	env?: Record<string, string | undefined>;
	args?: string[];
	platform?: string;
}

export interface DoctorReport {
	ok: boolean;
	exitCode: number;
	lines: string[];
	binary?: string;
	binSource?: string;
	version?: string;
	versionOk: boolean;
	statusOk: boolean;
	bench?: BenchRow[];
}

/**
 * `orchestra doctor`: binary / version / status / permissions / bench.
 * Prints guidance only. Never grants permissions and never opens System Settings.
 * Exits non-zero when the binary is missing, the exact version mismatches the pinned
 * release, `status` fails, required permissions are missing, or bench fails/is poor.
 */
export async function runDoctor(input: DoctorInput = {}): Promise<DoctorReport> {
	const exec = input.exec ?? defaultDoctorExec;
	const env = input.env ?? (process.env as Record<string, string | undefined>);
	const { bench, apps } = parseDoctorArgs(input.args ?? []);
	const platform = input.platform ?? process.platform;
	const lines: string[] = [];
	const { bin, source } = resolveDesktopBinary(env);
	lines.push(`binary: ${bin} (via ${source})`);

	// 1. version (prefer `version` subcommand, fall back to `--version`).
	let version: string | null = null;
	let versionExit = 1;
	try {
		const first = await exec(bin, ["version"], { timeoutMs: 10_000 });
		versionExit = first.exitCode;
		version = parseDesktopVersion(first.stdout);
		if (version === null && first.exitCode !== 127) {
			const fallback = await exec(bin, ["--version"], { timeoutMs: 10_000 });
			versionExit = fallback.exitCode;
			version = parseDesktopVersion(fallback.stdout);
		}
	} catch (error) {
		lines.push(`version: ERROR ${error instanceof Error ? error.message : String(error)}`);
		return {
			ok: false,
			exitCode: 1,
			lines,
			binary: bin,
			binSource: source,
			versionOk: false,
			statusOk: false,
		};
	}
	if (version === null || versionExit === 127) {
		lines.push(`version: ERROR binary not found or no version output (exit ${versionExit})`);
		lines.push(
			`install: npm install -g agent-desktop (Apache-2.0, vercel-labs/agent-desktop); pinned ${DESKTOP_PINNED_VERSION}`,
		);
		return {
			ok: false,
			exitCode: 1,
			lines,
			binary: bin,
			binSource: source,
			versionOk: false,
			statusOk: false,
		};
	}
	const versionOk = version === DESKTOP_PINNED_VERSION;
	lines.push(`version: ${version} (pinned ${DESKTOP_PINNED_VERSION}) ${versionOk ? "ok" : "MISMATCH"}`);
	if (!versionOk) {
		lines.push(
			`version: ERROR exact version mismatch — install pinned ${DESKTOP_PINNED_VERSION} (npm install -g agent-desktop@${DESKTOP_PINNED_VERSION})`,
		);
	}

	// 2. status (report only; never requests or guides permissions).
	let status: ReturnType<typeof parseDesktopStatus> | null = null;
	let statusExit = 1;
	try {
		const result = await exec(bin, ["status"], { timeoutMs: 10_000 });
		statusExit = result.exitCode;
		status = parseDesktopStatus(result.stdout);
	} catch (error) {
		lines.push(`status: ERROR ${error instanceof Error ? error.message : String(error)}`);
	}
	let statusOk = false;
	let permOk = true;
	if (status === null) {
		lines.push("status: ERROR no status output");
	} else if (!status.ok) {
		lines.push(`status: ERROR ${status.error}`);
	} else {
		statusOk = statusExit === 0;
		const d = status.data;
		lines.push(
			`status: platform=${d.platform ?? "unknown"} version=${d.version ?? "?"} accessibility=${String(d.permissions?.accessibility ?? "?")} screen_recording=${String(d.permissions?.screen_recording ?? "?")} automation=${String(d.permissions?.automation ?? "?")}`,
		);
		const surfaces = Array.isArray(d.supportedSurfaces) ? d.supportedSurfaces.map(String).join(",") : "?";
		lines.push(`status: supported_surfaces=${surfaces}`);
		if (d.snapshotId) lines.push(`status: snapshot_id=${d.snapshotId} ref_count=${d.refCount ?? "?"}`);
		if (statusExit !== 0) {
			statusOk = false;
			lines.push(`status: ERROR non-zero exit ${statusExit}`);
		}
		if (platform === "darwin" && d.permissions?.accessibility === false) permOk = false;
		if (platform === "darwin" && d.permissions?.screen_recording === false) permOk = false;
		if (!permOk) lines.push("status: ERROR required permission not granted (see below)");
	}

	// 3. permission guidance (print only — never grant, never open System Settings).
	lines.push("permissions: grant yourself via System Settings > Privacy & Security > Accessibility");
	lines.push("permissions: grant yourself via System Settings > Privacy & Security > Screen Recording (screenshots)");
	lines.push("permissions: some commands also need System Settings > Privacy & Security > Automation (System Events)");
	lines.push("permissions: orchestra doctor never grants permissions and never opens System Settings");

	// 4. optional bench.
	let benchRows: BenchRow[] | undefined;
	let benchOk = true;
	if (bench) {
		const targets = apps.length > 0 ? apps : ["TextEdit"];
		benchRows = [];
		for (const app of targets) {
			const row = await runDesktopBench(app, exec, bin);
			benchRows.push(row);
			if (row.verdict === "error") {
				benchOk = false;
				lines.push(`bench: app=${app} latency=${row.latencyMs}ms verdict=ERROR ${row.error ?? ""}`);
			} else if (row.verdict === "poor") {
				benchOk = false;
				lines.push(
					`bench: app=${app} latency=${row.latencyMs}ms refs=${String(row.refCount)} named=${String(row.namedCount)} complete=${String(row.complete)} verdict=POOR TREE: interactive elements missing names or tree incomplete — do not paper over; act only on named refs`,
				);
			} else {
				lines.push(
					`bench: app=${app} latency=${row.latencyMs}ms refs=${String(row.refCount)} named=${String(row.namedCount)} complete=${String(row.complete)} verdict=ok`,
				);
			}
		}
	}

	const ok = statusOk && versionOk && permOk && benchOk && versionExit === 0;
	return {
		ok,
		exitCode: ok ? 0 : 1,
		lines,
		binary: bin,
		binSource: source,
		version: version ?? undefined,
		versionOk,
		statusOk,
		bench: benchRows,
	};
}
