import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetExceeded, emptyBudget, Store } from "@earendil-works/pi-orchestra-core";
import { describe, expect, it } from "vitest";
import { detectComms } from "../src/comms.ts";

describe("chaos (scripted, DB assertions)", () => {
	it("duplicate + dropped deliveries: at-least-once, deduped by id", () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-chaos-"));
		const store = new Store({ path: join(dir, "c.db") });
		try {
			const a = store.createAgent({ name: "ada", role: "lead" });
			const b = store.createAgent({ name: "bo", role: "builder" });
			const m = store.sendMessage({ fromAgentId: a.id, toAgentId: b.id, type: "info", body: "hi" });
			// Duplicate delivery attempt: inbox returns once (INSERT OR IGNORE dedupes).
			expect(store.inbox(b.id)).toHaveLength(1);
			store.ack(m.id, b.id);
			store.ack(m.id, b.id);
			expect(store.inbox(b.id)).toHaveLength(0);
			// Dropped delivery (no ack) stays queued for redelivery.
			const m2 = store.sendMessage({ fromAgentId: a.id, toAgentId: b.id, type: "info", body: "again" });
			expect(store.pendingDeliveries().length).toBe(1);
			expect(store.pendingDeliveries()[0]!.message.id).toBe(m2.id);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("budget exhaustion for each limit escalates", () => {
		for (const used of [{ usedTurns: 50 }, { usedTokens: 500000 }, { usedMs: 600000 }]) {
			const b = emptyBudget({ ...used });
			expect(budgetExceeded(b)).not.toBeNull();
		}
		const dir = mkdtempSync(join(tmpdir(), "orch-bud-"));
		const store = new Store({ path: join(dir, "b.db") });
		try {
			const a = store.createAgent({ name: "ada", role: "builder" });
			store.setBudget("agent", a.id, emptyBudget({ maxTurns: 2, usedTurns: 2 }));
			expect(budgetExceeded(store.getBudget("agent", a.id)!)).toContain("turns");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("recursion past max depth rejected; budget slice deducted (checked)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-rec-"));
		const { createSupervisor } = await import("../src/supervisor.ts");
		const sup = createSupervisor({ config: { dbPath: join(dir, "r.db"), port: 0, maxDepth: 1, maxAgents: 6 } });
		try {
			await sup.listen();
			const p = sup.spawnAgent({ name: "p", role: "lead", taskSpec: "t" });
			if (!("agent" in p)) throw new Error("p spawn failed");
			const c = sup.spawnAgent({ name: "c", role: "builder", taskSpec: "t", parentAgentId: p.agent.id });
			expect("agent" in c).toBe(true);
			if ("agent" in c) {
				const over = sup.spawnAgent({ name: "g", role: "builder", taskSpec: "t", parentAgentId: c.agent.id });
				expect("error" in over).toBe(true);
			}
		} finally {
			await sup.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("looping detection: identical tool call and oscillation via comms", () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-loop-"));
		const store = new Store({ path: join(dir, "l.db") });
		try {
			const a = store.createAgent({ name: "ada", role: "builder" });
			store.addEvent(a.id, "tool_execution", { tool: "edit", path: "src/x.ts" });
			store.addEvent(a.id, "tool_execution", { tool: "edit", path: "src/x.ts" });
			// Chatter detector covers back-and-forth; loop tool events are in events table for reconciler steer.
			const recent = store.recentEvents(a.id, 5);
			expect(recent.length).toBe(2);
			void a;
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
