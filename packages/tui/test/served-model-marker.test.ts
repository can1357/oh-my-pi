import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import {
	detectServedModelMismatch,
	type ServedModelMismatch,
	ServedModelMarkerComponent,
	ServedModelTracker,
} from "@oh-my-pi/pi-tui/chat/served-model-marker";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(() => {
	initTheme();
});

function turn(parts: {
	model: string;
	served?: string;
	provider?: string;
	upstreamProvider?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: parts.provider ?? "openrouter",
		model: parts.model,
		...(parts.served ? { upstreamModel: parts.served } : {}),
		...(parts.upstreamProvider ? { upstreamProvider: parts.upstreamProvider } : {}),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("detectServedModelMismatch", () => {
	it("flags a different family served under the requested id, naming the route", () => {
		expect(
			detectServedModelMismatch(
				turn({
					model: "anthropic/claude-opus-5",
					served: "claude-haiku-4-5-20251001",
					upstreamProvider: "Amazon Bedrock",
				}),
			),
		).toEqual({
			requested: "anthropic/claude-opus-5",
			served: "claude-haiku-4-5-20251001",
			provider: "openrouter",
			upstreamProvider: "Amazon Bedrock",
		});
	});

	it("flags a different revision of the same family", () => {
		expect(detectServedModelMismatch(turn({ model: "claude-opus-4-6", served: "claude-opus-4-7" }))?.served).toBe(
			"claude-opus-4-7",
		);
	});

	it("treats a dated snapshot or gateway prefix of the requested model as the same model", () => {
		expect(
			detectServedModelMismatch(turn({ model: "anthropic/claude-haiku-4.5", served: "claude-haiku-4-5-20251001" })),
		).toBeUndefined();
	});

	it("treats an unclassifiable served id (first-party A/B codename) as unverifiable, not a substitution", () => {
		expect(
			detectServedModelMismatch(
				turn({ model: "claude-opus-4-6", served: "numbat-v6-efforts-20-40-80-ab-prod", provider: "anthropic" }),
			),
		).toBeUndefined();
	});

	it("stays silent when no served id was recovered", () => {
		expect(detectServedModelMismatch(turn({ model: "claude-fable-5-1" }))).toBeUndefined();
	});
});

describe("ServedModelTracker", () => {
	it("reports each substitution pair once, and a new pair after a model switch", () => {
		const tracker = new ServedModelTracker();
		const swapped = turn({ model: "claude-opus-5", served: "claude-haiku-4-5" });
		expect(tracker.check(swapped)).toBeDefined();
		expect(tracker.check(swapped)).toBeUndefined();
		expect(tracker.check(turn({ model: "claude-opus-5", served: "claude-opus-5" }))).toBeUndefined();
		expect(tracker.check(turn({ model: "claude-sonnet-5", served: "claude-haiku-4-5" }))?.requested).toBe(
			"claude-sonnet-5",
		);
		expect(tracker.check(swapped)).toBeUndefined();
	});
});

describe("ServedModelMarkerComponent", () => {
	/** The divider paints its label straight into the transcript row. */
	function markerRule(info: ServedModelMismatch, width = 400): string {
		const lines = new ServedModelMarkerComponent(info).render(width);
		expect(lines.length).toBe(3); // breathing room above and below the rule
		return Bun.stripANSI(lines[1]);
	}

	it("names the served id, the requested id and the route", () => {
		const rule = markerRule({
			requested: "claude-opus-5",
			served: "claude-haiku-4-5-20251001",
			provider: "openrouter",
			upstreamProvider: "Amazon Bedrock",
		});
		expect(rule).toContain(
			"served claude-haiku-4-5-20251001 · requested claude-opus-5 · via openrouter/Amazon Bedrock",
		);
	});

	it("renders a host-chosen echo as single-line bounded text", () => {
		// A local host answering `chunk.model` with a checkpoint path, an embedded
		// SGR sequence, a newline, and an id far longer than any real model name.
		const echo = `${os.homedir()}/models/qwen3\u001b[31m-flash\nnext-${"q".repeat(200)}.gguf`;
		const rule = markerRule({
			requested: "qwen3.8-flash-next",
			served: echo,
			provider: "lm-studio",
		});
		expect(rule).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/); // no escapes, no extra rows
		expect(rule).toContain("served ~/models/qwen3");
		expect(rule).not.toContain(os.homedir());
		expect(rule).not.toContain("q".repeat(200));
		const servedLabel = rule.split(" served ")[1]?.split(" · ")[0] ?? "";
		expect(servedLabel.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.TITLE);
	});
});
