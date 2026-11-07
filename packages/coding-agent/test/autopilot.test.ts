import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { shouldAutopilotContinue } from "../src/core/autopilot.ts";

function assistantMessage(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "opencode",
		model: "crouton-alpha-free",
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

const toolResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call_1",
	toolName: "read",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: Date.now(),
};

describe("shouldAutopilotContinue", () => {
	describe("announcements that stopped without doing the work", () => {
		test.each([
			"I'll start by exploring the repo structure to locate the startup UI, theme, thinking-level, and screenshot code paths before making changes.",
			"I'll continue investigating the startup header, thinking-level default bug, theme handling, screenshot format, and supervisor references to implement the minimal UI changes.",
			"Let me check the settings configuration and fix the thinking level.",
			"Shall I edit the files now?",
			"Would you like me to refactor this module?",
			"Now I'll run the tests.",
			"First, I'll hide the startup context.",
		])("nudges: %s", (text) => {
			expect(shouldAutopilotContinue(assistantMessage(text), [])).toBe(true);
		});
	});

	describe("completed or plain answers", () => {
		test.each([
			"All done. Everything is complete.",
			"Here's a summary of the changes I made.",
			"Let me know if you need anything else.",
			"The thinking level lives in packages/coding-agent/src/core/defaults.ts.",
			"Nothing further to report.",
			"",
		])("does not nudge: %s", (text) => {
			expect(shouldAutopilotContinue(assistantMessage(text), [])).toBe(false);
		});
	});

	describe("guard conditions", () => {
		test("does not nudge when the turn stopped abnormally", () => {
			const message = assistantMessage("I'll start now.", { stopReason: "length" });
			expect(shouldAutopilotContinue(message, [])).toBe(false);
		});

		test("does not nudge when the turn ran tool calls", () => {
			const message = assistantMessage("I'll start now.");
			expect(shouldAutopilotContinue(message, [toolResult])).toBe(false);
		});

		test("does not nudge when the message carries a tool call", () => {
			const message = assistantMessage("I'll start now.", {
				content: [
					{ type: "text", text: "I'll start now." },
					{ type: "toolCall", id: "call_1", name: "read", arguments: {} },
				],
			});
			expect(shouldAutopilotContinue(message, [])).toBe(false);
		});

		test("does not nudge a long answer that merely contains I'll", () => {
			const text = Array.from({ length: 200 }, () => "Detailed findings about the codebase.").join(" ");
			expect(text.length).toBeGreaterThan(1500);
			expect(shouldAutopilotContinue(assistantMessage(`${text} I'll do more later.`), [])).toBe(false);
		});
	});
});
