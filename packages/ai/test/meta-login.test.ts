import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loginMeta, resolveMuseCliAuthKey } from "@pk-nerdsaver-ai/pi-ai/registry/meta";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Meta AI login", () => {
	test("validates the pasted key against the Meta Model API models endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://api.meta.ai/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({
				Authorization: "Bearer LLM|607358788850350|nx9abc",
			});
			return new Response(JSON.stringify({ object: "list", data: [{ id: "muse-spark-1.2" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const authMessages: string[] = [];
		const apiKey = await loginMeta({
			onAuth: auth => {
				authMessages.push(auth.url);
				if (auth.instructions) {
					authMessages.push(auth.instructions);
				}
			},
			onPrompt: async () => "  LLM|607358788850350|nx9abc  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("LLM|607358788850350|nx9abc");
		expect(authMessages[0]).toBe("https://ai.developer.meta.com/docs/muse-code/auth");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("surfaces validation errors from the Meta Model API models endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response("invalid api key", {
				status: 401,
				headers: { "Content-Type": "text/plain" },
			});
		});

		await expect(
			loginMeta({
				onAuth: () => {},
				onPrompt: async () => "LLM|bad",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Meta AI API key validation failed (401)");
	});

	test("resolves Muse CLI auth key from custom config directory", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-auth-test-"));
		try {
			const museDir = path.join(tempDir, "muse");
			fs.mkdirSync(museDir, { recursive: true });
			fs.writeFileSync(
				path.join(museDir, "auth.json"),
				JSON.stringify({
					providers: {
						meta: {
							mechanism: "oauth",
							access_token: "MUSE_SUBS_TOKEN_123",
						},
					},
				}),
			);

			const prev = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = tempDir;
			try {
				expect(resolveMuseCliAuthKey()).toBe("MUSE_SUBS_TOKEN_123");
			} finally {
				if (prev !== undefined) process.env.XDG_CONFIG_HOME = prev;
				else delete process.env.XDG_CONFIG_HOME;
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("loginMeta prompts to import detected Muse CLI subscription key", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-auth-test-"));
		try {
			const museDir = path.join(tempDir, "muse");
			fs.mkdirSync(museDir, { recursive: true });
			fs.writeFileSync(
				path.join(museDir, "auth.json"),
				JSON.stringify({
					providers: {
						meta: {
							mechanism: "oauth",
							access_token: "MUSE_SUBS_TOKEN_IMPORT",
						},
					},
				}),
			);

			const prev = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = tempDir;
			try {
				let step = 0;
				const key = await loginMeta({
					onAuth: () => {},
					onPrompt: async prompt => {
						step++;
						if (step === 1) {
							expect(prompt.message).toContain("Choose authentication method");
							return "1";
						}
						expect(prompt.message).toContain("Found active Muse Code subscription");
						return "Y";
					},
				});
				expect(key).toBe("MUSE_SUBS_TOKEN_IMPORT");
			} finally {
				if (prev !== undefined) process.env.XDG_CONFIG_HOME = prev;
				else delete process.env.XDG_CONFIG_HOME;
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
