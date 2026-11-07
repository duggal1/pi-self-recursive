// Thinking levels: fixed or dynamic rubric. Live change via RPC set_thinking_level (no restart needed).
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Task phase for the F4 dynamic policy. */
export type TaskPhase = "planning" | "architecture" | "ambiguous-debug" | "implementation" | "verifying" | "trivial";

/**
 * F4 dynamic policy: which level each phase gets. A hypothesis to measure
 * (F5 experiment), configurable; defaults below are the initial guess.
 * Trivial work never gets ultra by default.
 */
export interface ThinkingPolicy {
	planning: ThinkingLevel;
	architecture: ThinkingLevel;
	ambiguousDebug: ThinkingLevel;
	implementation: ThinkingLevel;
	verifying: ThinkingLevel;
	trivial: ThinkingLevel;
}

export const DEFAULT_THINKING_POLICY: ThinkingPolicy = {
	planning: "max",
	architecture: "max",
	ambiguousDebug: "max",
	implementation: "high",
	verifying: "medium",
	trivial: "low",
};

/** Level for a phase under a policy. Never ultra for trivial work, even if misconfigured. */
export function policyForPhase(phase: TaskPhase, policy: ThinkingPolicy = DEFAULT_THINKING_POLICY): ThinkingLevel {
	const level =
		phase === "planning"
			? policy.planning
			: phase === "architecture"
				? policy.architecture
				: phase === "ambiguous-debug"
					? policy.ambiguousDebug
					: phase === "implementation"
						? policy.implementation
						: phase === "verifying"
							? policy.verifying
							: policy.trivial;
	if (phase === "trivial" && level === "ultra") return "max";
	return level;
}

export interface ThinkingInput {
	spec: string;
	ownsGlobs: string[];
	checks: { kind: string }[];
	ambiguous?: boolean;
	novel?: boolean;
	phase?: TaskPhase;
}

export function assignThinking(
	input: ThinkingInput,
	policy: ThinkingPolicy = DEFAULT_THINKING_POLICY,
): { level: ThinkingLevel; reason: string } {
	if (input.phase) {
		return { level: policyForPhase(input.phase, policy), reason: `policy phase=${input.phase}` };
	}
	const spec = input.spec.toLowerCase();
	const risky =
		spec.includes("auth") ||
		spec.includes("security") ||
		spec.includes("delete") ||
		spec.includes("migrate") ||
		spec.includes("invoice") ||
		spec.includes("payment");
	const hardWords = ["race", "deadlock", "consensus", "algorithm", "crypto", "migrate", "refactor", "rewrite", "arch"];
	const isHard = risky || hardWords.some((w) => spec.includes(w)) || input.ambiguous === true || input.novel === true;
	const files = input.ownsGlobs.length;
	const checks = input.checks.length;
	if (isHard && (files >= 3 || checks >= 2)) {
		return { level: "max", reason: `hard/risky spec, files=${files} checks=${checks}` };
	}
	if (isHard) {
		return { level: "high", reason: `hard spec, files=${files} checks=${checks}` };
	}
	if (files <= 1 && checks <= 1 && spec.length < 80) {
		return { level: "low", reason: `trivial: files=${files} checks=${checks} spec_len=${spec.length}` };
	}
	return { level: "medium", reason: `standard: files=${files} checks=${checks} spec_len=${spec.length}` };
}

export function raiseThinking(current: ThinkingLevel): ThinkingLevel {
	const idx = THINKING_LEVELS.indexOf(current);
	const next = THINKING_LEVELS[Math.min(THINKING_LEVELS.length - 1, idx + 1)]!;
	return next;
}
