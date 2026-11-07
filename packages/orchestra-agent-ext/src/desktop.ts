// Desktop control (Part C): shells out to the pinned `agent-desktop` CLI (external,
// pinned release, Apache-2.0 — never vendored, no Rust in this repo). Minimal verbs:
// snapshot, act, verify (re-snapshot), screenshot. The tool is capability-gated OFF
// by default: the task must declare `desktop` via env config and an apps allowlist
// (see getDesktopConfig). Payloads (snapshot trees, screenshots) are written to a
// run-scoped directory with 0600 perms, referenced by sha256 hash; tool results and
// event metadata carry counts/hashes only — never payloads.
// App leases are file leases on resource `app:<name>` (non-blocking, same semantics
// as orchestra-core Store leases: TTL 30s, conflict => fail fast, no wait). The
// supervisor has no /app-lease or /event endpoint today, and this extension may not
// edit orchestra-core / orchestra-supervisor, so leases are a client-side file
// contract (cross-process, process-local metadata) and desktop event rows are
// deferred. See DEVIATIONS.md D19-D20 for the honest limitation.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DESKTOP_PINNED_VERSION = "1.0.2";
export const DESKTOP_BIN_ENV = "AGENT_DESKTOP_BIN";
export const DESKTOP_CAPABILITIES_ENV = "ORCHESTRA_DESKTOP_CAPABILITIES";
export const DESKTOP_ALLOWED_APPS_ENV = "ORCHESTRA_DESKTOP_ALLOWED_APPS";
export const DESKTOP_ARTIFACTS_ENV = "ORCHESTRA_DESKTOP_ARTIFACTS_DIR";
export const DESKTOP_LEASES_ENV = "ORCHESTRA_DESKTOP_LEASES_DIR";
export const DESKTOP_TTL_ENV = "ORCHESTRA_DESKTOP_ARTIFACT_TTL_MS";
export const DEFAULT_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
export const APP_LEASE_TTL_MS = 30_000;

export type DesktopVerb = "snapshot" | "act" | "verify" | "screenshot";

export type DesktopAction =
	| "click"
	| "double-click"
	| "right-click"
	| "type"
	| "set-value"
	| "clear"
	| "focus"
	| "press"
	| "scroll"
	| "scroll-to"
	| "expand"
	| "collapse"
	| "check"
	| "uncheck"
	| "toggle"
	| "select";

export interface DesktopError {
	code: string;
	message: string;
	suggestion?: string;
	recovery?: {
		strategy: string;
		retryable: boolean;
		requires_fresh_snapshot?: boolean;
		retry_after_ms?: number;
	};
	platform_detail?: string;
	details?: unknown;
	disposition: { delivery: string; retry: string };
}

export interface DesktopEnvelope {
	version: string;
	ok: boolean;
	command: string;
	data?: Record<string, unknown>;
	error?: DesktopError;
}

export interface DesktopConfig {
	bin: string;
	binSource: string;
	/** Declared capabilities, e.g. ["desktop"]. Empty => disabled. */
	capabilities: string[];
	/** App allowlist; empty => no app may be driven. */
	allowedApps: string[];
	artifactsDir: string;
	leasesDir: string;
	ttlMs: number;
	enabled: boolean;
}

export interface DesktopExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type DesktopExec = (bin: string, args: string[], opts?: { timeoutMs?: number }) => Promise<DesktopExecResult>;

export interface DesktopVerbParams {
	verb: DesktopVerb;
	app?: string;
	ref?: string;
	action?: DesktopAction;
	text?: string;
	value?: string;
	windowId?: string;
	timeoutMs?: number;
}

export interface DesktopEventMetadata {
	command: string;
	app: string | null;
	ok: boolean;
	errorCode: string | null;
	refCount: number | null;
}

export interface ArtifactRef {
	path: string;
	hash: string;
	bytes: number;
}

type EnvRecord = Record<string, string | undefined>;

function csv(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

export function getDesktopConfig(env: EnvRecord = process.env as EnvRecord): DesktopConfig {
	const capabilities = csv(env[DESKTOP_CAPABILITIES_ENV] ?? env.ORCHESTRA_CAPABILITIES);
	const allowedApps = csv(env[DESKTOP_ALLOWED_APPS_ENV]);
	const binOverride = env[DESKTOP_BIN_ENV];
	const bin = binOverride && binOverride.length > 0 ? binOverride : "agent-desktop";
	const ttlRaw = env[DESKTOP_TTL_ENV];
	const parsedTtl = ttlRaw !== undefined ? Number(ttlRaw) : Number.NaN;
	const ttlMs = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_ARTIFACT_TTL_MS;
	return {
		bin,
		binSource: binOverride && binOverride.length > 0 ? DESKTOP_BIN_ENV : "PATH",
		capabilities,
		allowedApps,
		artifactsDir:
			env[DESKTOP_ARTIFACTS_ENV] && (env[DESKTOP_ARTIFACTS_ENV] as string).length > 0
				? (env[DESKTOP_ARTIFACTS_ENV] as string)
				: join(process.cwd(), ".orchestra", "desktop-artifacts"),
		leasesDir:
			env[DESKTOP_LEASES_ENV] && (env[DESKTOP_LEASES_ENV] as string).length > 0
				? (env[DESKTOP_LEASES_ENV] as string)
				: join(process.cwd(), ".orchestra", "desktop-leases"),
		ttlMs,
		enabled: capabilities.includes("desktop"),
	};
}

export function isDesktopCapable(config: DesktopConfig): boolean {
	return config.enabled;
}

/** Capability + allowlist gate. Returns an error string when blocked, else null. */
export function checkDesktopAccess(app: string | undefined, config: DesktopConfig): string | null {
	if (!config.enabled) {
		return `desktop capability not declared (set ${DESKTOP_CAPABILITIES_ENV} to include desktop; no shell-out performed)`;
	}
	if (app !== undefined && app.length > 0) {
		if (config.allowedApps.length === 0) {
			return `no apps allowlisted (set ${DESKTOP_ALLOWED_APPS_ENV}); app ${app} refused`;
		}
		if (!config.allowedApps.includes(app)) {
			return `app ${app} not in ${DESKTOP_ALLOWED_APPS_ENV} [${config.allowedApps.join(",")}]`;
		}
	}
	return null;
}

export function bashInvokesAgentDesktop(command: string): boolean {
	return /\bagent-desktop\b/.test(command);
}

export function parseEnvelope(stdout: string): DesktopEnvelope | null {
	const text = stdout.trim();
	if (!text) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	if (typeof record.version !== "string" || typeof record.ok !== "boolean" || typeof record.command !== "string") {
		return null;
	}
	return parsed as DesktopEnvelope;
}

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	"snapshot",
	"status",
	"version",
	"get",
	"is",
	"find",
	"screenshot",
	"permissions",
	"list-windows",
	"list-apps",
	"list-displays",
	"list-surfaces",
]);

/**
 * Retry disposition: only `disposition.retry === "safe"` may retry, at most once,
 * and only for read-only commands. Ref actions (click/type/...) are never retried
 * on live errors — a stale ref needs a fresh snapshot, not the same argv again.
 */
export function isSafeRetry(envelope: DesktopEnvelope): boolean {
	if (envelope.ok) return false;
	if (envelope.error?.disposition.retry !== "safe") return false;
	return READ_ONLY_COMMANDS.has(envelope.command);
}

export function extractEventMetadata(envelope: DesktopEnvelope): DesktopEventMetadata {
	const data = envelope.data ?? {};
	const app = typeof data.app === "string" ? data.app : null;
	const refCount = typeof data.ref_count === "number" ? data.ref_count : null;
	return {
		command: envelope.command,
		app,
		ok: envelope.ok,
		errorCode: envelope.error ? envelope.error.code : null,
		refCount,
	};
}

export function sha256Hex(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function ensureDir0700(dir: string): Promise<void> {
	await mkdir(dir, { mode: 0o700, recursive: true });
}

/** Write payload to run-scoped dir (0600); filename is `<sha256>.<ext>`. */
export async function saveArtifact(dir: string, bytes: Buffer, ext: string): Promise<ArtifactRef> {
	await ensureDir0700(dir);
	const hash = sha256Hex(bytes);
	const path = join(dir, `${hash}.${ext}`);
	await writeFile(path, bytes, { mode: 0o600 });
	return { path, hash, bytes: bytes.length };
}

/** TTL sweep: delete files older than ttlMs. Returns removed paths. */
export async function cleanupExpiredArtifacts(dir: string, ttlMs: number, now: number = Date.now()): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of entries) {
		const path = join(dir, name);
		try {
			const info = await stat(path);
			if (info.isFile() && now - info.mtimeMs > ttlMs) {
				await rm(path, { force: true });
				removed.push(path);
			}
		} catch {
			// Skip entries that vanish mid-sweep.
		}
	}
	return removed;
}

// --- file leases on `app:<name>` (non-blocking) ---

export interface AppLease {
	resource: string;
	agentId: string;
	taskId: string | null;
	expiresAt: number;
}

function leaseFilename(app: string): string {
	return `${sha256Hex(`app:${app}`).slice(0, 16)}.lease.json`;
}

async function readLease(dir: string, app: string): Promise<AppLease | null> {
	const path = join(dir, leaseFilename(app));
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<AppLease>;
		if (typeof parsed.agentId !== "string" || typeof parsed.expiresAt !== "number") return null;
		return {
			resource: parsed.resource ?? `app:${app}`,
			agentId: parsed.agentId,
			taskId: parsed.taskId ?? null,
			expiresAt: parsed.expiresAt,
		};
	} catch {
		return null;
	}
}

async function removeLeaseFile(dir: string, app: string): Promise<void> {
	await rm(join(dir, leaseFilename(app)), { force: true });
}

/**
 * Acquire `app:<name>` exclusively without blocking. Same semantics as
 * orchestra-core Store.acquireLease: held by another live agent => { ok:false };
 * expired lease => reclaim. Uses O_EXCL so concurrent processes cannot both win.
 */
export async function acquireAppLease(
	leasesDir: string,
	app: string,
	agentId: string,
	taskId: string | null,
	now: number = Date.now(),
	ttlMs: number = APP_LEASE_TTL_MS,
): Promise<{ ok: true } | { ok: false; owner: string; expiresAt: number }> {
	await ensureDir0700(leasesDir);
	const path = join(leasesDir, leaseFilename(app));
	const payload = JSON.stringify({ resource: `app:${app}`, agentId, taskId, expiresAt: now + ttlMs });
	try {
		await writeFile(path, payload, { mode: 0o600, flag: "wx" });
		return { ok: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const existing = await readLease(leasesDir, app);
	if (existing && existing.expiresAt > now) {
		return { ok: false, owner: existing.agentId, expiresAt: existing.expiresAt };
	}
	// Expired (or unreadable): reclaim once.
	await removeLeaseFile(leasesDir, app);
	try {
		await writeFile(path, payload, { mode: 0o600, flag: "wx" });
		return { ok: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const current = await readLease(leasesDir, app);
		if (current) return { ok: false, owner: current.agentId, expiresAt: current.expiresAt };
		return { ok: false, owner: "unknown", expiresAt: now + ttlMs };
	}
}

export async function releaseAppLease(leasesDir: string, app: string, agentId: string): Promise<void> {
	const existing = await readLease(leasesDir, app);
	if (existing && existing.agentId !== agentId) return;
	await removeLeaseFile(leasesDir, app);
}

export async function leaseHolder(leasesDir: string, app: string, now: number = Date.now()): Promise<AppLease | null> {
	const existing = await readLease(leasesDir, app);
	if (!existing) return null;
	if (existing.expiresAt <= now) {
		await removeLeaseFile(leasesDir, app);
		return null;
	}
	return existing;
}

// --- CLI execution with retry ---

function defaultDesktopExec(bin: string, args: string[], opts?: { timeoutMs?: number }): Promise<DesktopExecResult> {
	return new Promise((resolve) => {
		execFile(
			bin,
			args,
			{ timeout: opts?.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
					resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: 127 });
					return;
				}
				if (error) {
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

export interface DesktopRunResult {
	envelope: DesktopEnvelope | null;
	exitCode: number;
	attempts: number;
	rawStdout: string;
}

export async function runDesktopCommand(
	bin: string,
	argv: string[],
	exec: DesktopExec = defaultDesktopExec,
): Promise<DesktopRunResult> {
	let result = await exec(bin, argv, { timeoutMs: 30_000 });
	let envelope = parseEnvelope(result.stdout);
	if (envelope && !envelope.ok && isSafeRetry(envelope)) {
		const waitMs = Math.min(envelope.error?.recovery?.retry_after_ms ?? 0, 1000);
		if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
		result = await exec(bin, argv, { timeoutMs: 30_000 });
		envelope = parseEnvelope(result.stdout);
		return { envelope, exitCode: result.exitCode, attempts: 2, rawStdout: result.stdout };
	}
	return { envelope, exitCode: result.exitCode, attempts: 1, rawStdout: result.stdout };
}

// --- shotd resizer reuse (shotd stays the web-pages tool) ---

/**
 * Reuse shotd's per-model model-view resizer; never duplicate resize math here.
 * If shotd is not built/installed, returns the original buffer unchanged.
 */
export async function reuseShotdResize(png: Buffer, format: string, width: number, height: number): Promise<Buffer> {
	try {
		const mod = (await import("@earendil-works/pi-shotd/image")) as {
			resizeForModel?: (
				buf: Buffer,
				format: string,
				opts?: Record<string, unknown>,
				w?: number,
				h?: number,
			) => Promise<Buffer>;
		};
		if (typeof mod.resizeForModel !== "function") return png;
		return await mod.resizeForModel(png, format, {}, width, height);
	} catch {
		return png;
	}
}

// --- verb argv ---

export function snapshotArgv(
	app: string | undefined,
	windowId: string | undefined,
	timeoutMs: number | undefined,
): string[] {
	const argv = ["snapshot"];
	if (app) argv.push("--app", app);
	if (windowId) argv.push("--window-id", windowId);
	if (timeoutMs !== undefined) argv.push("--timeout-ms", String(Math.trunc(timeoutMs)));
	argv.push("-i", "--compact");
	return argv;
}

export function screenshotArgv(app: string | undefined, windowId: string | undefined): string[] {
	const argv = ["screenshot"];
	if (app) argv.push("--app", app);
	if (windowId) argv.push("--window-id", windowId);
	return argv;
}

export function actArgv(params: DesktopVerbParams): string[] {
	const ref = params.ref ?? "";
	switch (params.action) {
		case "click":
		case "double-click":
		case "right-click":
		case "clear":
		case "focus":
		case "check":
		case "uncheck":
		case "toggle":
		case "expand":
		case "collapse":
		case "scroll-to": {
			const argv = [params.action as string, ref];
			if (params.timeoutMs !== undefined) argv.push("--timeout-ms", String(Math.trunc(params.timeoutMs)));
			return argv;
		}
		case "type": {
			const argv = ["type", ref, params.text ?? ""];
			if (params.timeoutMs !== undefined) argv.push("--timeout-ms", String(Math.trunc(params.timeoutMs)));
			return argv;
		}
		case "set-value": {
			const argv = ["set-value", ref, params.value ?? ""];
			if (params.timeoutMs !== undefined) argv.push("--timeout-ms", String(Math.trunc(params.timeoutMs)));
			return argv;
		}
		case "press": {
			const argv = ["press", params.text ?? ""];
			if (params.timeoutMs !== undefined) argv.push("--timeout-ms", String(Math.trunc(params.timeoutMs)));
			return argv;
		}
		case "select": {
			const argv = ["select", ref, params.text ?? params.value ?? ""];
			if (params.timeoutMs !== undefined) argv.push("--timeout-ms", String(Math.trunc(params.timeoutMs)));
			return argv;
		}
		case "scroll": {
			return ["scroll", ref, "--direction", "down", "--amount", "3"];
		}
		default:
			return [params.action ?? "click", ref];
	}
}

export interface DesktopVerbResult {
	text: string;
	details: Record<string, unknown>;
	isError: boolean;
}

function errorResult(text: string, details: Record<string, unknown>): DesktopVerbResult {
	return { text, details: { ...details, error: true }, isError: true };
}

function describeEnvelopeError(envelope: DesktopEnvelope): string {
	const error = envelope.error;
	if (!error) return `${envelope.command} failed`;
	// Never echo error.details (may carry desktop payloads).
	return `${envelope.command} error ${error.code}: ${error.message} (retry=${error.disposition.retry})`;
}

export interface ExecuteDesktopOptions {
	config?: DesktopConfig;
	exec?: DesktopExec;
	agentId?: string;
	taskId?: string | null;
	now?: number;
}

/**
 * Execute one desktop verb. Returns metadata-only results: counts and artifact
 * hashes. Snapshot trees and screenshot bytes go to the run-scoped dir (0600);
 * neither the text nor details may carry payloads. Ref actions are never retried
 * (see isSafeRetry); failures tell the caller to take a fresh snapshot.
 */
export async function executeDesktopVerb(
	params: DesktopVerbParams,
	opts: ExecuteDesktopOptions = {},
): Promise<DesktopVerbResult> {
	const config = opts.config ?? getDesktopConfig();
	const exec = opts.exec ?? defaultDesktopExec;
	const agentId = opts.agentId ?? process.env.ORCHESTRA_AGENT_ID ?? "unknown";
	const taskId = opts.taskId ?? null;
	const now = opts.now ?? Date.now();

	const verb = params.verb;
	if (verb === "snapshot" || verb === "verify" || verb === "screenshot") {
		if (!params.app || params.app.length === 0) {
			return errorResult("desktop: app is required for snapshot/verify/screenshot", { verb });
		}
	}
	if (verb === "act") {
		if (!params.ref || params.ref.length === 0) {
			return errorResult("desktop: ref is required for act", { verb });
		}
		if (!params.action) return errorResult("desktop: action is required for act", { verb });
	}

	if (verb === "snapshot" || verb === "verify" || verb === "screenshot") {
		const gate = checkDesktopAccess(params.app, config);
		if (gate) return errorResult(`desktop: ${gate}`, { verb, app: params.app ?? null });
	} else {
		const gate = checkDesktopAccess(undefined, config);
		if (gate) return errorResult(`desktop: ${gate}`, { verb });
	}

	// Opportunistic TTL cleanup (artifacts only; leases expire on acquire).
	await cleanupExpiredArtifacts(config.artifactsDir, config.ttlMs, now).catch(() => undefined);

	const needsLease = verb !== "act" && params.app !== undefined && params.app.length > 0;
	const leaseApp = params.app ?? "";
	if (needsLease) {
		const acquired = await acquireAppLease(config.leasesDir, leaseApp, agentId, taskId, now).catch((error) => {
			void error;
			return { ok: false as const, owner: "lease-error", expiresAt: now };
		});
		if (!acquired.ok) {
			return errorResult(
				`desktop: app:${leaseApp} lease held by ${acquired.owner} (non-blocking, retry after expiry)`,
				{ verb, app: leaseApp, lease: `app:${leaseApp}`, owner: acquired.owner },
			);
		}
	}

	try {
		if (verb === "snapshot" || verb === "verify") {
			const started = Date.now();
			const run = await runDesktopCommand(
				config.bin,
				snapshotArgv(params.app, params.windowId, params.timeoutMs),
				exec,
			);
			const latencyMs = Date.now() - started;
			if (!run.envelope) {
				return errorResult(`desktop: snapshot non-JSON output (exit ${run.exitCode})`, {
					verb,
					app: params.app ?? null,
					latencyMs,
				});
			}
			const envelope = run.envelope;
			if (!envelope.ok) {
				return errorResult(describeEnvelopeError(envelope), {
					...extractEventMetadata(envelope),
					verb,
					latencyMs,
				});
			}
			const data = envelope.data ?? {};
			const refCount = typeof data.ref_count === "number" ? data.ref_count : null;
			const complete = data.complete === true;
			const snapshotId = typeof data.snapshot_id === "string" ? data.snapshot_id : null;
			const payload = Buffer.from(JSON.stringify(data));
			const artifact = await saveArtifact(config.artifactsDir, payload, "snapshot.json");
			const poor = !complete || refCount === 0 || refCount === null;
			const text =
				`snapshot ${params.app} snapshot_id=${snapshotId ?? "?"} refs=${String(refCount)} complete=${complete} ` +
				`latency=${latencyMs}ms treeSha=${artifact.hash} path=${artifact.path}` +
				(poor ? " POOR TREE: incomplete or empty — do not paper over; act only on named refs" : "");
			return {
				text,
				details: {
					...extractEventMetadata(envelope),
					verb,
					latencyMs,
					treeSha: artifact.hash,
					path: artifact.path,
					complete,
					attempts: run.attempts,
				},
				isError: false,
			};
		}

		if (verb === "screenshot") {
			const run = await runDesktopCommand(config.bin, screenshotArgv(params.app, params.windowId), exec);
			if (!run.envelope) {
				return errorResult(`desktop: screenshot non-JSON output (exit ${run.exitCode})`, {
					verb,
					app: params.app ?? null,
				});
			}
			const envelope = run.envelope;
			if (!envelope.ok) {
				return errorResult(describeEnvelopeError(envelope), {
					...extractEventMetadata(envelope),
					verb,
				});
			}
			const data = envelope.data ?? {};
			const encoded = typeof data.data === "string" ? data.data : null;
			const width = typeof data.width === "number" ? data.width : 0;
			const height = typeof data.height === "number" ? data.height : 0;
			const format = typeof data.format === "string" ? data.format : "png";
			if (!encoded) {
				return errorResult("desktop: screenshot envelope has no image data", { verb, app: params.app ?? null });
			}
			const png = Buffer.from(encoded, "base64");
			const raw = await saveArtifact(config.artifactsDir, png, `${format}.img`);
			const modelView = await reuseShotdResize(png, format, width, height);
			const view = await saveArtifact(config.artifactsDir, modelView, "model-view.webp");
			const text =
				`screenshot ${params.app} ${width}x${height} format=${format} ` +
				`rawSha=${raw.hash} modelViewSha=${view.hash} modelViewPath=${view.path}`;
			return {
				text,
				details: {
					...extractEventMetadata(envelope),
					verb,
					rawSha: raw.hash,
					modelViewSha: view.hash,
					modelViewPath: view.path,
					width,
					height,
					format,
					attempts: run.attempts,
				},
				isError: false,
			};
		}

		// act
		const run = await runDesktopCommand(config.bin, actArgv(params), exec);
		if (!run.envelope) {
			return errorResult(`desktop: act non-JSON output (exit ${run.exitCode})`, { verb, action: params.action });
		}
		const envelope = run.envelope;
		if (!envelope.ok) {
			const base = describeEnvelopeError(envelope);
			const stale = envelope.error?.code === "STALE_REF" || envelope.error?.code === "AMBIGUOUS_TARGET";
			return errorResult(stale ? `${base}; take a fresh snapshot and use new refs` : base, {
				...extractEventMetadata(envelope),
				verb,
				action: params.action,
				ref: params.ref ?? null,
			});
		}
		const disposition = (envelope.data?.disposition ?? {}) as Record<string, unknown>;
		const delivery = typeof disposition.delivery === "string" ? disposition.delivery : null;
		return {
			text: `act ${params.action} ${params.ref ?? ""} delivered=${delivery ?? "?"} command=${envelope.command}`,
			details: {
				...extractEventMetadata(envelope),
				verb,
				action: params.action,
				ref: params.ref ?? null,
				delivery,
			},
			isError: false,
		};
	} finally {
		if (needsLease) {
			await releaseAppLease(config.leasesDir, leaseApp, agentId).catch(() => undefined);
		}
	}
}
