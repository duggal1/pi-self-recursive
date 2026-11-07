import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@earendil-works/pi-orchestra-core";
import { describe, expect, it } from "vitest";
import { freshReviewerGaps, integrateInOrder } from "../src/integrator.ts";

describe("integrator + fresh reviewer", () => {
	it("merges in dependency order; conflict creates merge task", () => {
		const dir = mkdtempSync(join(tmpdir(), "orch-int-"));
		const repo = join(dir, "repo");
		mkdirSync(repo, { recursive: true });
		execFileSync("git", ["init", "-b", "main"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
		writeFileSync(join(repo, "a.txt"), "base\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
		execFileSync("git", ["branch", "integration"], { cwd: repo });
		// Branches: agent-A (a.txt), agent-B (b.txt), agent-C (c.txt with conflict)
		for (const [branch, file, content] of [
			["agent-A", "a.txt", "A\n"],
			["agent-B", "b.txt", "B\n"],
			["agent-C", "a.txt", "C\n"],
		] as const) {
			execFileSync("git", ["checkout", "-b", branch, "main"], { cwd: repo });
			writeFileSync(join(repo, file), content);
			execFileSync("git", ["add", "."], { cwd: repo });
			execFileSync("git", ["commit", "-m", branch], { cwd: repo });
			execFileSync("git", ["checkout", "main"], { cwd: repo });
		}
		const storeDir = join(dir, "db");
		mkdirSync(storeDir, { recursive: true });
		const store = new Store({ path: join(storeDir, "s.db") });
		try {
			const tA = store.createTask({ id: "A", title: "A", spec: "a", ownsGlobs: [] });
			const tB = store.createTask({ id: "B", title: "B", spec: "b", ownsGlobs: [] });
			const tC = store.createTask({ id: "C", title: "C", spec: "c", ownsGlobs: [] });
			store.addDep("B", "A");
			store.setTaskState("A", "done");
			store.setTaskState("B", "done");
			store.setTaskState("C", "done");
			const order = integrateInOrder(store, repo, ["A", "B", "C"], {
				branchOf: { A: "agent-A", B: "agent-B", C: "agent-C" },
				integration: "integration",
			});
			expect(order).toEqual(["A", "B", "C"]);
			// C conflicts with A on a.txt → merge task created, not auto-resolved.
			const mergeTasks = store.listTasks().filter((t) => t.title.includes("merge"));
			expect(mergeTasks.length).toBeGreaterThan(0);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("fresh reviewer gaps become targeted tasks (no transcript)", () => {
		const storeDir = mkdtempSync(join(tmpdir(), "orch-rev-"));
		const store = new Store({ path: join(storeDir, "r.db") });
		try {
			const gaps = freshReviewerGaps(
				"Build /items page",
				"diff touches auth",
				"checks passed but spec missing price cents",
			);
			expect(gaps.length).toBeGreaterThan(0);
			expect(gaps[0]!.detail).toContain("price cents");
		} finally {
			store.close();
			rmSync(storeDir, { recursive: true, force: true });
		}
	});
});
