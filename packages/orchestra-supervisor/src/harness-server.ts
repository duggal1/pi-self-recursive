// Scenario harness: scripted OpenAI-compatible HTTP server (Plan A).
// Streams tool calls (SSE) and reports usage. Per-turn steps keyed by call index.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface HarnessStep {
	text?: string;
	toolCalls?: { name: string; args: Record<string, unknown>; id?: string }[];
	usage?: { promptTokens: number; completionTokens: number };
	trigger?: string; // if set, only fire when last user message contains this substring
}

export interface HarnessOptions {
	steps: HarnessStep[];
	model?: string;
}

function sse(res: ServerResponse, obj: unknown): void {
	res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

export function createHarnessServer(opts: HarnessOptions): Server {
	const model = opts.model ?? "harness-1";
	let callIndex = 0;
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const url = req.url ?? "";
		if (!url.includes("/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		const chunks: Buffer[] = [];
		await new Promise<void>((resolve) => {
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => resolve());
		});
		let body: { messages?: { role: string; content?: unknown }[] } = {};
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
		} catch {
			body = {};
		}
		const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
		const lastUserText =
			typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
		// Find step for this call: by turn index, respecting trigger.
		let step: HarnessStep = opts.steps[Math.min(callIndex, opts.steps.length - 1)] ?? { text: "done" };
		// If trigger present, search forward for matching step (allows steer-triggered branching).
		for (const s of opts.steps) {
			if (s.trigger && lastUserText.includes(s.trigger)) {
				step = s;
				break;
			}
		}
		callIndex++;
		const usage = step.usage ?? { promptTokens: 42, completionTokens: 7 };
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const id = `chatcmpl-harness-${callIndex}`;
		const created = Math.floor(Date.now() / 1000);
		const emitChunk = (delta: Record<string, unknown>, finish: string | null) => {
			sse(res, {
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [{ index: 0, delta, finish_reason: finish }],
			});
		};
		emitChunk({ role: "assistant" }, null);
		if (step.toolCalls && step.toolCalls.length > 0) {
			step.toolCalls.forEach((tc, idx) => {
				const toolId = tc.id ?? `call_${callIndex}_${idx}`;
				emitChunk(
					{
						tool_calls: [
							{ index: idx, id: toolId, type: "function", function: { name: tc.name, arguments: "" } },
						],
					},
					null,
				);
				const argsStr = JSON.stringify(tc.args);
				// Stream args in two chunks (Pi parses incremental JSON).
				const mid = Math.ceil(argsStr.length / 2);
				emitChunk({ tool_calls: [{ index: idx, function: { arguments: argsStr.slice(0, mid) } }] }, null);
				emitChunk({ tool_calls: [{ index: idx, function: { arguments: argsStr.slice(mid) } }] }, null);
			});
			emitChunk({}, "tool_calls");
		} else {
			const text = step.text ?? "done";
			// Stream text in small deltas.
			for (let i = 0; i < text.length; i += 2) {
				emitChunk({ content: text.slice(i, i + 2) }, null);
			}
			emitChunk({}, "stop");
		}
		sse(res, {
			id,
			object: "chat.completion.chunk",
			created,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: null }],
			usage: {
				prompt_tokens: usage.promptTokens,
				completion_tokens: usage.completionTokens,
				total_tokens: usage.promptTokens + usage.completionTokens,
			},
		});
		res.write("data: [DONE]\n\n");
		res.end();
	});
	return server;
}
