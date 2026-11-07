/**
 * F8 scripted tests: flip-flop detection/reaction, prompt contract + protocol,
 * decisive-mode gating. No real model, no API key (SCRIPTED-LLM).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@earendil-works/pi-orchestra-core";
import { describe, expect, it } from "vitest";
import {
	checkFlipsForTask,
	countCheckFlips,
	detectFlipFlop,
	runFlipFlopCheck,
	type FlipFlopSignals,
} from "../src/flipflop.ts";
import { composeAgentPrompt, decisiveEnabled } from "../src/planner.ts";

function freshStore(): { store: Store; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "orch-flipflop-"));
	const store = new Store({ path: join(dir, "or.db") });
	return { store, dir };
}

const quiet: FlipFlopSignals = {
	hunkReverts: 0,
	planRewrites: 0,
	checkFlipsWithoutChange: 0,
	stalledThinkingTurns: 0,
};

describe("detectFlipFlop", () => {
	it("triggers on seeded oscillation", () => {
		expect(detectFlipFlop({ ...quiet, hunkReverts: 2 }).kind).toBe("hunk-revert");
		expect(detectFlipFlop({ ...quiet, planRewrites: 4 }).kind).toBe("plan-rewrite");
		expect(detectFlipFlop({ ...quiet, checkFlipsWithoutChange: 2 }).kind).toBe("check-flip");
		expect(detectFlipFlop({ ...quiet, stalledThinkingTurns: 3 }).kind).toBe("thinking-stall");
	});

	it("does not trigger on normal iteration", () => {
		expect(detectFlipFlop(quiet).triggered).toBe(false);
		expect(detectFlipFlop({ ...quiet, hunkReverts: 1, planRewrites: 3, checkFlipsWithoutChange: 1 }).triggered).toBe(false);
		expect(detectFlipFlop({ ...quiet, stalledThinkingTurns: 2 }).triggered).toBe(false);
	});

	it("counts pass/fail alternations", () => {
		expect(countCheckFlips([])).toBe(0);
		expect(countCheckFlips([{ passed: true }, { passed: true }])).toBe(0);
		expect(countCheckFlips([{ passed: true }, { passed: false }, { passed: true }])).toBe(2);
	});
});

describe("runFlipFlopCheck", () => {
	it("steers once quoting the decision log, then escalates on repeat", async () => {
		const { store, dir } = freshStore();
		const steered: string[] = [];
		try {
			const t = store.createTask({ title: "t", spec: "s", ownsGlobs: [] });
			store.addDecisionLogEntry({
				taskId: t.id,
				decision: "use budget tokens",
				rationale: "adapter takes no effort param",
				by: "agent",
			});
			const busy = { ...quiet, checkFlipsWithoutChange: 3 };

			const first = await runFlipFlopCheck(store, t.id, busy, { steer: (text) => steered.push(text) });
			expect(first).toEqual({ fired: true, escalated: false });
			expect(steered).toHaveLength(1);
			expect(steered[0]).toContain("use budget tokens"); // quotes the decision log
			expect(steered[0]).toContain("citable evidence");
			expect(store.listReprompts(t.id)).toHaveLength(1);

			const second = await runFlipFlopCheck(store, t.id, busy, { steer: (text) => steered.push(text) });
			expect(second).toEqual({ fired: true, escalated: true });
			expect(store.listEscalations().some((e) => e.reason.includes("flip-flop"))).toBe(true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never steers without a trigger", async () => {
		const { store, dir } = freshStore();
		const steered: string[] = [];
		try {
			const t = store.createTask({ title: "t", spec: "s", ownsGlobs: [] });
			const result = await runFlipFlopCheck(store, t.id, quiet, { steer: (text) => steered.push(text) });
			expect(result).toEqual({ fired: false, escalated: false });
			expect(steered).toHaveLength(0);
			expect(store.listReprompts(t.id)).toHaveLength(0);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts check flips from store history", () => {
		const { store, dir } = freshStore();
		try {
			const t = store.createTask({ title: "t", spec: "s", ownsGlobs: [] });
			const check = store.addCheck({ taskId: t.id, kind: "cmd", config: { command: "sh" } });
			for (const passed of [true, false, true, false, true]) {
				store.addCheckRun({ checkId: check.id, attempt: 1, passed, signature: passed ? "ok" : "boom" });
			}
			// newest-first: T,F,T,F,T → 4 flips (same as chronological count).
			expect(checkFlipsForTask(store, t.id)).toBe(4);
			expect(checkFlipsForTask(store, "missing")).toBe(0);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("supervisor prompt contract (F3/F6)", () => {
	it("contains the decisive protocol and the autonomy contract at high thinking", () => {
		const p = composeAgentPrompt({
			goal: "G",
			agentName: "ada",
			taskTitle: "T",
			taskSpec: "S",
			ownsGlobs: [],
			checks: [],
			teammates: [],
			thinkingLevel: "high",
		});
		expect(p).toContain("Decisive-mode protocol");
		expect(p).toContain("citable evidence");
		expect(p).toContain("Staff-engineer autonomy contract");
		expect(p).toContain("PROOF.md");
		expect(p).toContain("Reversible by default");
	});

	it("omits the protocol below high but keeps the contract", () => {
		const p = composeAgentPrompt({
			goal: "G",
			agentName: "ada",
			taskTitle: "T",
			taskSpec: "S",
			ownsGlobs: [],
			checks: [],
			teammates: [],
			thinkingLevel: "low",
		});
		expect(p).not.toContain("Decisive-mode protocol");
		expect(p).toContain("Staff-engineer autonomy contract");
	});

	it("decisive defaults on for high and above, overridable", () => {
		expect(decisiveEnabled("high")).toBe(true);
		expect(decisiveEnabled("ultra")).toBe(true);
		expect(decisiveEnabled("medium")).toBe(false);
		expect(decisiveEnabled("medium", true)).toBe(true);
		expect(decisiveEnabled("high", false)).toBe(false);
	});
});
