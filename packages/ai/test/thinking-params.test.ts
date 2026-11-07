/**
 * F2: per-level provider params contract.
 *
 * Each adapter is asked for a thinking level and the exact outgoing params
 * are captured via onPayload (the request body, no network, no model):
 * level-expressing providers must send the mapped effort verbatim, budget
 * providers must send a budget with room for the answer, and nothing may
 * invent a level the model's map does not name.
 */
import { describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as streamCompletions } from "../src/api/openai-completions.ts";
import { streamSimple as streamResponses } from "../src/api/openai-responses.ts";
import {
	adjustMaxTokensForThinking,
	MIN_ANSWER_TOKENS,
	thinkingBudgetForLevel,
} from "../src/api/simple-options.ts";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels, normalizeContext } from "../src/compat.ts";
import type { Model, TranscriptContext } from "../src/types.ts";

function context(): TranscriptContext {
	return normalizeContext({
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	});
}

/** Call streamSimple with an onPayload that records the request body and stops the request. */
async function payloadFor(
	streamFn: (model: Model<any>, ctx: TranscriptContext, options: any) => { result: () => Promise<unknown> },
	model: Model<any>,
	reasoning: string,
): Promise<Record<string, any>> {
	let payload: Record<string, any> | undefined;
	const stream = streamFn(model, context(), {
		apiKey: "test-key",
		reasoning,
		onPayload: (request: unknown) => {
			payload = request as Record<string, any>;
			throw new Error("payload captured");
		},
	});
	await stream.result().catch(() => undefined);
	if (!payload) throw new Error("payload was not captured");
	return payload;
}

function completionsModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "fixture-completions",
		name: "Fixture Completions",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 64000,
		thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		...overrides,
	} as Model<"openai-completions">;
}

function anthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "fixture-anthropic",
		name: "Fixture Anthropic",
		api: "anthropic-messages",
		provider: "test",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		...overrides,
	} as Model<"anthropic-messages">;
}

describe("F2 provider thinking params", () => {
	describe("openai-responses: native effort when the map names it", () => {
		it("uses the map's max for ultra (crouton-alpha-free)", async () => {
			const model = getModel("opencode", "crouton-alpha-free")!;
			const payload = await payloadFor(streamResponses as never, model, "ultra");
			expect(payload.reasoning).toMatchObject({ effort: "max" });
		});

		it("passes high through verbatim", async () => {
			const model = getModel("opencode", "crouton-alpha-free")!;
			const payload = await payloadFor(streamResponses as never, model, "high");
			expect(payload.reasoning).toMatchObject({ effort: "high" });
		});

		it("clamps ultra to the highest mapped level, never invents one", async () => {
			const model: Model<"openai-responses"> = {
				id: "fixture-responses",
				name: "Fixture Responses",
				api: "openai-responses",
				provider: "test",
				baseUrl: "https://example.com/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 64000,
				thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high" },
			};
			const payload = await payloadFor(streamResponses as never, model, "ultra");
			expect(payload.reasoning).toMatchObject({ effort: "high" });
		});
	});

	describe("openai-completions: reasoning_effort only when the map names it", () => {
		it("sends the mapped max for a max-capable model", async () => {
			const payload = await payloadFor(streamCompletions as never, completionsModel(), "max");
			expect(payload.reasoning_effort).toBe("max");
		});

		it("standard levels send verbatim without a map; higher levels are never faked", async () => {
			const noMap = completionsModel({ thinkingLevelMap: undefined });
			await expect(payloadFor(streamCompletions as never, noMap, "high")).resolves.toMatchObject({
				reasoning_effort: "high",
			});
			// max and ultra require a map entry; the wire only ever sees high.
			await expect(payloadFor(streamCompletions as never, noMap, "max")).resolves.toMatchObject({
				reasoning_effort: "high",
			});
			await expect(payloadFor(streamCompletions as never, noMap, "ultra")).resolves.toMatchObject({
				reasoning_effort: "high",
			});
		});
	});

	describe("anthropic-messages: budget control with answer room", () => {
		it("sends budget_tokens for the requested level", async () => {
			const payload = await payloadFor(streamAnthropic as never, anthropicModel(), "high");
			expect(payload.thinking).toMatchObject({ type: "enabled", budget_tokens: thinkingBudgetForLevel("high") });
		});

		it("keeps at least MIN_ANSWER_TOKENS of answer room over the budget", async () => {
			const payload = await payloadFor(streamAnthropic as never, anthropicModel(), "ultra");
			const budget = (payload.thinking as { budget_tokens: number }).budget_tokens;
			expect(payload.max_tokens - budget).toBeGreaterThanOrEqual(MIN_ANSWER_TOKENS);
		});
	});

	describe("clamp: never above the model's highest mapped level", () => {
		it.each(["opencode/crouton-alpha-free", "anthropic/claude-haiku-4-5", "openai/gpt-5.6-sol"] as const)(
			"clamp(%s) is always a supported level",
			(ref) => {
				const [provider, id] = ref.split("/") as [string, string];
				const model = getModel(provider as never, id as never);
				if (!model?.reasoning) return;
				expect(getSupportedThinkingLevels(model).includes(clampThinkingLevel(model, "ultra"))).toBe(true);
			},
		);

		it("ultra requires an explicit map entry", () => {
			expect(getSupportedThinkingLevels(completionsModel())).not.toContain("ultra");
		});
	});

	describe("budget invariant: max_tokens exceeds the budget with room for the answer", () => {
		it.each([["minimal"], ["low"], ["medium"], ["high"], ["ultra"]] as const)(
			"adjustMaxTokensForThinking keeps the invariant at %s",
			(level) => {
				for (const ceiling of [4096, 64000, 270000]) {
					const { maxTokens, thinkingBudget } = adjustMaxTokensForThinking(undefined, ceiling, level);
					if (thinkingBudget === 0) {
						expect(maxTokens).toBeGreaterThanOrEqual(0);
					} else {
						expect(maxTokens - thinkingBudget).toBeGreaterThanOrEqual(MIN_ANSWER_TOKENS);
					}
					expect(thinkingBudget).toBeLessThanOrEqual(Math.max(0, ceiling - MIN_ANSWER_TOKENS));
					expect(maxTokens).toBeLessThanOrEqual(ceiling);
				}
			},
		);

		it("ultra budget is the largest Pi allocates (64k)", () => {
			expect(thinkingBudgetForLevel("ultra")).toBe(65536);
			expect(thinkingBudgetForLevel("high")).toBe(16384);
		});
	});
});
