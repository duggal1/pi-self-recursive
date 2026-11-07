# E2E transcript [SCRIPTED-LLM]
Scenario: ada (lead), bo (API), cy (UI) build /items page via harness + supervisor.

RPC harness proof [REAL]: real pi --mode rpc vs local OpenAI SSE server: prompt -> tool write -> done, agent_end/agent_settled, steer queued.
Shotd proof [REAL]: Chrome 156, 3840x2160 WebP native, hash stable cold 2187ms warm 1263ms.
Lease: bo owns src/api/**, cy blocked from src/api/items.ts by bo [asserted].
Q&A: cy->bo question "does /items return price as cents?" ; bo->cy answer "cents, integer" [asserted in DB, acked].
Screenshot goal: baseline_diff failed (0.8% > 0.1%) -> supervisor targeted reprompt citing diff path -> cy fixed -> diff passes -> task done [decisions row present].
Kill recovery: cy stalled mid-run -> escalation -> resumed (scripted, DB assertion).
Integrated checks: T-UI done.

See packages/orchestra-supervisor/test/e2e.test.ts for DB assertions.
