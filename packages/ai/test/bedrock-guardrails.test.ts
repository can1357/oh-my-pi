import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { bedrockEvent, bedrockTestModel } from "./helpers/bedrock-stream";

interface GuardrailPayload {
	guardrailConfig?: {
		guardrailIdentifier: string;
		guardrailVersion: string;
		trace?: "enabled" | "disabled" | "enabled_full";
	};
}

function model(): Model<"bedrock-converse-stream"> {
	return bedrockTestModel({
		id: "openai.gpt-oss-20b-1:0",
		name: "gpt-oss-20b",
		baseUrl: "",
		contextWindow: 131_072,
		maxTokens: 4_096,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "Reply briefly", timestamp: 0 }],
	tools: [],
};

function stopReasonFetch(stopReason: string): FetchImpl {
	const frame = bedrockEvent("messageStop", JSON.stringify({ stopReason }));
	return Object.assign(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(frame);
						controller.close();
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				},
			),
		{ preconnect: fetch.preconnect },
	);
}

async function capturePayload(options: {
	guardrailIdentifier?: string;
	guardrailVersion?: string;
	guardrailTrace?: "enabled" | "disabled" | "enabled_full";
}): Promise<GuardrailPayload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<GuardrailPayload>();
	const stream = streamBedrock(model(), context, {
		...options,
		bearerToken: "test-token",
		signal: controller.signal,
		fetch: async () => new Response(new Uint8Array(), { status: 200 }),
		onPayload: payload => {
			resolve(payload as GuardrailPayload);
			return undefined;
		},
	});
	const drain = (async () => {
		for await (const _ of stream) {
			// Drain the provider stream so request errors are observed.
		}
	})();
	const [payload] = await Promise.all([promise, drain]);
	return payload;
}

describe("amazon-bedrock guardrails", () => {
	it("sends configured guardrail values in the Converse request", async () => {
		const payload = await capturePayload({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/abcd1234",
			guardrailVersion: "7",
			guardrailTrace: "enabled_full",
		});

		expect(payload.guardrailConfig).toEqual({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/abcd1234",
			guardrailVersion: "7",
			trace: "enabled_full",
		});
	});

	it("maps transport guardrails into the Bedrock provider options", async () => {
		const { promise, resolve } = Promise.withResolvers<GuardrailPayload>();
		const stream = streamSimple(model(), context, {
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/abcd1234",
			guardrailVersion: "7",
			guardrailTrace: "enabled_full",
			providerOptions: { bearerToken: "test-token" },
			fetch: async () => new Response(new Uint8Array(), { status: 200 }),
			onPayload: payload => {
				resolve(payload as GuardrailPayload);
				return undefined;
			},
		});
		const drain = (async () => {
			for await (const _ of stream) {
				// Drain the provider stream so request errors are observed.
			}
		})();
		const [payload] = await Promise.all([promise, drain]);

		expect(payload.guardrailConfig).toEqual({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/abcd1234",
			guardrailVersion: "7",
			trace: "enabled_full",
		});
	});

	it("defaults configured guardrails to the DRAFT version", async () => {
		const payload = await capturePayload({ guardrailIdentifier: "abcd1234" });

		expect(payload.guardrailConfig).toEqual({
			guardrailIdentifier: "abcd1234",
			guardrailVersion: "DRAFT",
			trace: undefined,
		});
	});

	it("keeps model content filtering distinct from guardrail intervention", async () => {
		const result = await streamBedrock(model(), context, {
			bearerToken: "test-token",
			fetch: stopReasonFetch("content_filtered"),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("content filters");
		expect(result.errorMessage).not.toContain("guardrail");
	});
});
