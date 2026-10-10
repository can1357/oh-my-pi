import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { type BedrockOptions, streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { bedrockHappyPathFrames, bedrockTestModel, withSkippedBedrockAuth } from "./helpers/bedrock-stream";

const MODEL_ID = "us.anthropic.claude-fable-5-1-v1:0";
const context: Context = { messages: [{ role: "user", content: "Answer.", timestamp: 1 }] };
const protectedOptions = { preserveModelSelection: true, preserveThinkingEffort: true };
interface Body {
	messages: Array<{ role: string; content: unknown[] }>;
	additionalModelRequestFields?: {
		thinking?: { type?: string; budget_tokens?: number; block_binding?: unknown };
		output_config?: { effort?: string };
		reasoning?: { effort?: string };
	};
}
interface Request {
	raw: string;
	body: Body;
	headers: Headers;
	url: URL;
}

function response(): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of bedrockHappyPathFrames()) controller.enqueue(frame);
				controller.close();
			},
		}),
		{ headers: { "content-type": "application/vnd.amazon.eventstream" } },
	);
}

function endpoint(reply?: (request: Request, attempt: number) => Response) {
	const requests: Request[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const raw = await request.text();
			const captured = { raw, body: JSON.parse(raw) as Body, headers: request.headers, url: new URL(request.url) };
			requests.push(captured);
			return reply?.(captured, requests.length) ?? response();
		},
	});
	const model = bedrockTestModel({
		id: MODEL_ID,
		name: "Claude Fable 5.1",
		baseUrl: `${server.url}gateway?route=primary`,
		reasoning: true,
		maxTokens: 128_000,
		thinking: { mode: "anthropic-adaptive", efforts: [Effort.High], prefixBinding: true },
	});
	return { server, requests, model };
}

describe("governed Bedrock final transport", () => {
	it("signs exactly the admitted final body and binds the actual URL model/prefix", async () => {
		const { server, requests, model } = endpoint();
		try {
			await withSkippedBedrockAuth(async () => {
				const result = await streamBedrock(model, context, {
					...protectedOptions,
					reasoning: Effort.High,
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(
					result.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join(""),
				).toBe("hi");
				expect(requests).toHaveLength(1);
				expect(requests[0].url.pathname).toBe(`/gateway/model/${encodeURIComponent(MODEL_ID)}/converse-stream`);
				expect(requests[0].url.search).toBe("?route=primary");
				expect(requests[0].headers.get("authorization")).toContain("AWS4-HMAC-SHA256 Credential=dummy-access-key/");
				expect(requests[0].headers.get("x-amz-content-sha256")).toBe(Bun.SHA256.hash(requests[0].raw, "hex"));
				expect(requests[0].body.additionalModelRequestFields?.output_config?.effort).toBe("high");
				expect(requests[0].body.additionalModelRequestFields?.thinking?.block_binding).toEqual({
					prefix_mismatch_behavior: "drop_block",
				});
			});
		} finally {
			server.stop(true);
		}
	});

	it("preserves the original raster bytes through governed signing and JSON capture", async () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
		const { server, requests, model } = endpoint();
		const target: Model<"bedrock-converse-stream"> = { ...model, input: ["text", "image"] };
		try {
			await withSkippedBedrockAuth(async () => {
				const result = await streamBedrock(
					target,
					{
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: "Describe this raster." },
									{ type: "image", data: png, mimeType: "image/png" },
								],
								timestamp: 1,
							},
						],
					},
					{ ...protectedOptions, reasoning: Effort.High },
				).result();
				expect(result.stopReason).toBe("stop");
				expect(requests).toHaveLength(1);
				const block = requests[0].body.messages[0].content.find(
					block => block !== null && typeof block === "object" && "image" in block,
				);
				if (!block || typeof block !== "object" || !("image" in block)) throw new Error("Expected image block");
				const image = block.image;
				if (!image || typeof image !== "object" || !("source" in image))
					throw new Error("Expected native image source");
				const source = image.source;
				if (!source || typeof source !== "object" || !("bytes" in source) || typeof source.bytes !== "string") {
					throw new Error("Expected native base64 image bytes");
				}
				expect(source.bytes).toBe(png);
				expect(Buffer.from(source.bytes, "base64")).toEqual(Buffer.from(png, "base64"));
				expect(requests[0].headers.get("x-amz-content-sha256")).toBe(Bun.SHA256.hash(requests[0].raw, "hex"));
			});
		} finally {
			server.stop(true);
		}
	});

	it("rejects weakened additionalModelRequestFields before signing or dispatch", async () => {
		const { server, requests, model } = endpoint();
		try {
			const result = await streamBedrock(model, context, {
				...protectedOptions,
				bearerToken: "test",
				reasoning: Effort.High,
				onPayload: value => {
					// The built Converse request is an in-process provider hook value.
					const payload = value as Body;
					payload.additionalModelRequestFields = { thinking: { type: "enabled", budget_tokens: 1024 } };
				},
			}).result();
			expect(requests).toHaveLength(0);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it.each(["toJSON", "accessor"] as const)(
		"rejects unsafe %s before metadata normalization invokes it",
		async kind => {
			const { server, requests, model } = endpoint();
			let evaluations = 0;
			try {
				const result = await streamBedrock(model, context, {
					...protectedOptions,
					bearerToken: "test",
					reasoning: Effort.High,
					onPayload: value => {
						if (kind === "toJSON")
							Object.defineProperty(value, "toJSON", {
								enumerable: true,
								value: () => {
									evaluations++;
									return {};
								},
							});
						else
							Object.defineProperty(value, "additionalModelRequestFields", {
								enumerable: true,
								get: () => {
									evaluations++;
									return { thinking: { type: "disabled" } };
								},
							});
					},
				}).result();
				expect(requests).toHaveLength(0);
				expect(evaluations).toBe(0);
				expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			} finally {
				server.stop(true);
			}
		},
	);

	it("refreshes admission after HTTP backoff and keeps protected callbacks despite hook mutations", async () => {
		let admissions = 0;
		let hooks = 0;
		const { server, requests, model } = endpoint(
			() => new Response("throttled", { status: 429, headers: { "retry-after": "0" } }),
		);
		try {
			const options: BedrockOptions = {
				...protectedOptions,
				bearerToken: "test",
				reasoning: Effort.High,
				onPayload: () => {
					hooks++;
					options.preserveModelSelection = false;
					options.preserveThinkingEffort = false;
					options.onBeforeRequest = undefined;
				},
				onBeforeRequest: () => {
					if (++admissions > 1) throw new Error("grant revoked");
				},
			};
			const result = await streamBedrock(model, context, options).result();
			expect(requests).toHaveLength(1);
			expect(admissions).toBe(2);
			expect(hooks).toBe(1);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("refreshes admission before a prefix-binding resend", async () => {
		let admissions = 0;
		const failure =
			'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. The "system" prompt differs from the one this block was created with.';
		const { server, requests, model } = endpoint(() => new Response(failure, { status: 400 }));
		const previous: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Prior reasoning.", thinkingSignature: "signed" },
				{ type: "text", text: "Prior answer." },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		try {
			const result = await streamBedrock(
				model,
				{ messages: [context.messages[0], previous, { role: "user", content: "Continue.", timestamp: 3 }] },
				{
					...protectedOptions,
					bearerToken: "test",
					reasoning: Effort.High,
					onBeforeRequest: () => {
						if (++admissions > 1) throw new Error("grant revoked");
					},
				},
			).result();
			expect(requests).toHaveLength(1);
			expect(admissions).toBe(2);
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("does not weaken forced tool selection or accept a zero fixed budget", async () => {
		const { server, requests, model } = endpoint();
		try {
			const forced = await streamBedrock(
				model,
				{
					...context,
					tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
				},
				{
					...protectedOptions,
					bearerToken: "test",
					reasoning: Effort.High,
					toolChoice: "any",
				},
			).result();
			const budgetModel = { ...model, thinking: { mode: "budget" as const, efforts: [Effort.High] } };
			const zero = await streamBedrock(budgetModel, context, {
				...protectedOptions,
				bearerToken: "test",
				reasoning: Effort.High,
				thinkingBudgets: { high: 0 },
			}).result();
			expect(requests).toHaveLength(0);
			expect(AIError.is(forced.errorId, AIError.Flag.HostAdmission)).toBe(true);
			expect(AIError.is(zero.errorId, AIError.Flag.HostAdmission)).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("allows an effort hook when only the model is governed and keeps the URL model immutable", async () => {
		const { server, requests, model } = endpoint();
		try {
			const result = await streamBedrock(model, context, {
				preserveModelSelection: true,
				bearerToken: "test",
				reasoning: Effort.High,
				onPayload: (value, exposed) => {
					// The built Converse request is an in-process provider hook value.
					const payload = value as Body;
					if (!exposed || !payload.additionalModelRequestFields) {
						throw new Error("expected Bedrock payload hook model and reasoning fields");
					}
					payload.additionalModelRequestFields.output_config = { effort: "low" };
					exposed.id = "different-model";
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(requests).toHaveLength(1);
			expect(requests[0].url.pathname).toBe(`/gateway/model/${encodeURIComponent(MODEL_ID)}/converse-stream`);
			expect(requests[0].body.additionalModelRequestFields?.output_config?.effort).toBe("low");
		} finally {
			server.stop(true);
		}
	});
});
