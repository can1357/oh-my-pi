import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamSimple } from "../src/stream";
import {
	anthropicChunks,
	type CapturedRequest,
	captureFetch,
	completionsChunks,
	factoryModel,
	gptTerra,
	kimiK3,
	responsesChunks,
	sonnet5,
	WORKOS_TOKEN,
} from "./helpers/factory-droid";

const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };

describe("Factory Droid public stream controls", () => {
	it("does not purchase reasoning when an optional-reasoning turn is forced off", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamSimple(kimiK3(), context, {
			apiKey: WORKOS_TOKEN,
			reasoning: Effort.High,
			forceReasoningOff: true,
			fetch: captureFetch(captured, completionsChunks("ok", "kimi-k3")),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(captured[0]?.body.reasoning_effort).toBe("none");
		expect(captured[0]?.body.reasoning_history).toBeUndefined();
	});

	it("disables Responses reasoning without a thinking-budget instruction", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamSimple(factoryModel("gpt-5.6-terra", ["snowflake"]), context, {
			apiKey: WORKOS_TOKEN,
			disableReasoning: true,
			fetch: captureFetch(captured, responsesChunks("ok")),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(captured[0]?.body.reasoning).toEqual({ effort: "none" });
		// A trailing "# Juice: N" item would ask the model to reason anyway.
		expect(JSON.stringify(captured[0]?.body.input)).not.toContain("Juice");
	});

	it("keeps thinking enabled while omitting its summary when requested", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamSimple(sonnet5(), context, {
			apiKey: WORKOS_TOKEN,
			reasoning: Effort.High,
			hideThinkingSummary: true,
			fetch: captureFetch(captured, anthropicChunks("ok")),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(captured[0]?.body.thinking).toMatchObject({ type: "adaptive", display: "omitted" });
	});

	it("honors caller verbosity over the registry response default", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamSimple(gptTerra(), context, {
			apiKey: WORKOS_TOKEN,
			reasoning: Effort.High,
			textVerbosity: "high",
			fetch: captureFetch(captured, responsesChunks("ok")),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(captured[0]?.body.text).toMatchObject({ verbosity: "high" });
	});
});
