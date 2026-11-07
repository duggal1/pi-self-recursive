// Flip-flop detection (F3): observable behavior signals only, never raw thinking.
// A flip-flop is the same hunk edited then reverted, a plan rewritten repeatedly,
// check results flipping pass/fail with no code change, or high thinking-token use
// with no tool progress. The reaction steers ONCE quoting the decision log, then
// escalates on repeat.
import type { Store } from "@earendil-works/pi-orchestra-core";

export interface FlipFlopSignals {
	/** Count of hunk edit→revert pairs inside the window. */
	hunkReverts: number;
	/** Times the plan file was rewritten (full rewrites, not diffs). */
	planRewrites: number;
	/** Check outcome flips pass↔fail with no code change. */
	checkFlipsWithoutChange: number;
	/** Consecutive high-thinking turns with no tool progress. */
	stalledThinkingTurns: number;
}

export interface FlipFlopThresholds {
	hunkReverts: number;
	planRewrites: number;
	checkFlipsWithoutChange: number;
	stalledThinkingTurns: number;
}

export const DEFAULT_FLIP_FLOP_THRESHOLDS: FlipFlopThresholds = {
	hunkReverts: 2,
	planRewrites: 4,
	checkFlipsWithoutChange: 2,
	stalledThinkingTurns: 3,
};

export interface FlipFlopResult {
	triggered: boolean;
	kind?: string;
	detail: string;
}

/** Pure detector. Normal iteration (an edit that stays, a plan that evolves by diff) never triggers. */
export function detectFlipFlop(
	signals: FlipFlopSignals,
	thresholds: FlipFlopThresholds = DEFAULT_FLIP_FLOP_THRESHOLDS,
): FlipFlopResult {
	if (signals.hunkReverts >= thresholds.hunkReverts) {
		return { triggered: true, kind: "hunk-revert", detail: `${signals.hunkReverts} hunk edit→revert pairs` };
	}
	if (signals.planRewrites >= thresholds.planRewrites) {
		return { triggered: true, kind: "plan-rewrite", detail: `${signals.planRewrites} full plan rewrites` };
	}
	if (signals.checkFlipsWithoutChange >= thresholds.checkFlipsWithoutChange) {
		return { triggered: true, kind: "check-flip", detail: `${signals.checkFlipsWithoutChange} pass/fail flips with no code change` };
	}
	if (signals.stalledThinkingTurns >= thresholds.stalledThinkingTurns) {
		return { triggered: true, kind: "thinking-stall", detail: `${signals.stalledThinkingTurns} high-thinking turns with no tool progress` };
	}
	return { triggered: false, detail: "no oscillation detected" };
}

/** Count pass↔fail alternations in recent runs (newest first). */
export function countCheckFlips(runs: { passed: boolean }[]): number {
	let flips = 0;
	for (let i = 1; i < runs.length; i++) {
		if (runs[i]!.passed !== runs[i - 1]!.passed) flips++;
	}
	return flips;
}

export function buildFlipFlopSteer(store: Store, taskId: string, result: FlipFlopResult): string {
	const log = store.formatDecisionLog(taskId);
	return [
		`Flip-flop detected (${result.kind}): ${result.detail}.`,
		log ? `Decision log so far:\n${log}` : "No decisions logged yet.",
		"Reopen a decision only with new, citable evidence (a failing check, a tool output, a contradiction in the code).",
	].join("\n");
}

/**
 * Run the detector against the store and react: steer once (quoting the log),
 * escalate on repeat. Signals come from store records; hunk/plan signals the
 * supervisor cannot observe yet default to 0 (documented carry-over).
 */
export async function runFlipFlopCheck(
	store: Store,
	taskId: string,
	signals: FlipFlopSignals,
	opts: { steer: (text: string) => Promise<void> | void; thresholds?: FlipFlopThresholds },
): Promise<{ fired: boolean; escalated: boolean }> {
	const result = detectFlipFlop(signals, opts.thresholds);
	if (!result.triggered) return { fired: false, escalated: false };
	const steerText = buildFlipFlopSteer(store, taskId, result);
	await opts.steer(steerText);
	const priorFlipFlopReprompts = store.listReprompts(taskId).filter((r) => r.text.includes("Flip-flop detected"));
	const round = priorFlipFlopReprompts.length + 1;
	const task = store.getTask(taskId);
	store.addReprompt({ taskId, agentId: task?.ownerAgentId ?? "", round, text: steerText });
	if (priorFlipFlopReprompts.length >= 1) {
		// Repeat: escalate instead of a third steer.
		store.addEscalation({
			agentId: task?.ownerAgentId ?? null,
			reason: `flip-flop repeat (${result.kind}${result.detail ? `: ${result.detail}` : ""}) on task ${taskId}; already steered once`,
		});
		return { fired: true, escalated: true };
	}
	return { fired: true, escalated: false };
}

/**
 * Count check flips for a task from check_runs history (newest N runs per check).
 * This is the one flip-flop signal the store alone can observe today.
 */
export function checkFlipsForTask(store: Store, taskId: string, recentN = 10): number {
	const task = store.getTask(taskId);
	if (!task) return 0;
	const checks = store.listChecks(taskId);
	let flips = 0;
	for (const check of checks) {
		flips += countCheckFlips(store.lastRuns(check.id, recentN).map((r) => ({ passed: r.passed })));
	}
	return flips;
}
