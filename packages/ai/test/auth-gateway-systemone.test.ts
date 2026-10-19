import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NativeJudge, type ImageContent, type JudgmentRequest } from "@oh-my-pi/pi-ai";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { buildGatewayApiKeyResolver } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const REQUEST = {
	state: "Help! My payouts have been failing for 3 days.",
	questions: { urgent: { type: "noul", instructions: { question: "Does this convey urgency?", scope: "billing" } } },
};

const UPSTREAM_ANSWER = {
	model: "jev-1.13.0",
	answers: { urgent: { type: "noul", noul: 0.92 } },
	usage: { input_tokens: 300, output_tokens: 20 },
};

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
/** 320x320 grayscale PNG: inside Jev's 280–1568 px per-side bounds, unlike the 1x1 `PNG_DATA`. */
const JEV_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAAAAADo+/p2AAAAeklEQVR42u3BgQAAAADDoPlTH+ECVQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMA3kU8AAamZiz8AAAAASUVORK5CYII=";

const OPENAI_ANSWER = {
	model: "gpt-6-luna",
	answers: [{ type: "predicate", name: "urgent", probability: 0.92 }],
	usage: { input_tokens: 300, output_tokens: 20 },
};

const OPENROUTER_JEV = getBundledModel("openrouter", "~typesafe/jev-latest");
if (!OPENROUTER_JEV) throw new Error("expected bundled openrouter/~typesafe/jev-latest");

interface Harness {
	url: string;
	upstream: { url: string; init: RequestInit | undefined }[];
	storage: AuthStorage;
	close: () => Promise<void>;
}

interface CapturedGatewayResponse {
	headers: { get(name: string): string | null };
	json(): Promise<unknown>;
}

function openaiDecisionModel(id: string, input: ("text" | "image")[]) {
	return buildModel({
		id,
		name: id,
		api: "openai-decisions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		requestModelId: "gpt-6-luna",
		reasoning: false,
		input,
		cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 0,
	} as ModelSpec<"openai-decisions">);
}

async function boot(respond: (init: RequestInit | undefined) => Response): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-systemone-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("typesafe", "ts-secret");
	storage.keys.setRuntime("openai", "openai-secret");
	storage.keys.setRuntime("openrouter", "or-secret");
	const jev = getBundledModel("typesafe", "jev-latest");
	if (!jev) throw new Error("expected bundled typesafe/jev-latest");
	const chat = createMockModel({ provider: "openrouter", id: "chat-only" });
	const openaiVision = openaiDecisionModel("openai-vision", ["text", "image"]);
	const openaiTextOnly = openaiDecisionModel("openai-text-only", ["text"]);
	// Self-hosted OpenJEV: the catalog caps its `questions` map at 16.
	const openjev = buildModel({
		id: "openjev-4b",
		name: "openjev-4b",
		api: "typesafe",
		provider: "typesafe",
		baseUrl: "http://localhost:8000",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 0,
	});
	const upstream: Harness["upstream"] = [];
	const fetchStub: FetchImpl = async (input, init) => {
		upstream.push({ url: String(input), init });
		return respond(init);
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-token"],
		storage,
		resolveModel: id => {
			if (id === "jev-latest" || id === "typesafe/jev-latest") return jev;
			if (id === OPENROUTER_JEV.id || id === `${OPENROUTER_JEV.provider}/${OPENROUTER_JEV.id}`)
				return OPENROUTER_JEV;
			if (id === "chat-only") return chat;
			if (id === "openjev-4b") return openjev;
			if (id === "openai-vision") return openaiVision;
			if (id === "openai-text-only") return openaiTextOnly;
			return undefined;
		},
		version: "test",
		fetch: fetchStub,
	});
	return {
		url: handle.url,
		upstream,
		storage,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function post(url: string, pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${url}${pathname}`, {
		method: "POST",
		headers: { Authorization: "Bearer gw-token", "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

describe("auth-gateway POST /v1/systemone", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.close();
		harness = undefined;
	});

	it("forwards the judgment with the broker credential and re-encodes TypeSafe's answer", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const recorded: { provider: string; model: string; costUsd?: number; client?: { app?: string } }[] = [];
		vi.spyOn(harness.storage.usage, "observe").mockImplementation(entry => {
			recorded.push(entry);
		});

		const response = await post(
			harness.url,
			"/v1/systemone",
			{ model: "typesafe/jev-latest", ...REQUEST },
			{
				"x-omp-app": "robomp",
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			model: "jev-1.13.0",
			answers: { urgent: { type: "noul", noul: 0.92 } },
			usage: { input_tokens: 300, output_tokens: 20 },
		});
		// Client never saw the real key; upstream got it, at the model's base URL,
		// with structured instructions forwarded verbatim and the catalog id.
		expect(harness.upstream).toHaveLength(1);
		expect(harness.upstream[0].url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(new Headers(harness.upstream[0].init?.headers).get("authorization")).toBe("Bearer ts-secret");
		expect(JSON.parse(String(harness.upstream[0].init?.body))).toEqual({ ...REQUEST, model: "jev-latest" });
		// Cost is priced from the catalog (jev bills input only) for the header and the ledger.
		const cost = Number(response.headers.get("x-litellm-response-cost"));
		expect(cost).toBeGreaterThan(0);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({ provider: "typesafe", model: "jev-latest", costUsd: cost });
		expect(recorded[0].client?.app).toBe("robomp");
	});

	it("round-trips referenced image assets through NativeJudge and the gateway", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const recorded: { provider: string; model: string; costUsd?: number }[] = [];
		vi.spyOn(harness.storage.usage, "observe").mockImplementation(entry => {
			recorded.push(entry);
		});

		const reference = "__proto__";
		const state = {
			ticket: "payouts",
			context: {
				customer: "My payout has been delayed.",
				attachment: { asset_ref: reference },
			},
			history: [{ evidence: { image: reference } }],
		};
		const questions = {
			urgent: {
				type: "noul",
				instructions: { question: "Does this convey urgency?", asset_ref: reference },
				criteria: { true: `The referenced ${reference} image is urgent.`, false: "It is not urgent." },
			},
		};
		const request = { state, questions } as unknown as JudgmentRequest;
		const imageAssets: Record<string, ImageContent> = {
			[reference]: { type: "image", data: JEV_PNG, mimeType: "image/png" },
		};
		let gatewayResponse: CapturedGatewayResponse | undefined;
		let clientHeaders: Headers | undefined;
		const client = new NativeJudge({
			api: "typesafe",
			provider: "typesafe",
			model: "typesafe/jev-latest",
			baseUrl: harness.url,
			apiKey: "gw-token",
			supportsImages: true,
			fetch: async (input, init) => {
				clientHeaders = new Headers(init?.headers);
				const response = await fetch(input, init);
				gatewayResponse = response.clone();
				return response;
			},
		});
		const result = await client.judge(request, { imageAssets });

		expect(result.answers).toEqual({ urgent: { type: "noul", noul: 0.92 } });
		expect(result.usage).toMatchObject({ input: 300, output: 20 });
		expect(clientHeaders?.get("TypeSafe-Danger-Zone-Images")).toBe("true");
		const response = gatewayResponse;
		if (!response) throw new Error("NativeJudge did not reach the auth gateway");
		expect(await response.json()).toEqual({
			model: "jev-1.13.0",
			answers: { urgent: { type: "noul", noul: 0.92 } },
			usage: { input_tokens: 300, output_tokens: 20 },
		});
		const cost = Number(response.headers.get("x-litellm-response-cost"));
		expect(cost).toBeGreaterThan(0);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({ provider: "typesafe", model: "jev-latest", costUsd: cost });

		expect(harness.upstream).toHaveLength(1);
		expect(harness.upstream[0].url).toBe("https://api.typesafe.ai/v1/systemone");
		const headers = new Headers(harness.upstream[0].init?.headers);
		expect(headers.get("authorization")).toBe("Bearer ts-secret");
		expect(headers.get("TypeSafe-Danger-Zone-Images")).toBe("true");
		const upstreamBody = JSON.parse(String(harness.upstream[0].init?.body)) as {
			model: string;
			state: typeof state;
			questions: typeof questions;
			assets: Record<string, { type: "image"; format: "png" | "jpeg"; data_base64: string }>;
		};
		expect(Object.keys(upstreamBody).sort()).toEqual(["assets", "model", "questions", "state"]);
		expect(upstreamBody.model).toBe("jev-latest");
		expect(upstreamBody.state).toEqual(state);
		expect(upstreamBody.questions).toEqual(questions);
		expect(upstreamBody.assets).toEqual({
			[reference]: { type: "image", format: "png", data_base64: JEV_PNG },
		});
		expect(Buffer.from(upstreamBody.assets[reference].data_base64, "base64")).toEqual(Buffer.from(JEV_PNG, "base64"));
	});

	it("rejects malformed inline assets before credential lookup", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		harness.storage.keys.removeRuntime("typesafe");
		const credentialLookup = vi.spyOn(harness.storage.keys, "getWithCredential");
		for (const asset of [
			{ format: "png", data_base64: "AQ=I" },
			{ format: "gif", data_base64: PNG_DATA },
			{ format: "png", data_base64: PNG_DATA, part: "multipart-only" },
		]) {
			const response = await post(harness.url, "/v1/systemone", {
				model: "typesafe/jev-latest",
				...REQUEST,
				assets: { attachment: asset },
			});
			expect(response.status).toBe(422);
		}
		const invalidMap = await post(harness.url, "/v1/systemone", {
			model: "typesafe/jev-latest",
			...REQUEST,
			assets: [{ format: "png", data_base64: PNG_DATA }],
		});
		expect(invalidMap.status).toBe(422);
		const unreferenced = await post(harness.url, "/v1/systemone", {
			model: "typesafe/jev-latest",
			...REQUEST,
			assets: { attachment: { format: "png", data_base64: JEV_PNG } },
		});
		expect(unreferenced.status).toBe(422);
		expect(await unreferenced.json()).toMatchObject({
			error: { message: expect.stringContaining('image asset "attachment" is not referenced') },
		});
		expect(credentialLookup).not.toHaveBeenCalled();
		expect(harness.upstream).toHaveLength(0);
	});

	it("rejects inline assets above Jev's per-image cap before credential lookup", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		harness.storage.keys.removeRuntime("typesafe");
		const credentialLookup = vi.spyOn(harness.storage.keys, "getWithCredential");
		const oversized = Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64");
		const response = await post(harness.url, "/v1/systemone", {
			model: "typesafe/jev-latest",
			state: { evidence: "attachment" },
			questions: REQUEST.questions,
			assets: { attachment: { format: "png", data_base64: oversized } },
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: {
				type: "invalid_request_error",
				message: expect.stringContaining("images[0] is 16777217 bytes"),
			},
		});
		expect(credentialLookup).not.toHaveBeenCalled();
		expect(harness.upstream).toHaveLength(0);
	});

	it("rejects a Jev image below the catalog minimum before gateway credential lookup", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		harness.storage.keys.removeRuntime("typesafe");
		const credentialLookup = vi.spyOn(harness.storage.keys, "getWithCredential");
		const response = await post(harness.url, "/v1/systemone", {
			model: "typesafe/jev-latest",
			state: "Inspect this tiny image.",
			questions: REQUEST.questions,
			images: [{ type: "image", data: PNG_DATA, mimeType: "image/png" }],
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: {
				type: "invalid_request_error",
				message: expect.stringContaining("at least 78400 pixels"),
			},
		});
		expect(credentialLookup).not.toHaveBeenCalled();
		expect(harness.upstream).toHaveLength(0);
	});

	it("serves the OpenRouter Decisions path with the same handler", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const response = await post(harness.url, "/alpha/decisions", { model: "jev-latest", ...REQUEST });
		expect(response.status).toBe(200);
		expect(harness.upstream).toHaveLength(1);
	});

	it("routes OpenRouter Jev image judgments through Decisions without TypeSafe image opt-in", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		expect(OPENROUTER_JEV.input).toContain("image");
		const state = {
			__omp_judgment_images: "caller-owned base key",
			__omp_judgment_images_1: { retained: true },
			ticket: "payouts",
			messages: [{ author: "customer", text: "My payout has been delayed." }],
		};
		const originalState = structuredClone(state);
		const questions = REQUEST.questions;
		const imagePart = {
			type: "image_url",
			image_url: { url: `data:image/png;base64,${JEV_PNG}` },
		};
		const response = await post(harness.url, "/v1/systemone", {
			model: OPENROUTER_JEV.id,
			state,
			questions,
			images: [{ type: "image", data: JEV_PNG, mimeType: "image/png" }],
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(UPSTREAM_ANSWER);
		expect(harness.upstream).toHaveLength(1);
		expect(harness.upstream[0].url).toBe(`${OPENROUTER_JEV.baseUrl}/decisions`);
		const headers = new Headers(harness.upstream[0].init?.headers);
		expect(headers.get("authorization")).toBe("Bearer or-secret");
		expect(headers.get("TypeSafe-Danger-Zone-Images")).toBeNull();
		const upstreamBody = JSON.parse(String(harness.upstream[0].init?.body)) as {
			model: string;
			state: Record<string, unknown>;
			questions: typeof questions;
		};
		expect(upstreamBody).toEqual({
			model: OPENROUTER_JEV.id,
			state: { ...state, __omp_judgment_images_2: [imagePart] },
			questions,
		});
		expect(upstreamBody.state.ticket).toBe(state.ticket);
		expect(upstreamBody.state.__omp_judgment_images).toBe(state.__omp_judgment_images);
		expect(upstreamBody.state.__omp_judgment_images_1).toEqual(state.__omp_judgment_images_1);
		const sentImages = upstreamBody.state.__omp_judgment_images_2 as (typeof imagePart)[];
		expect(Buffer.from(sentImages[0].image_url.url.slice("data:image/png;base64,".length), "base64")).toEqual(
			Buffer.from(JEV_PNG, "base64"),
		);
		expect(state).toEqual(originalState);
	});

	it("rejects asset maps for wires that cannot preserve them before credential lookup", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		harness.storage.keys.removeRuntime("openrouter");
		const credentialLookup = vi.spyOn(harness.storage.keys, "getWithCredential");
		const response = await post(harness.url, "/v1/systemone", {
			model: OPENROUTER_JEV.id,
			state: { evidence: { asset_ref: "attachment" } },
			questions: REQUEST.questions,
			assets: { attachment: { format: "png", data_base64: PNG_DATA } },
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: { type: "invalid_request_error", message: expect.stringMatching(/asset/i) },
		});
		expect(credentialLookup).not.toHaveBeenCalled();
		expect(harness.upstream).toHaveLength(0);
	});

	it("translates embedded images with case-insensitive MIME types and questions to OpenAI Decisions input", async () => {
		harness = await boot(() => Response.json(OPENAI_ANSWER));
		const request = {
			model: "openai-vision",
			state: "Check this image for urgency.",
			questions: { urgent: { type: "noul", instructions: "Does the image convey urgency?" } },
			images: [{ type: "image", data: PNG_DATA, mimeType: "IMAGE/PNG" }],
		};
		const response = await post(harness.url, "/v1/systemone", request);

		expect(response.status).toBe(200);
		expect(harness.upstream).toHaveLength(1);
		expect(harness.upstream[0].url).toBe("https://api.openai.com/v1/decisions");
		expect(new Headers(harness.upstream[0].init?.headers).get("authorization")).toBe("Bearer openai-secret");
		expect(JSON.parse(String(harness.upstream[0].init?.body))).toEqual({
			model: "gpt-6-luna",
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: request.state },
						{ type: "input_image", image_url: `data:image/png;base64,${PNG_DATA}` },
					],
				},
			],
			questions: [{ type: "predicate", name: "urgent", instructions: "Does the image convey urgency?" }],
		});
	});

	it("accepts valid padded and unpadded image data and a supported detail value", async () => {
		harness = await boot(() => Response.json(OPENAI_ANSWER));
		for (const fixture of [
			{ data: "AQI=", detail: "high" },
			{ data: "AQI", detail: undefined },
		]) {
			const image = { type: "image", data: fixture.data, mimeType: "image/png", detail: fixture.detail };
			const response = await post(harness.url, "/v1/systemone", {
				model: "openai-vision",
				...REQUEST,
				images: [image],
			});
			expect(response.status).toBe(200);
			const forwarded = JSON.parse(String(harness.upstream.at(-1)?.init?.body));
			expect(forwarded.input[0].content.at(-1)).toEqual({
				type: "input_image",
				image_url: `data:image/png;base64,${fixture.data}`,
				...(fixture.detail === undefined ? {} : { detail: fixture.detail }),
			});
		}
		expect(harness.upstream).toHaveLength(2);
	});

	it("rejects image input for a model without image capability before credential lookup", async () => {
		harness = await boot(() => Response.json(OPENAI_ANSWER));
		const credentialLookup = vi.spyOn(harness.storage.keys, "getWithCredential");
		const response = await post(harness.url, "/v1/systemone", {
			model: "openai-text-only",
			state: "Check this image.",
			questions: { urgent: { type: "noul", instructions: "Does the image convey urgency?" } },
			images: [{ type: "image", data: PNG_DATA, mimeType: "image/png" }],
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: { type: "invalid_request_error", message: expect.stringContaining("does not support image inputs") },
		});
		expect(credentialLookup).not.toHaveBeenCalled();
		expect(harness.upstream).toHaveLength(0);
	});

	it("keeps image-like JSON state separate from top-level image content", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const state = { type: "image", data: PNG_DATA, mimeType: "image/png" };
		const response = await post(harness.url, "/v1/systemone", {
			model: "jev-latest",
			state,
			questions: REQUEST.questions,
		});

		expect(response.status).toBe(200);
		expect(harness.upstream).toHaveLength(1);
		expect(JSON.parse(String(harness.upstream[0].init?.body))).toEqual({
			model: "jev-latest",
			state,
			questions: REQUEST.questions,
		});
	});

	it("rejects malformed bodies with 422 before touching upstream", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const missingModel = await post(harness.url, "/v1/systemone", REQUEST);
		expect(missingModel.status).toBe(422);
		const badQuestion = await post(harness.url, "/v1/systemone", {
			model: "jev-latest",
			state: "x",
			questions: { q: { type: "essay", instructions: "write" } },
		});
		expect(badQuestion.status).toBe(422);
		const badImages = [
			[{ type: "text", data: PNG_DATA, mimeType: "image/png" }],
			[{ type: "image", data: "https://example.test/image.png", mimeType: "image/png" }],
			[{ type: "image", data: "A==", mimeType: "image/png" }],
			[{ type: "image", data: "AAAA==", mimeType: "image/png" }],
			[{ type: "image", data: "AQ=I", mimeType: "image/png" }],
			[{ type: "image", data: PNG_DATA, mimeType: "text/plain" }],
		];
		for (const images of badImages) {
			const invalidImage = await post(harness.url, "/v1/systemone", {
				model: "jev-latest",
				...REQUEST,
				images,
			});
			expect(invalidImage.status).toBe(422);
		}
		for (const detail of ["medium", null, 42, {}]) {
			const invalidDetail = await post(harness.url, "/v1/systemone", {
				model: "jev-latest",
				...REQUEST,
				images: [{ type: "image", data: PNG_DATA, mimeType: "image/png", detail }],
			});
			expect(invalidDetail.status).toBe(422);
		}
		expect(harness.upstream).toHaveLength(0);
	});

	it("refuses models that do not answer judgments and chat routes refuse judge models", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const chatModel = await post(harness.url, "/v1/systemone", { model: "chat-only", ...REQUEST });
		expect(chatModel.status).toBe(422);
		const unknown = await post(harness.url, "/v1/systemone", { model: "nope", ...REQUEST });
		expect(unknown.status).toBe(404);
		const judgeOnChat = await post(harness.url, "/v1/chat/completions", {
			model: "jev-latest",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(judgeOnChat.status).toBe(400);
		expect(await judgeOnChat.json()).toMatchObject({ error: { message: expect.stringContaining("/v1/systemone") } });
		expect(harness.upstream).toHaveLength(0);
	});

	it("splits judgments above the routed model's catalog question cap", async () => {
		harness = await boot(init => {
			const ids = Object.keys(JSON.parse(String(init?.body)).questions);
			if (ids.length > 16) return new Response("too many questions", { status: 422 });
			return Response.json({
				model: "openjev-4b",
				answers: Object.fromEntries(ids.map(id => [id, { type: "noul", noul: 0.5 }])),
				usage: { input_tokens: 10, output_tokens: 1 },
			});
		});
		const questions = Object.fromEntries(
			Array.from({ length: 20 }, (_, i) => [`q${i}`, { type: "noul", instructions: `Question ${i}?` }]),
		);
		const response = await post(harness.url, "/v1/systemone", { model: "openjev-4b", state: "s", questions });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { answers: Record<string, unknown> };
		expect(Object.keys(body.answers).sort()).toEqual(Object.keys(questions).sort());
		const sizes = harness.upstream.map(call => Object.keys(JSON.parse(String(call.init?.body)).questions).length);
		expect(sizes.sort((a, b) => b - a)).toEqual([16, 4]);
	});

	it("records the usage of chunks that succeeded when a split judgment fails", async () => {
		harness = await boot(init => {
			const ids = Object.keys(JSON.parse(String(init?.body)).questions);
			if (ids.includes("q32")) return new Response("bad chunk", { status: 400 });
			return Response.json({
				model: "openjev-4b",
				answers: Object.fromEntries(ids.map(id => [id, { type: "noul", noul: 0.5 }])),
				usage: { input_tokens: 10, output_tokens: 1 },
			});
		});
		const recorded: { usage: { input: number; output: number } }[] = [];
		vi.spyOn(harness.storage.usage, "observe").mockImplementation(entry => {
			recorded.push(entry);
		});
		const questions = Object.fromEntries(
			Array.from({ length: 40 }, (_, i) => [`q${i}`, { type: "noul", instructions: `Question ${i}?` }]),
		);
		const response = await post(harness.url, "/v1/systemone", { model: "openjev-4b", state: "s", questions });
		expect(response.status).toBe(400);
		// Chunks of 16, 16 and 8: the two without q32 were billed upstream.
		expect(recorded).toHaveLength(1);
		expect(recorded[0].usage).toMatchObject({ input: 20, output: 2 });
	});

	it("invalidates the bearer each chunk sent, not the one a sibling rotated to", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const storage = harness.storage;
		const invalidated: string[] = [];
		vi.spyOn(storage.limits, "invalidateMatching").mockImplementation(async (_provider, apiKey) => {
			invalidated.push(apiKey);
			return true;
		});
		vi.spyOn(storage.keys, "getWithCredential").mockImplementation(async () => ({ apiKey: "key-b" }));
		const model = getBundledModel("typesafe", "jev-latest");
		if (!model) throw new Error("expected bundled typesafe/jev-latest");
		const resolve = buildGatewayApiKeyResolver(
			{ storage },
			model,
			"session",
			{ apiKey: "key-a" },
			new AbortController().signal,
			"systemone",
			"peer",
		);
		const forbidden = Object.assign(new Error("403 forbidden"), { status: 403 });
		// Chunk 1 fails with key-a and rotates the shared resolver to key-b.
		expect(await resolve({ lastChance: true, error: forbidden, previousKey: "key-a" })).toMatchObject({
			apiKey: "key-b",
		});
		// Chunk 2's 403 arrives later, but it too was sent with key-a.
		await resolve({ lastChance: true, error: forbidden, previousKey: "key-a" });
		expect(invalidated).toEqual(["key-a", "key-a"]);
	});

	it("maps upstream failures onto TypeSafe's status codes", async () => {
		harness = await boot(() => new Response(JSON.stringify({ error: "overloaded" }), { status: 529 }));
		const response = await post(harness.url, "/v1/systemone", { model: "jev-latest", ...REQUEST });
		expect(response.status).toBe(529);
		// 529 is transient: the client retried before giving up.
		expect(harness.upstream.length).toBeGreaterThan(1);
	});
});
