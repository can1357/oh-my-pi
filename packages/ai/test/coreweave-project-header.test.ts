import { afterEach, describe, expect, test, vi } from "bun:test";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const COREWEAVE_ENV_KEYS = ["COREWEAVE_PROJECT", "WANDB_INFERENCE_PROJECT", "WANDB_ENTITY", "WANDB_PROJECT"] as const;
const ORIGINAL_ENV = new Map(COREWEAVE_ENV_KEYS.map(key => [key, Bun.env[key]]));

function restoreCoreWeaveEnv(): void {
	for (const key of COREWEAVE_ENV_KEYS) {
		const value = ORIGINAL_ENV.get(key);
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
}

afterEach(() => {
	restoreCoreWeaveEnv();
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function chatSse(): Response {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("CoreWeave Serverless Inference project header", () => {
	const coreWeaveModel = {
		provider: "coreweave",
		id: "zai-org/GLM-5.2",
		baseUrl: "https://api.inference.wandb.ai/v1",
	};

	test("adds OpenAI-Project from COREWEAVE_PROJECT", () => {
		Bun.env.COREWEAVE_PROJECT = "team/project";
		delete Bun.env.WANDB_INFERENCE_PROJECT;
		delete Bun.env.WANDB_ENTITY;
		delete Bun.env.WANDB_PROJECT;

		const setup = resolveOpenAIRequestSetup(coreWeaveModel, {
			apiKey: "coreweave-key",
			messages: [],
		});

		expect(setup.headers["OpenAI-Project"]).toBe("team/project");
	});

	test("builds OpenAI-Project from W&B entity and project fallbacks", () => {
		delete Bun.env.COREWEAVE_PROJECT;
		delete Bun.env.WANDB_INFERENCE_PROJECT;
		Bun.env.WANDB_ENTITY = "wandb-team";
		Bun.env.WANDB_PROJECT = "inference-project";

		const setup = resolveOpenAIRequestSetup(coreWeaveModel, {
			apiKey: "coreweave-key",
			messages: [],
		});

		expect(setup.headers["OpenAI-Project"]).toBe("wandb-team/inference-project");
	});

	test("preserves an explicit request project header", () => {
		Bun.env.COREWEAVE_PROJECT = "team/project";

		const setup = resolveOpenAIRequestSetup(coreWeaveModel, {
			apiKey: "coreweave-key",
			extraHeaders: { "openai-project": "explicit/team" },
			messages: [],
		});

		expect(setup.headers["openai-project"]).toBe("explicit/team");
		expect(setup.headers["OpenAI-Project"]).toBeUndefined();
	});

	test("uses COREWEAVE_PROJECT when an explicit blank project header is present", () => {
		Bun.env.COREWEAVE_PROJECT = "team/project";

		const setup = resolveOpenAIRequestSetup(coreWeaveModel, {
			apiKey: "coreweave-key",
			extraHeaders: { "openai-project": "   " },
			messages: [],
		});

		expect(setup.headers["OpenAI-Project"]).toBe("team/project");
		expect(setup.headers["openai-project"]).toBeUndefined();
	});

	test("sends one OpenAI-Project header on chat-completions requests when a blank override is present", async () => {
		Bun.env.COREWEAVE_PROJECT = "team/project";
		const requestHeaders: Headers[] = [];
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			requestHeaders.push(new Headers(init?.headers));
			return chatSse();
		});

		await completeSimple(getBundledModel("coreweave", "zai-org/GLM-5.2"), context, {
			apiKey: "coreweave-key",
			fetch: fetchMock,
			headers: { "openai-project": "   " },
		});

		expect(requestHeaders[0]?.get("OpenAI-Project")).toBe("team/project");
	});
});
