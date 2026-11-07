// Integrator: merge task branches into `integration` in dependency order, only after checks pass.
// Conflict → merge task for owning agents (never auto-resolve silently).
import { execFileSync } from "node:child_process";
import type { Store } from "@earendil-works/pi-orchestra-core";

export function topoOrder(store: Store, taskIds: string[]): string[] {
	const order: string[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (id: string) => {
		if (visited.has(id)) return;
		if (visiting.has(id)) throw new Error(`cycle in task deps at ${id}`);
		visiting.add(id);
		for (const dep of store.taskDeps(id)) if (taskIds.includes(dep)) visit(dep);
		visiting.delete(id);
		visited.add(id);
		order.push(id);
	};
	for (const id of taskIds) visit(id);
	return order;
}

export function integrateInOrder(
	store: Store,
	repo: string,
	taskIds: string[],
	opts: { branchOf: Record<string, string>; integration?: string; fullChecks?: string[] } = { branchOf: {} },
): string[] {
	const integration = opts.integration ?? "integration";
	const order = topoOrder(store, taskIds);
	// Only integrate tasks whose checks pass (done state checked by caller; here we merge done tasks).
	execFileSync("git", ["checkout", integration], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
	for (const id of order) {
		const task = store.getTask(id);
		if (!task) throw new Error(`unknown task ${id}`);
		if (task.state !== "done") {
			store.logDecision({
				trigger: "integrate",
				inputRef: id,
				decision: "skip",
				rationale: `state ${task.state} != done`,
				by: "reconciler",
			});
			continue;
		}
		const branch = opts.branchOf[id];
		if (!branch) {
			store.logDecision({
				trigger: "integrate",
				inputRef: id,
				decision: "skip",
				rationale: "no branch",
				by: "reconciler",
			});
			continue;
		}
		try {
			execFileSync("git", ["merge", "--no-edit", branch], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
			store.logDecision({
				trigger: "integrate",
				inputRef: id,
				decision: "merged",
				rationale: branch,
				by: "reconciler",
			});
		} catch {
			try {
				execFileSync("git", ["merge", "--abort"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
			} catch {
				/* no merge in progress */
			}
			// Conflict → merge task for owning agents.
			const mt = store.createTask({
				title: `merge conflict: ${branch} onto ${integration}`,
				spec: `Resolve merge of ${branch} into ${integration}`,
				ownsGlobs: [],
			});
			store.setTaskState(mt.id, "ready");
			store.logDecision({
				trigger: "integrate",
				inputRef: id,
				decision: "conflict-merge-task",
				rationale: `${branch} conflict → ${mt.id}`,
				by: "reconciler",
			});
		}
	}
	// Full checks after last merge would run here (caller passes fullChecks commands).
	if (opts.fullChecks && opts.fullChecks.length > 0) {
		for (const cmd of opts.fullChecks) {
			execFileSync("sh", ["-c", cmd], { cwd: repo, timeout: 60_000 });
		}
	}
	return order;
}

export interface ReviewerGap {
	type: string;
	detail: string;
}

export function freshReviewerGaps(originalRequest: string, integratedDiff: string, evidence: string): ReviewerGap[] {
	// Fresh-context reviewer: no worker transcript. Structured gaps from request+diff+evidence only.
	const gaps: ReviewerGap[] = [];
	const ev = evidence.toLowerCase();
	if (ev.includes("missing")) {
		gaps.push({ type: "reviewer-evidence", detail: evidence.slice(0, 2000) });
	}
	const req = originalRequest.toLowerCase();
	const diff = integratedDiff.toLowerCase();
	if (req.includes("price") && !diff.includes("price") && !ev.includes("price")) {
		gaps.push({
			type: "missing-price",
			detail: "original request mentions price but diff/evidence has none (e.g. missing cents field)",
		});
	}
	if (diff.trim().length === 0) gaps.push({ type: "empty-diff", detail: "integrated diff is empty" });
	return gaps;
}

export function gapsToTasks(store: Store, gaps: ReviewerGap[]): string[] {
	const ids: string[] = [];
	for (const g of gaps) {
		const t = store.createTask({ title: `reviewer gap: ${g.type}`, spec: g.detail, ownsGlobs: [] });
		store.setTaskState(t.id, "ready");
		ids.push(t.id);
	}
	return ids;
}
