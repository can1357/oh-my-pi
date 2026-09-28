import { afterEach, describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const loginCoreWeave = getProviderDefinition("coreweave")?.login;
if (!loginCoreWeave) throw new Error("CoreWeave login is not registered");

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
	vi.restoreAllMocks();
});

describe("CoreWeave Serverless Inference login", () => {
	test("validates API key against the models endpoint with the project header", async () => {
		Bun.env.COREWEAVE_PROJECT = "team/project";
		delete Bun.env.WANDB_INFERENCE_PROJECT;
		delete Bun.env.WANDB_ENTITY;
		delete Bun.env.WANDB_PROJECT;

		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://api.inference.wandb.ai/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({
				"OpenAI-Project": "team/project",
				Authorization: "Bearer coreweave-test-key",
			});
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const authMessages: string[] = [];
		const apiKey = await loginCoreWeave({
			onAuth: auth => {
				if (auth.instructions) {
					authMessages.push(auth.instructions);
				}
			},
			onPrompt: async () => " coreweave-test-key ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("coreweave-test-key");
		expect(authMessages[0]).toContain("COREWEAVE_PROJECT=<team>/<project>");
		expect(authMessages[0]).toContain("~/.zshrc");
		expect(authMessages[0]).toContain("~/.bashrc");
		expect(authMessages[0]).toContain("your shell's profile/rc file");
		expect(authMessages[0]).toContain("OpenAI-Project");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("requires a project header before validating the API key", async () => {
		delete Bun.env.COREWEAVE_PROJECT;
		delete Bun.env.WANDB_INFERENCE_PROJECT;
		delete Bun.env.WANDB_ENTITY;
		delete Bun.env.WANDB_PROJECT;
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const login = loginCoreWeave({
			onPrompt: async () => "coreweave-test-key",
			fetch: fetchMock,
		});

		await expect(login).rejects.toThrow("Set COREWEAVE_PROJECT=<team>/<project>");
		await expect(login).rejects.toThrow("your shell's profile/rc file");
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("surfaces validation errors from the CoreWeave Serverless Inference models endpoint", async () => {
		Bun.env.COREWEAVE_PROJECT = "team/project";
		delete Bun.env.WANDB_INFERENCE_PROJECT;
		delete Bun.env.WANDB_ENTITY;
		delete Bun.env.WANDB_PROJECT;

		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response("Unauthorized", {
				status: 401,
				headers: { "Content-Type": "text/plain" },
			});
		});

		await expect(
			loginCoreWeave({
				onPrompt: async () => "coreweave-test-key",
				fetch: fetchMock,
			}),
		).rejects.toThrow("CoreWeave Serverless Inference API key validation failed (401)");
	});
});
