/**
 * Autopilot continuation: the rule behind "never stop at an announcement".
 *
 * A turn that ends with text only ("I'll start by exploring…", "Shall I edit
 * that file?") and no tool calls has not done any of the work it describes.
 * The agent session asks {@link shouldAutopilotContinue} after each such
 * turn; on a match it continues once with a nudge user message, so the run
 * keeps executing instead of returning to the prompt. Bounded by
 * AUTOPILOT_MAX_CONSECUTIVE_NUDGES: after that many stalled turns in a row
 * the guard gives up, so a model that keeps announcing can never loop
 * forever.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";

/** Confirms a turn happened: it ran tools, so it is not a stalled announcement. */
export const AUTOPILOT_MAX_CONSECUTIVE_NUDGES = 3;

/** Nudge injected as the next user message after a stalled turn. */
export const AUTOPILOT_NUDGE_TEXT =
	"Continue the work without stopping to announce it. Do not ask for permission: execute the next step with tool calls now, and keep going until the task is fully complete.";

/**
 * Text that announces action instead of doing the work. Kept to action
 * announcements: opening phrases that begin an execution ("I'll start…",
 * "Let me build…"), not conversational scaffolding ("how can I help?",
 * "shall we chat?"), which must never trigger the nudge.
 */
const INTENT_RE =
	/\b(?:i'll (?:start|begin|continue|go|do|take|make|check|inspect|explore|fix|edit|run|implement|create|write|update|test|verify|hide|add|remove|delete|open|show|change)|i will (?:start|begin|continue|do|take|make|check|inspect|explore|fix|edit|run|implement|create|write|update|test|verify|hide|add|remove|delete|open|show|change)|let me (?:start|begin|continue|check|inspect|explore|fix|edit|run|implement|create|write|update|test|verify|hide|add|remove|delete|open|show|change|see)|now i'll|next i'll|first i'll|starting (?:with|by)|beginning (?:with|by)|shall i (?:start|begin|continue|go|do|edit|fix|run|check|hide|add|remove|delete|open|show|change)|should i (?:start|begin|continue|go|do|edit|fix|run|check|hide|add|remove|delete|open|show|change))\b/i;

/**
 * Strong completion signals: the turn reports finished work or hands control
 * back, so autopilot must not nudge it into continuing. Weak mentions of
 * "done" (e.g. "done with the header, now the footer") only exclude the
 * nudge when they arrive with these stronger phrases.
 */
const COMPLETION_RE =
	/\b(?:all done|everything (?:is )?(?:done|complete|finished)|the task is (?:done|complete)|here(?:'s| is) (?:a|the) (?:summary|result)|let me know (?:if|when|whether)|nothing (?:further|else) (?:to (?:do|add|report)|(?:needs|is needed))|nothing to (?:add|report))\b/i;

/** Announcements are short; a full answer that happens to contain "I'll" is not an announcement. */
const INTENT_MAX_LENGTH = 1500;

/**
 * Whether a turn ended without doing the work it announced, so autopilot
 * should continue it with a nudge. True only for a clean `stop` with no
 * tool calls, no tool results, and text that announces action or asks for
 * permission without reporting completed work.
 */
export function shouldAutopilotContinue(message: AssistantMessage, toolResults: readonly ToolResultMessage[]): boolean {
	if (message.stopReason !== "stop") return false;
	if (toolResults.length > 0) return false;
	if (message.content.some((block) => block.type === "toolCall")) return false;
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!text || text.length > INTENT_MAX_LENGTH) return false;
	if (!INTENT_RE.test(text)) return false;
	return !COMPLETION_RE.test(text);
}
