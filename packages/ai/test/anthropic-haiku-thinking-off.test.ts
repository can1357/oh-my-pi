import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const MODEL = buildModel({
	id: "claude-haiku-5-5",
	name: "Claude Haiku 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

interface Payload {
	thinking?: { type: string };
	output_config?: { effort?: string };
	messages: { output_config?: unknown }[];
}

let clock = 1;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: clock++ });

function reply(turn: AssistantMessage): AssistantMessage {
	return {
		...turn,
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		timestamp: clock++,
	};
}

/** Builds one request through the real param path; `reasoning` undefined is thinking Off. */
async function capture(
	messages: Message[],
	reasoning: Effort | undefined,
): Promise<{ payload: Payload; message: AssistantMessage }> {
	let payload: Payload | undefined;
	const controller = new AbortController();
	controller.abort();
	const message = await streamAnthropic(
		MODEL,
		{ messages },
		{
			apiKey: "sk-ant-api-test",
			signal: controller.signal,
			thinkingEnabled: reasoning !== undefined,
			reasoning,
			onPayload: captured => {
				payload = captured as Payload;
			},
		},
	).result();
	if (!payload) throw new Error("expected a built payload");
	return { payload, message };
}

/** Runs adaptive turns at `efforts`, then one Off turn, returning the Off payload. */
async function offAfter(efforts: Effort[]): Promise<Payload> {
	const messages: Message[] = [user("q0")];
	for (const [index, effort] of efforts.entries()) {
		const turn = await capture(messages, effort);
		messages.push(reply(turn.message), user(`q${index + 1}`));
	}
	return (await capture(messages, undefined)).payload;
}

const perMessageControls = (payload: Payload) => payload.messages.filter(message => message.output_config).length;

describe("Anthropic Claude Haiku 5.5 thinking Off", () => {
	it("sends disabled thinking instead of omitted (adaptive) thinking", async () => {
		const payload = await offAfter([]);
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(perMessageControls(payload)).toBe(0);
	});

	it("keeps disabled after adaptive turns at one effort", async () => {
		const payload = await offAfter([Effort.Medium, Effort.Medium]);
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBe("medium");
		expect(perMessageControls(payload)).toBe(0);
	});

	// `disabled` is a 400 above `high`, and the stable top-level effort outlives the toggle.
	it("falls back to lowest-effort adaptive when an xhigh top-level effort is in force", async () => {
		const payload = await offAfter([Effort.XHigh]);
		expect(payload.thinking?.type).toBe("adaptive");
		expect(payload.output_config?.effort).toBe("xhigh");
		expect(payload.messages.map(message => message.output_config).filter(Boolean)).toEqual([{ effort: "low" }]);
	});

	// A per-message effort control is a 400 with thinking off.
	it("falls back to lowest-effort adaptive when history replays per-message effort controls", async () => {
		const payload = await offAfter([Effort.Medium, Effort.High]);
		expect(payload.thinking?.type).toBe("adaptive");
		expect(perMessageControls(payload)).toBeGreaterThan(0);
	});
});
