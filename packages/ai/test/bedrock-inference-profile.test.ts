import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@pk-nerdsaver-ai/pi-ai/providers/amazon-bedrock";
import type { Context, FetchImpl, Model } from "@pk-nerdsaver-ai/pi-ai/types";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { withEnv } from "./helpers";

const profileArn = "arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/company-opus-48";
const profileModel: Model<"bedrock-converse-stream"> = buildModel({
	id: profileArn,
	name: "Bedrock inference profile",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 1000000,
	maxTokens: 128000,
});

function userContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
	};
}

describe("Bedrock inference profile ARNs", () => {
	test("routes requests to the ARN region and preserves the ARN model id", async () => {
		const calls: string[] = [];
		const customFetch: FetchImpl = Object.assign(
			async (input: string | URL | Request, _init?: RequestInit) => {
				calls.push(String(input instanceof Request ? input.url : input));
				return new Response("nope", { status: 418 });
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamBedrock(profileModel, userContext(), {
			bearerToken: "test-token",
			fetch: customFetch,
			maxTokens: 16,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(calls).toEqual([
			`https://bedrock-runtime.us-east-2.amazonaws.com/model/${encodeURIComponent(profileArn)}/converse-stream`,
		]);
	});
});

function bedrockModel(id: string): Model<"bedrock-converse-stream"> {
	return buildModel({
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
	});
}

async function capturedRequestHost(
	model: Model<"bedrock-converse-stream">,
	options: { region?: string } = {},
): Promise<string> {
	const calls: string[] = [];
	const customFetch: FetchImpl = Object.assign(
		async (input: string | URL | Request, _init?: RequestInit) => {
			calls.push(String(input instanceof Request ? input.url : input));
			return new Response("nope", { status: 418 });
		},
		{ preconnect: fetch.preconnect },
	);
	const result = await streamBedrock(model, userContext(), {
		bearerToken: "test-token",
		fetch: customFetch,
		maxTokens: 16,
		...options,
	}).result();
	expect(result.stopReason).toBe("error");
	expect(calls).toHaveLength(1);
	return new URL(calls[0]).host;
}

describe("Bedrock cross-region inference-profile geo routing", () => {
	// A `us-east-1` ambient region exercises the mismatch-correction path: a non-`us`
	// geo profile must be rerouted off the ambient `us` region, not pass through it.
	const US_AMBIENT = { AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: undefined } as const;

	// Repro: an `eu.` profile defaulted to us-east-1 → HTTP 400 "The provided model identifier is invalid."
	test("routes an eu. profile to an EU region instead of us-east-1", async () => {
		await withEnv(US_AMBIENT, async () => {
			expect(await capturedRequestHost(bedrockModel("eu.anthropic.claude-fable-5"))).toBe(
				"bedrock-runtime.eu-west-1.amazonaws.com",
			);
		});
	});

	test("routes an au. profile to the Australia region", async () => {
		await withEnv(US_AMBIENT, async () => {
			expect(await capturedRequestHost(bedrockModel("au.anthropic.claude-opus-4-8"))).toBe(
				"bedrock-runtime.ap-southeast-2.amazonaws.com",
			);
		});
	});

	test("routes a jp. profile to a Japan region", async () => {
		await withEnv(US_AMBIENT, async () => {
			expect(await capturedRequestHost(bedrockModel("jp.anthropic.claude-opus-4-8"))).toBe(
				"bedrock-runtime.ap-northeast-1.amazonaws.com",
			);
		});
	});

	test("falls back to us-east-1 for a geo profile when no ambient region is set", async () => {
		await withEnv({ AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined }, async () => {
			expect(await capturedRequestHost(bedrockModel("us.anthropic.claude-opus-4-8"))).toBe(
				"bedrock-runtime.us-east-1.amazonaws.com",
			);
		});
	});

	test("leaves region-agnostic global. profiles on the ambient region", async () => {
		await withEnv({ AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined }, async () => {
			expect(await capturedRequestHost(bedrockModel("global.anthropic.claude-opus-4-8"))).toBe(
				"bedrock-runtime.us-east-1.amazonaws.com",
			);
		});
	});

	test("honors a same-geo ambient region for a geo-prefixed profile", async () => {
		await withEnv({ AWS_REGION: "eu-central-1", AWS_DEFAULT_REGION: undefined }, async () => {
			expect(await capturedRequestHost(bedrockModel("eu.anthropic.claude-opus-4-8"))).toBe(
				"bedrock-runtime.eu-central-1.amazonaws.com",
			);
		});
	});

	test("explicit per-request region wins over the geo prefix and ambient region", async () => {
		await withEnv({ AWS_REGION: "eu-central-1", AWS_DEFAULT_REGION: undefined }, async () => {
			expect(await capturedRequestHost(bedrockModel("eu.anthropic.claude-opus-4-8"), { region: "eu-west-3" })).toBe(
				"bedrock-runtime.eu-west-3.amazonaws.com",
			);
		});
	});
});
