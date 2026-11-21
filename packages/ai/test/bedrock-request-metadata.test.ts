import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Model } from "@oh-my-pi/pi-ai/types";
import {
	bedrockTestModel,
	BEDROCK_TEST_CONTEXT,
	capturingBedrockFetch,
	withSkippedBedrockAuth,
} from "./helpers/bedrock-stream";

// `requestMetadata` is Bedrock invocation-log attribution: config-level tags
// (`model.requestMetadata`), per-call tags (`options.requestMetadata`), and
// extension-injected tags (`onPayload`) all merge into one body field and go
// through the same AWS-limits guard before the request is ever serialized, so
// a malformed tag can drop entries but never fail the turn.

function model(requestMetadata?: Record<string, string>): Model<"bedrock-converse-stream"> {
	return bedrockTestModel(requestMetadata ? { requestMetadata } : undefined);
}

const context = BEDROCK_TEST_CONTEXT;

describe("amazon-bedrock requestMetadata", () => {
	it("merges model tags with per-call tags, per-call winning on collision", async () => {
		const seen: { body?: unknown } = {};
		await withSkippedBedrockAuth(async () => {
			const stream = streamBedrock(model({ team: "growth", environment: "prod" }), context, {
				region: "us-east-1",
				fetch: capturingBedrockFetch(seen),
				requestMetadata: { environment: "staging", run: "42" },
			});
			await stream.result();
		});

		const body = seen.body as { requestMetadata?: Record<string, string> };
		expect(body.requestMetadata).toEqual({ team: "growth", environment: "staging", run: "42" });
	});

	it("drops malformed entries but keeps well-formed siblings", async () => {
		const seen: { body?: unknown } = {};
		await withSkippedBedrockAuth(async () => {
			const stream = streamBedrock(model(), context, {
				region: "us-east-1",
				fetch: capturingBedrockFetch(seen),
				requestMetadata: {
					"bad*key": "x", // rejected character in the key
					longValue: "v".repeat(257), // exceeds the 256-char value limit
					good: "kept", // valid entry
				},
			});
			await stream.result();
		});

		const body = seen.body as { requestMetadata?: Record<string, string> };
		expect(body.requestMetadata).toEqual({ good: "kept" });
	});

	it("drops the 17th entry once the 16-entry cap is reached", async () => {
		const seen: { body?: unknown } = {};
		const many: Record<string, string> = {};
		for (let i = 0; i < 17; i++) many[`k${i}`] = `v${i}`;
		await withSkippedBedrockAuth(async () => {
			const stream = streamBedrock(model(), context, {
				region: "us-east-1",
				fetch: capturingBedrockFetch(seen),
				requestMetadata: many,
			});
			await stream.result();
		});

		const body = seen.body as { requestMetadata?: Record<string, string> };
		expect(Object.keys(body.requestMetadata ?? {}).length).toBe(16);
	});

	it("validates onPayload-injected tags after the hook, keeping valid siblings", async () => {
		const seen: { body?: unknown } = {};
		await withSkippedBedrockAuth(async () => {
			const stream = streamBedrock(model(), context, {
				region: "us-east-1",
				fetch: capturingBedrockFetch(seen),
				onPayload: payload => ({
					...(payload as Record<string, unknown>),
					requestMetadata: { "bad*key": "x", valid: "yes" },
				}),
			});
			await stream.result();
		});

		const body = seen.body as { requestMetadata?: Record<string, string> };
		expect(body.requestMetadata).toEqual({ valid: "yes" });
	});

	it("omits requestMetadata entirely when nothing is set anywhere", async () => {
		const seen: { body?: unknown } = {};
		await withSkippedBedrockAuth(async () => {
			const stream = streamBedrock(model(), context, { region: "us-east-1", fetch: capturingBedrockFetch(seen) });
			await stream.result();
		});

		const body = seen.body as Record<string, unknown>;
		expect("requestMetadata" in body).toBe(false);
	});
});

describe("amazon-bedrock requestMetadata via streamSimple mapper", () => {
	// `mapOptionsForApi`'s `bedrockBase` literal is a hand-picked field list with
	// no catch-all spread. This proves per-call `requestMetadata` survives that
	// mapper on a direct (non pi-native) model, rather than only proving it
	// survives `streamBedrock` called directly as the tests above do.
	it("carries per-call requestMetadata from streamSimple through to the serialized body", async () => {
		const seen: { body?: unknown } = {};
		await withSkippedBedrockAuth(async () => {
			await streamSimple(bedrockTestModel(), BEDROCK_TEST_CONTEXT, {
				fetch: capturingBedrockFetch(seen),
				requestMetadata: { team: "growth", environment: "staging" },
			}).result();
		});

		const body = seen.body as { requestMetadata?: Record<string, string> };
		expect(body.requestMetadata).toEqual({ team: "growth", environment: "staging" });
	});
});
