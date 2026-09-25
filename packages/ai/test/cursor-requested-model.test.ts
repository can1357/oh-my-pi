import { describe, expect, it } from "bun:test";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AgentRunRequest } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function cursorModel(id: string, overrides?: Partial<Model<"cursor-agent">>): Model<"cursor-agent"> {
	return {
		...buildModel({
			id,
			name: id,
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		}),
		...overrides,
	};
}

/** Effort routing of the collapsed `gpt-5.6-sol` family, as the bundled catalog ships it. */
const SOL_ROUTING = {
	off: "gpt-5.6-sol-none",
	[Effort.Low]: "gpt-5.6-sol-low",
	[Effort.Medium]: "gpt-5.6-sol-medium",
	[Effort.High]: "gpt-5.6-sol-high",
	[Effort.XHigh]: "gpt-5.6-sol-xhigh",
	[Effort.Max]: "gpt-5.6-sol-max",
};

/** Bundled shape of a collapsed Cursor family: one logical row, per-tier wire routing. */
function collapsedSol(overrides?: Partial<Model<"cursor-agent">>): Model<"cursor-agent"> {
	return cursorModel("gpt-5.6-sol", {
		requestModelId: "gpt-5.6-sol-none",
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			effortRouting: SOL_ROUTING,
		},
		...overrides,
	});
}

function capture(model: Model<"cursor-agent">, wireModelId?: string): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamCursor(model, { messages: [{ role: "user", content: "pong", timestamp: 0 }] } satisfies Context, {
		apiKey: "test-token",
		wireModelId,
		onPayload: payload => {
			if (payload && typeof payload === "object" && "$typeName" in payload) {
				resolve(payload as AgentRunRequest);
			} else {
				reject(new Error("Cursor payload was not an AgentRunRequest"));
			}
			throw new Error("stop after capturing Cursor payload");
		},
	});
	return promise;
}

describe("Cursor requestedModel wire shape", () => {
	it("splits a GPT reasoning-sibling slug into base id + reasoning parameter", async () => {
		const payload = await capture(cursorModel("gpt-5.4-mini-low"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.4-mini");
		expect(payload.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "reasoning", value: "low" })]);
		// modelDetails is still read server-side, so it must carry the base id too.
		expect(payload.modelDetails?.modelId).toBe("gpt-5.4-mini");
	});

	it("handles multi-segment GPT bases and the xhigh tier", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-xhigh"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "xhigh" }),
		]);
	});

	it("maps the extra-high sibling to the xhigh reasoning parameter", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-extra-high"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "xhigh" }),
		]);
	});

	it("derives max_mode per routed wire tier on a collapsed family", async () => {
		// The logical row's `cursorMaxMode` is an OR across the family members, so
		// a family with a max-mode `-xhigh`/`-max` tier says `true` for every
		// tier. Sending that on `-low` is the refused request of issue #9478.
		const model = collapsedSol({ cursorMaxMode: true });
		const off = await capture(model, "gpt-5.6-sol-none");
		const low = await capture(model, "gpt-5.6-sol-low");
		const xhigh = await capture(model, "gpt-5.6-sol-xhigh");
		const max = await capture(model, "gpt-5.6-sol-max");
		expect(off.requestedModel?.maxMode).toBe(false);
		expect(low.requestedModel?.maxMode).toBe(false);
		expect(xhigh.requestedModel?.maxMode).toBe(true);
		expect(max.requestedModel?.maxMode).toBe(true);
	});

	it("keeps the discovered max-mode marker on wire ids with no max tier suffix", async () => {
		// Cursor serves the whole Opus `-fast` lane in max mode, so discovery
		// marks `claude-opus-4-8-high-fast` — an id the tier-suffix rule reads as
		// a plain `high` tier. The marker is the authority; inferring from the
		// slug here sends `max_mode: false` on a max-mode-only wire id.
		const raw = await capture(cursorModel("claude-opus-4-8-high-fast", { cursorMaxMode: true }));
		expect(raw.requestedModel?.maxMode).toBe(true);
		expect(raw.modelDetails?.maxMode).toBe(true);

		// Same lane after the bare/thinking pair collapsed: no route carries a max
		// tier suffix, so the row-level marker still describes every route.
		const paired = await capture(
			cursorModel("claude-opus-4-8-high-fast", {
				cursorMaxMode: true,
				thinking: {
					mode: "effort",
					efforts: [Effort.Low, Effort.High],
					effortRouting: {
						off: "claude-opus-4-8-high-fast",
						[Effort.Low]: "claude-opus-4-8-thinking-high-fast",
						[Effort.High]: "claude-opus-4-8-thinking-high-fast",
					},
				},
			}),
			"claude-opus-4-8-thinking-high-fast",
		);
		expect(paired.requestedModel?.maxMode).toBe(true);

		// The reverse too: a `-max` reasoning tier upstream does not serve in max
		// mode keeps its `false` instead of being upgraded by the slug.
		const reasoningTier = await capture(cursorModel("claude-4.6-opus-max", { cursorMaxMode: false }));
		expect(reasoningTier.requestedModel?.maxMode).toBe(false);

		// A live roster resolves per wire id, so a mixed family keeps both answers.
		const mixed = collapsedSol({
			cursorMaxMode: true,
			cursorMaxModeRoutes: { "gpt-5.6-sol-high": true, "gpt-5.6-sol-low": false },
		});
		const high = await capture(mixed, "gpt-5.6-sol-high");
		const low = await capture(mixed, "gpt-5.6-sol-low");
		expect(high.requestedModel?.maxMode).toBe(true);
		expect(low.requestedModel?.maxMode).toBe(false);
	});

	it("honors an explicit false marker when a routed row puts its own id on the wire", async () => {
		// Bundled claude-opus-4-7-max is a bare/thinking pair: its own id is
		// still a wire id, unlike gpt-5.6-sol whose requestModelId names a sibling.
		const cached = cursorModel("claude-opus-4-7-max", {
			cursorMaxMode: false,
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				effortRouting: {
					off: "claude-opus-4-7-max",
					[Effort.Minimal]: "claude-opus-4-7-thinking-max",
					[Effort.Low]: "claude-opus-4-7-thinking-max",
					[Effort.Medium]: "claude-opus-4-7-thinking-max",
					[Effort.High]: "claude-opus-4-7-thinking-max",
				},
			},
		});
		const payload = await capture(cached);
		expect(payload.requestedModel?.modelId).toBe("claude-opus-4-7-max");
		expect(payload.modelDetails?.modelId).toBe("claude-opus-4-7-max");
		expect(payload.requestedModel?.maxMode).toBe(false);
		expect(payload.modelDetails?.maxMode ?? false).toBe(false);

		const thinkingPayload = await capture(cached, "claude-opus-4-7-thinking-max");
		expect(thinkingPayload.requestedModel?.maxMode).toBe(false);
	});

	it("falls back to the wire tier for a bundled row discovery never marked", async () => {
		// Bundled rows froze `cursorMaxMode` from the `-none` member and carry no
		// per-wire-id markers, so the wire suffix is the only per-tier signal.
		const bundled = collapsedSol({ cursorMaxMode: false });
		const low = await capture(bundled, "gpt-5.6-sol-low");
		const max = await capture(bundled, "gpt-5.6-sol-max");
		expect(low.requestedModel?.maxMode).toBe(false);
		expect(max.requestedModel?.maxMode).toBe(true);
		expect(max.modelDetails?.maxMode).toBe(true);
	});

	it("normalizes an off-tier sibling to the base id with no parameters", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-none"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([]);
		expect(payload.modelDetails?.modelId).toBe("gpt-5.6-sol");
	});

	it("normalizes a fast-lane off-tier sibling preserving the lane", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-none-fast"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol-fast");
		expect(payload.requestedModel?.parameters).toEqual([]);
		expect(payload.modelDetails?.modelId).toBe("gpt-5.6-sol-fast");
	});

	it("leaves Cursor-native ids untouched with no parameters", async () => {
		const payload = await capture(cursorModel("cursor-composer-2.5"));
		expect(payload.requestedModel?.modelId).toBe("cursor-composer-2.5");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});

	it("pins the Standard tier for bare composer-2.5 (#9012)", async () => {
		const payload = await capture(cursorModel("composer-2.5"));
		expect(payload.requestedModel?.modelId).toBe("composer-2.5");
		expect(payload.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "fast", value: "false" })]);
	});

	it("keeps explicit composer-2.5-fast on the Fast lane with no parameters", async () => {
		const payload = await capture(cursorModel("composer-2.5-fast"));
		expect(payload.requestedModel?.modelId).toBe("composer-2.5-fast");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});

	it("does not translate non-OpenAI siblings (Claude effort schema is undecoded)", async () => {
		const payload = await capture(cursorModel("claude-fable-5-low"));
		expect(payload.requestedModel?.modelId).toBe("claude-fable-5-low");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});
});
