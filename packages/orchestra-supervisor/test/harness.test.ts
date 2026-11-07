import { describe, expect, it } from "vitest";
import { createHarnessServer } from "../src/harness-server.ts";

describe("scenario harness (Plan A: OpenAI streaming)", () => {
	it("streams a tool call over /v1/chat/completions", async () => {
		const server = createHarnessServer({
			steps: [{ toolCalls: [{ name: "write", args: { path: "x.txt", content: "hi" } }] }, { text: "done" }],
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		try {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("no port");
			const base = `http://127.0.0.1:${addr.port}/v1`;
			// Turn 0: expect tool_calls chunks.
			const res0 = await fetch(`${base}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer test" },
				body: JSON.stringify({
					model: "harness-1",
					stream: true,
					messages: [{ role: "user", content: "hi" }],
					tools: [
						{
							type: "function",
							function: {
								name: "write",
								description: "write",
								parameters: { type: "object", properties: { path: { type: "string" } } },
							},
						},
					],
				}),
			});
			expect(res0.status).toBe(200);
			const text0 = await res0.text();
			expect(text0).toContain("tool_calls");
			expect(text0).toContain("write");
			expect(text0).toContain("[DONE]");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
