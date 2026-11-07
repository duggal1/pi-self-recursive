// Orchestra agent extension: identity injection, edit guard, messaging/spawn tools.
// Loaded with `pi --extension <dist/index.js>` at spawn time (never as a core edit).
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DesktopAction, DesktopConfig, DesktopVerb } from "./desktop.ts";
import { bashInvokesAgentDesktop, checkDesktopAccess, executeDesktopVerb, getDesktopConfig } from "./desktop.ts";
import { registerFauxProvider } from "./faux-provider.ts";

function env(key: string): string | undefined {
	const v = process.env[key];
	return v && v.length > 0 ? v : undefined;
}

function supervisorBase(): string | undefined {
	return env("ORCHESTRA_SUPERVISOR_URL") ?? "http://127.0.0.1:7788";
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
	const base = supervisorBase()!;
	const token = env("ORCHESTRA_TOKEN");
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token) headers["authorization"] = `Bearer ${token}`;
	const res = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`supervisor ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
	return (await res.json()) as T;
}

export default function (pi: ExtensionAPI): void {
	// Opt-in faux provider for RPC E2E (registered only when env set; import is tiny).
	if (env("ORCHESTRA_FAUX") === "1" || env("ORCHESTRA_FAUX_SCRIPT") !== undefined) {
		registerFauxProvider(pi as never);
	}
	const agentId = env("ORCHESTRA_AGENT_ID") ?? "unknown";
	const agentName = env("ORCHESTRA_AGENT_NAME") ?? "agent";
	const role = env("ORCHESTRA_AGENT_ROLE") ?? "builder";

	// Identity + rules: injected once at start; roster refreshed by messages.
	pi.on("before_agent_start", async (event) => {
		const { sections } = event.systemPromptOptions;
		sections["orchestra_identity"] = [
			`You are ${agentName} (agent ${agentId}), role ${role}.`,
			"Rules: one writer per file (lease enforced by code, not prompt); never revert others' commits; delivery is at-least-once — dedupe by message id; 'done' means checks pass, not your claim.",
			"Tools: send_message/read_inbox/reply for coordination; spawn only via supervisor (budget/depth enforced); shot/dom tools for UI verification.",
		].join("\n");
		return undefined;
	});

	// Edit guard: block edits to files leased by another agent. Reads always allowed.
	// Desktop guard (Part C): block `desktop` tool calls and `bash` invocations of
	// `agent-desktop` when the desktop capability is not declared. The tool itself
	// returns an error when the apps allowlist fails; this guard is fail-closed.
	pi.on("tool_call", async (event) => {
		if (
			event.toolName === "read" ||
			event.toolName === "grep" ||
			event.toolName === "find" ||
			event.toolName === "ls"
		)
			return undefined;
		if (event.toolName === "desktop" || event.toolName === "bash") {
			const config: DesktopConfig = getDesktopConfig();
			if (event.toolName === "desktop") {
				const gate = checkDesktopAccess(undefined, config);
				if (gate) return { block: true, reason: `Blocked: ${gate}.` };
				return undefined;
			}
			const input = event.input as Record<string, unknown>;
			const command = typeof input.command === "string" ? input.command : "";
			if (bashInvokesAgentDesktop(command) && !config.enabled) {
				return {
					block: true,
					reason: `Blocked: bash invokes agent-desktop without desktop capability (set ORCHESTRA_DESKTOP_CAPABILITIES to include desktop).`,
				};
			}
			// Enabled or no desktop invocation: fall through to the file-lease guard.
		}
		if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return undefined;
		const input = event.input as Record<string, unknown>;
		const filePath = (input.path ?? input.file_path ?? input.filePath ?? "") as string;
		if (!filePath) return undefined; // bash without path → let bash guard handle below
		try {
			const verdict = await postJson<{ allowed: boolean; reason: string; ownerName?: string; ownerTask?: string }>(
				"/can-edit",
				{ agentId, filePath },
			);
			if (!verdict.allowed) {
				const who = verdict.ownerName
					? ` Owned by ${verdict.ownerName}${verdict.ownerTask ? ` (task ${verdict.ownerTask})` : ""}.`
					: "";
				return { block: true, reason: `Blocked: ${verdict.reason}. ${who} Message them with send_message.` };
			}
		} catch (e) {
			// Supervisor unreachable → allow (fail-open) to avoid deadlocks; lease is retried next call.
			// Production should fail-closed; logged as info via notify when UI exists.
		}
		return undefined;
	});

	const sendParams = Type.Object({
		toAgentId: Type.Optional(Type.String()),
		toRole: Type.Optional(Type.String()),
		broadcast: Type.Optional(Type.Boolean()),
		threadId: Type.Optional(Type.String()),
		inReplyTo: Type.Optional(Type.String()),
		type: Type.Union([
			Type.Literal("handoff"),
			Type.Literal("blocked"),
			Type.Literal("question"),
			Type.Literal("answer"),
			Type.Literal("info"),
			Type.Literal("done"),
		]),
		body: Type.String(),
	});
	const sendTool: ToolDefinition = {
		name: "send_message",
		label: "Message",
		description:
			"Send a typed, durable message to a teammate, a role, or broadcast. Delivery is at-least-once (dedupe by id). No wait — use read_inbox/reply.",
		parameters: sendParams as never,
		async execute(_id, params) {
			const p = params as {
				toAgentId?: string;
				toRole?: string;
				broadcast?: boolean;
				threadId?: string;
				inReplyTo?: string;
				type: "handoff" | "blocked" | "question" | "answer" | "info" | "done";
				body: string;
			};
			const res = await postJson<{ message: { id: string } }>("/message", { fromAgentId: agentId, ...p });
			return { content: [{ type: "text", text: `sent ${res.message.id}` }], details: res.message };
		},
	};
	const inboxTool: ToolDefinition = {
		name: "read_inbox",
		label: "Inbox",
		description: "Read unread messages (marks delivered). Call after send_message / on each turn boundary.",
		parameters: Type.Object({}) as never,
		async execute() {
			const res = await postJson<{ items: { message: { id: string; type: string; body: string } }[] }>("/inbox", {
				agentId,
			});
			const text =
				res.items.map((it) => `[${it.message.type}] ${it.message.id}: ${it.message.body}`).join("\n") || "(empty)";
			return { content: [{ type: "text", text }], details: res.items };
		},
	};
	const replyTool: ToolDefinition = {
		name: "reply",
		label: "Reply",
		description: "Reply to a message (marks acked). Provide the message id from read_inbox.",
		parameters: Type.Object({ messageId: Type.String(), type: Type.String(), body: Type.String() }) as never,
		async execute(_id, params) {
			const p = params as { messageId: string; type: string; body: string };
			const sent = await postJson<{ message: { id: string } }>("/message", {
				fromAgentId: agentId,
				type: p.type,
				body: p.body,
				inReplyTo: p.messageId,
			});
			await postJson("/ack", { messageId: p.messageId, agentId });
			return { content: [{ type: "text", text: `replied ${sent.message.id}` }], details: sent.message };
		},
	};
	const spawnTool: ToolDefinition = {
		name: "spawn",
		label: "Spawn",
		description: "Ask supervisor to spawn a teammate (depth, concurrency, budget slice enforced by harness).",
		parameters: Type.Object({
			name: Type.String(),
			role: Type.String(),
			taskSpec: Type.String(),
			ownsGlobs: Type.Optional(Type.Array(Type.String())),
		}) as never,
		async execute(_id, params) {
			const p = params as { name: string; role: string; taskSpec: string; ownsGlobs?: string[] };
			const res = await postJson<{ agentId: string; name: string }>("/spawn", { parentAgentId: agentId, ...p });
			return { content: [{ type: "text", text: `spawned ${res.name} (${res.agentId})` }], details: res };
		},
	};

	const desktopTool: ToolDefinition = {
		name: "desktop",
		label: "Desktop",
		description:
			"Operate desktop apps via pinned agent-desktop (minimal verbs: snapshot/act/verify/screenshot). " +
			"Capability-gated OFF by default: needs ORCHESTRA_DESKTOP_CAPABILITIES to include desktop and ORCHESTRA_DESKTOP_ALLOWED_APPS (comma-separated). " +
			"Results are metadata + sha256 artifact hashes only; trees/screenshots stay in 0600 run-scoped files. " +
			"Refs come from snapshot; act once, then re-snapshot (verify) to check. Ref actions never auto-retry. " +
			"Requires macOS Accessibility (and Screen Recording for screenshots) — see orchestra doctor.",
		parameters: Type.Object({
			verb: Type.Union([
				Type.Literal("snapshot"),
				Type.Literal("act"),
				Type.Literal("verify"),
				Type.Literal("screenshot"),
			]),
			app: Type.Optional(Type.String()),
			ref: Type.Optional(Type.String()),
			action: Type.Optional(
				Type.Union([
					Type.Literal("click"),
					Type.Literal("double-click"),
					Type.Literal("right-click"),
					Type.Literal("type"),
					Type.Literal("set-value"),
					Type.Literal("clear"),
					Type.Literal("focus"),
					Type.Literal("press"),
					Type.Literal("scroll"),
					Type.Literal("scroll-to"),
					Type.Literal("expand"),
					Type.Literal("collapse"),
					Type.Literal("check"),
					Type.Literal("uncheck"),
					Type.Literal("toggle"),
					Type.Literal("select"),
				]),
			),
			text: Type.Optional(Type.String()),
			value: Type.Optional(Type.String()),
			windowId: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number()),
		}) as never,
		async execute(_id, params) {
			const p = params as {
				verb: DesktopVerb;
				app?: string;
				ref?: string;
				action?: DesktopAction;
				text?: string;
				value?: string;
				windowId?: string;
				timeoutMs?: number;
			};
			const result = await executeDesktopVerb(p, { agentId, taskId: null });
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
				isError: result.isError,
			};
		},
	};

	pi.registerTool(sendTool);
	pi.registerTool(inboxTool);
	pi.registerTool(replyTool);
	pi.registerTool(spawnTool);
	pi.registerTool(desktopTool);
}
