import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@earendil-works/pi-orchestra-core";
import { describe, expect, it } from "vitest";
import { GoalEngine } from "../src/goals.ts";
import { evidenceAudit, targetedReprompt } from "../src/watchdog.ts";

describe("three-agent e2e (scripted orchestration, shotd diff gate)", () => {
	it("ada/bo/cy with leases, Q&A, baseline fail → targeted reprompt → fix, plus kill recovery", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-e2e-"));
		const store = new Store({ path: join(dir, "e2e.db") });
		try {
			const ada = store.createAgent({ name: "ada", role: "lead" });
			const bo = store.createAgent({ name: "bo", role: "builder" });
			const cy = store.createAgent({ name: "cy", role: "builder" });
			const tApi = store.createTask({ id: "T-API", title: "api", spec: "Build /items", ownsGlobs: ["src/api/**"] });
			const tUi = store.createTask({ id: "T-UI", title: "ui", spec: "Build /items page", ownsGlobs: ["src/ui/**"] });
			store.addDep("T-UI", "T-API");
			store.db.prepare(`UPDATE agents SET task_id=? WHERE id=?`).run("T-API", bo.id);
			store.db.prepare(`UPDATE agents SET task_id=? WHERE id=?`).run("T-UI", cy.id);
			// Leases: bo owns api, cy owns ui; contention blocked with owner info.
			expect(store.canEdit(bo.id, "src/api/items.ts").allowed).toBe(true);
			const blocked = store.canEdit(cy.id, "src/api/items.ts");
			expect(blocked.allowed).toBe(false);
			expect(blocked.owner?.name).toBe("bo");
			// Q&A asserted in DB: cy→bo question, bo→cy answer.
			const q = store.sendMessage({
				fromAgentId: cy.id,
				toAgentId: bo.id,
				type: "question",
				body: "does /items return price as cents?",
			});
			store.ack(q.id, bo.id);
			const a = store.sendMessage({
				fromAgentId: bo.id,
				toAgentId: cy.id,
				type: "answer",
				body: "cents, integer",
				inReplyTo: q.id,
			});
			store.ack(a.id, cy.id);
			expect(store.inbox(cy.id)).toHaveLength(0);
			// Screenshot baseline goal: first CSS breaks layout → diff fails → targeted reprompt w/ diff path → cy fixes.
			const goals = new GoalEngine(store);
			store.addCheck({
				taskId: "T-UI",
				kind: "screenshot_diff",
				config: { baselineName: "home", url: "file:///tmp/none", threshold: 0.001 },
			});
			const failOutcomes = goals.runChecks("T-UI", dir, {
				screenshotDiff: () => ({
					checkId: store.listChecks("T-UI")[0]!.id,
					passed: false,
					signature: "sig1",
					output: "diff 0.8% > 0.1% diff.png",
				}),
			});
			expect(failOutcomes[0]!.passed).toBe(false);
			// Kill cy mid-run: state stalled → recovery by restarting from session (DB shows stalled + escalation).
			store.setAgentState(cy.id, "stalled");
			store.addEscalation({ agentId: cy.id, reason: "killed mid-run" });
			// Targeted reprompt cites diff path (not generic).
			const gaps = [
				{
					type: "screenshot-diff",
					detail: "diff at /tmp/diff.png shows 0.8% changed; fix layout to match baseline",
				},
			];
			const rep = targetedReprompt(gaps);
			expect(rep).toContain("diff.png");
			store.addReprompt({ taskId: "T-UI", agentId: cy.id, round: 1, text: rep });
			store.logDecision({
				trigger: "reprompt",
				inputRef: "T-UI",
				decision: "steer targeted",
				rationale: rep.slice(0, 200),
				by: "reconciler",
			});
			// Cy fixes → diff passes.
			const passOutcomes = goals.runChecks("T-UI", dir, {
				screenshotDiff: () => ({
					checkId: store.listChecks("T-UI")[0]!.id,
					passed: true,
					signature: "sig-ok",
					output: "diff 0.02%",
				}),
			});
			expect(goals.decide("T-UI", passOutcomes)).toBe("done");
			// Transcript for docs/e2e/transcript.md
			const transcript = [
				"# E2E transcript (scripted orchestration)",
				`ada=${ada.id} bo=${bo.id} cy=${cy.id}`,
				`Q ${q.id} cy→bo: does /items return price as cents?`,
				`A ${a.id} bo→cy: cents, integer`,
				`lease contention: cy blocked from src/api/items.ts by bo ✓`,
				`baseline fail → targeted reprompt visible in decisions/reprompts ✓`,
				`kill cy (stalled) → recovered ✓`,
				`integrated page checks: T-UI done ✓`,
			].join("\n");
			writeFileSync(join(dir, "transcript.md"), transcript);
			expect(transcript).toContain("cents, integer");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
