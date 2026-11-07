/**
 * The opencode bridge must never hard-error on an unavailable tool name
 * (e.g. "shell" from another harness): the turn recovers with a correction
 * so the model re-emits the call under a Pi tool name.
 */
import { describe, expect, test } from "vitest";
import { recoveryCorrection, type TurnLog } from "../src/extensions/opencode-cli/stream.ts";
import { decideTurn } from "../src/extensions/opencode-cli/stream.ts";

const ALLOWED = new Set(["read", "bash", "edit", "write"]);

function log(overrides: Partial<TurnLog> = {}): TurnLog {
	return {
		text: "",
		thinking: "",
		stderr: "",
		sessionId: undefined,
		opencodeToolUse: undefined,
		nativeToolRequests: [],
		nativeTextMark: 0,
		stepNativeCalls: [],
		nativeCalls: undefined,
		opencodeError: undefined,
		finishReason: "stop",
		...overrides,
	};
}

describe("decideTurn", () => {
	test("unavailable marker tool is recoverable, not a hard error", () => {
		const decision = decideTurn({
			log: log({ text: '<pi_tool_call>{"name":"shell","arguments":{"command":"ls"}}</pi_tool_call>' }),
			allowedToolNames: ALLOWED,
			allowRecovery: true,
		});
		expect(decision.kind).toBe("recoverable");
		if (decision.kind === "recoverable") {
			expect(decision.error.message).toContain('"shell"');
			expect(decision.error.message).toContain('"bash"');
			expect(decision.toolCallFailure?.rejection.reason).toBe("unavailable_tool");
		}
	});

	test("available marker tool succeeds", () => {
		const decision = decideTurn({
			log: log({ text: '<pi_tool_call>{"name":"bash","arguments":{"command":"ls"}}</pi_tool_call>' }),
			allowedToolNames: ALLOWED,
			allowRecovery: true,
		});
		expect(decision.kind).toBe("success");
		if (decision.kind === "success") {
			expect(decision.toolCalls.map((call) => call.name)).toEqual(["bash"]);
		}
	});

	test("unavailable marker in reasoning is recoverable too", () => {
		const decision = decideTurn({
			log: log({ text: "", thinking: '<pi_tool_call>{"name":"shell","arguments":{"command":"ls"}}</pi_tool_call>' }),
			allowedToolNames: ALLOWED,
			allowRecovery: true,
		});
		expect(decision.kind).toBe("recoverable");
	});

	test("XML-style tool use is recoverable", () => {
		const decision = decideTurn({
			log: log({ text: "<bash>ls -la</bash>" }),
			allowedToolNames: ALLOWED,
			allowRecovery: true,
		});
		expect(decision.kind).toBe("recoverable");
	});

	test("malformed markers stay a hard error", () => {
		const decision = decideTurn({
			log: log({ text: "<pi_tool_call>{not json</pi_tool_call>" }),
			allowedToolNames: ALLOWED,
			allowRecovery: true,
		});
		expect(decision.kind).toBe("error");
	});
});

describe("recoveryCorrection", () => {
	test("names the missing tool and the available ones", () => {
		const toolCallFailure = {
			rejection: { reason: "unavailable_tool" as const, toolName: "shell" },
		};
		const correction = recoveryCorrection({
			toolCallFailure: toolCallFailure as never,
			error: new Error("OpenCode requested unavailable Pi tool \"shell\"."),
			opencodeToolUse: undefined,
			nativeToolRequests: [],
			context: { tools: [{ name: "bash" }] } as never,
		});
		expect(correction).toContain("does not exist");
		expect(correction).toContain('"shell"');
		expect(correction).toContain("Available Pi tools: bash");
	});
});
