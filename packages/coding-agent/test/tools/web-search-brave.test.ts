import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BraveProvider, searchBrave } from "@oh-my-pi/pi-coding-agent/web/search/providers/brave";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

async function withLocalAuthStorage<T>(run: (authStorage: AuthStorage) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-brave-auth-"));
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	try {
		return await run(authStorage);
	} finally {
		authStorage.close();
		await removeWithRetries(dir);
	}
}

function braveOkResponse(): Response {
	return new Response(
		JSON.stringify({
			web: {
				results: [{ title: "Paris", url: "https://example.com/paris", description: "Capital of France" }],
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json", "x-request-id": "brave-req" } },
	);
}

describe("Brave web search credentials", () => {
	const originalBraveApiKey = process.env.BRAVE_API_KEY;
	const logCalls: string[] = [];

	function captureLog(level: string) {
		return (message: unknown, extra?: unknown) => {
			logCalls.push(`${level}:${typeof message === "string" ? message : JSON.stringify(message)}`);
			if (extra !== undefined) logCalls.push(`${level}-extra:${JSON.stringify(extra)}`);
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
		logCalls.length = 0;
		if (originalBraveApiKey === undefined) {
			delete process.env.BRAVE_API_KEY;
		} else {
			process.env.BRAVE_API_KEY = originalBraveApiKey;
		}
	});

	it("sends the AuthStorage login key even when BRAVE_API_KEY is also set", async () => {
		const storedKey = "stored-brave-search-key";
		process.env.BRAVE_API_KEY = "env-brave-search-key";
		let sentToken: string | undefined;

		const fetchMock: FetchImpl = async (_input, init) => {
			const headers = new Headers(init?.headers);
			sentToken = headers.get("X-Subscription-Token") ?? undefined;
			return braveOkResponse();
		};

		await withLocalAuthStorage(async authStorage => {
			await authStorage.login("brave", {
				onAuth: () => {},
				onPrompt: async () => storedKey,
			});

			const provider = new BraveProvider();
			expect(provider.isAvailable(authStorage)).toBe(true);
			const response = await searchBrave({
				query: "capital of France",
				authStorage,
				fetch: fetchMock,
			});
			expect(response.provider).toBe("brave");
			expect(response.sources[0]?.url).toBe("https://example.com/paris");
		});

		expect(sentToken).toBe(storedKey);
	});

	it("falls back to BRAVE_API_KEY when AuthStorage has no brave credential", async () => {
		const envKey = "env-brave-only-key";
		process.env.BRAVE_API_KEY = envKey;
		let sentToken: string | undefined;

		const fetchMock: FetchImpl = async (_input, init) => {
			const headers = new Headers(init?.headers);
			sentToken = headers.get("X-Subscription-Token") ?? undefined;
			return braveOkResponse();
		};

		await withLocalAuthStorage(async authStorage => {
			expect(authStorage.describeCredentialSource("brave")).toContain("env");
			const response = await searchBrave({
				query: "capital of France",
				authStorage,
				fetch: fetchMock,
			});
			expect(response.provider).toBe("brave");
		});

		expect(sentToken).toBe(envKey);
	});

	it("fails before fetch when brave credentials are missing", async () => {
		delete process.env.BRAVE_API_KEY;
		const fetchMock = vi.fn(() => Promise.resolve(braveOkResponse())) as unknown as FetchImpl;

		await withLocalAuthStorage(async authStorage => {
			await expect(
				searchBrave({
					query: "missing creds",
					authStorage,
					fetch: fetchMock,
				}),
			).rejects.toThrow(
				'Brave credentials not found. Set BRAVE_API_KEY or configure an API key for provider "brave".',
			);
		});

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not leak the brave key in errors or logs", async () => {
		const secret = "BSA-secret-do-not-leak-xyz";
		process.env.BRAVE_API_KEY = secret;
		vi.spyOn(logger, "debug").mockImplementation(captureLog("debug") as typeof logger.debug);
		vi.spyOn(logger, "info").mockImplementation(captureLog("info") as typeof logger.info);
		vi.spyOn(logger, "warn").mockImplementation(captureLog("warn") as typeof logger.warn);
		vi.spyOn(logger, "error").mockImplementation(captureLog("error") as typeof logger.error);

		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ message: "unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});

		await withLocalAuthStorage(async authStorage => {
			try {
				await searchBrave({
					query: "leak check",
					authStorage,
					fetch: fetchMock,
				});
				expect.unreachable("expected searchBrave to throw");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).not.toContain(secret);
			}
			expect(authStorage.describeCredentialSource("brave")).not.toContain(secret);
		});

		expect(logCalls.join("\n")).not.toContain(secret);
	});
});
