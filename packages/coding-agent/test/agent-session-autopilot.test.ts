import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { AUTOPILOT_NUDGE_TEXT } from "../src/core/autopilot.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("AgentSession autopilot", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-autopilot-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(options?: { replies: string[]; autopilot?: boolean }) {
		const replies = options?.replies ?? [];
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const index = Math.min(callCount, replies.length - 1);
				callCount++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage(replies[index] ?? "Success");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		if (options?.autopilot === false) settingsManager.applyOverrides({ autopilot: false });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		return { session, getCallCount: () => callCount };
	}

	it("continues after a stalled announcement with a nudge", async () => {
		const created = await createSession({
			replies: ["I'll start by exploring the repo structure and making the changes.", "Success."],
		});

		await created.session.prompt("Ship it");

		expect(created.getCallCount()).toBe(2);
		const texts = created.session.messages.map((message) =>
			message.role === "user" && Array.isArray(message.content)
				? message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n")
				: "",
		);
		expect(texts).toContain(AUTOPILOT_NUDGE_TEXT);
	});

	it("gives up after the consecutive-nudge bound", async () => {
		const created = await createSession({ replies: ["I'll start by exploring the repo structure."] });

		await created.session.prompt("Ship it");

		// One initial request plus AUTOPILOT_MAX_CONSECUTIVE_NUDGES nudges,
		// then the run stops instead of looping forever.
		expect(created.getCallCount()).toBe(4);
		expect(created.session.isStreaming).toBe(false);
	});

	it("does not continue when autopilot is disabled", async () => {
		const created = await createSession({
			replies: ["I'll start by exploring the repo structure.", "Success."],
			autopilot: false,
		});

		await created.session.prompt("Ship it");

		expect(created.getCallCount()).toBe(1);
	});

	it("does not continue after completed work", async () => {
		const created = await createSession({ replies: ["All done. Everything is complete.", "Success."] });

		await created.session.prompt("Ship it");

		expect(created.getCallCount()).toBe(1);
	});
});
