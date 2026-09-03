import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { KimiProvider, searchKimi } from "@oh-my-pi/pi-coding-agent/web/search/providers/kimi";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const originalMoonshotSearchApiKey = process.env.MOONSHOT_SEARCH_API_KEY;
const originalKimiSearchApiKey = process.env.KIMI_SEARCH_API_KEY;

function restoreSearchApiKeyEnv(): void {
	if (originalMoonshotSearchApiKey === undefined) delete process.env.MOONSHOT_SEARCH_API_KEY;
	else process.env.MOONSHOT_SEARCH_API_KEY = originalMoonshotSearchApiKey;
	if (originalKimiSearchApiKey === undefined) delete process.env.KIMI_SEARCH_API_KEY;
	else process.env.KIMI_SEARCH_API_KEY = originalKimiSearchApiKey;
}

async function withLocalAuthStorage<T>(run: (authStorage: AuthStorage) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-search-kimi-auth-"));
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	try {
		return await run(authStorage);
	} finally {
		authStorage.close();
		await removeWithRetries(dir);
	}
}

describe("KimiProvider availability", () => {
	afterEach(() => {
		restoreSearchApiKeyEnv();
		vi.restoreAllMocks();
	});

	it("does not advertise availability for a stored moonshot Open Platform credential", async () => {
		delete process.env.MOONSHOT_SEARCH_API_KEY;
		delete process.env.KIMI_SEARCH_API_KEY;
		const available = await withLocalAuthStorage(async authStorage => {
			// A Moonshot Open Platform key is a different credential system than the
			// Kimi Code search endpoint (issue #5762) — it must not mark Kimi available.
			await authStorage.set("moonshot", { type: "api_key", key: "moonshot-open-platform-key" });
			return new KimiProvider().isAvailable(authStorage);
		});
		expect(available).toBe(false);
	});

	it("advertises availability for a stored kimi-code credential", async () => {
		delete process.env.MOONSHOT_SEARCH_API_KEY;
		delete process.env.KIMI_SEARCH_API_KEY;
		const available = await withLocalAuthStorage(async authStorage => {
			await authStorage.set("kimi-code", { type: "api_key", key: "kimi-code-console-key" });
			return new KimiProvider().isAvailable(authStorage);
		});
		expect(available).toBe(true);
	});

	it("advertises availability for the explicit search-key env override", async () => {
		process.env.MOONSHOT_SEARCH_API_KEY = "kimi-code-console-key";
		const available = await withLocalAuthStorage(authStorage =>
			Promise.resolve(new KimiProvider().isAvailable(authStorage)),
		);
		expect(available).toBe(true);
	});
});

describe("searchKimi credential resolution", () => {
	afterEach(() => {
		restoreSearchApiKeyEnv();
		vi.restoreAllMocks();
	});

	it("sends the kimi-code credential to the Kimi Code search endpoint", async () => {
		delete process.env.MOONSHOT_SEARCH_API_KEY;
		delete process.env.KIMI_SEARCH_API_KEY;
		let capturedUrl: string | undefined;
		let capturedAuth: string | null | undefined;
		const fetchMock: FetchImpl = (url, init) => {
			capturedUrl = String(url);
			capturedAuth = new Headers(init?.headers).get("Authorization");
			return Promise.resolve(
				new Response(JSON.stringify({ search_results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};

		await withLocalAuthStorage(async authStorage => {
			await authStorage.set("kimi-code", { type: "api_key", key: "kimi-code-console-key" });
			const result = await searchKimi({ query: "kimi docs", authStorage, fetch: fetchMock });
			expect(result.provider).toBe("kimi");
		});

		expect(capturedUrl).toBe("https://api.kimi.com/coding/v1/search");
		expect(capturedAuth).toBe("Bearer kimi-code-console-key");
	});

	it("ignores a stored moonshot credential and reports missing Kimi Code credentials", async () => {
		delete process.env.MOONSHOT_SEARCH_API_KEY;
		delete process.env.KIMI_SEARCH_API_KEY;
		const fetchMock: FetchImpl = () => {
			throw new Error("fetch should not run without a Kimi Code credential");
		};

		await withLocalAuthStorage(async authStorage => {
			await authStorage.set("moonshot", { type: "api_key", key: "moonshot-open-platform-key" });
			await expect(searchKimi({ query: "kimi docs", authStorage, fetch: fetchMock })).rejects.toThrow(/Kimi Code/);
		});
	});
});

describe("searchKimi query directives", () => {
	afterEach(() => {
		restoreSearchApiKeyEnv();
		vi.restoreAllMocks();
	});

	function captureBodyFetch(capture: { body?: { text_query?: string } }): FetchImpl {
		return (_url, init) => {
			capture.body = JSON.parse(String(init?.body)) as { text_query?: string };
			return Promise.resolve(
				new Response(JSON.stringify({ search_results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};
	}

	it("sends directive-free queries upstream unchanged", async () => {
		process.env.KIMI_SEARCH_API_KEY = "test-key";
		const capture: { body?: { text_query?: string } } = {};
		await withLocalAuthStorage(async authStorage => {
			await searchKimi({ query: "bun test runner docs", authStorage, fetch: captureBodyFetch(capture) });
		});
		expect(capture.body?.text_query).toBe("bun test runner docs");
	});

	it("rebuilds directive queries with Bing-style operators and drops date directives", async () => {
		process.env.KIMI_SEARCH_API_KEY = "test-key";
		const capture: { body?: { text_query?: string } } = {};
		await withLocalAuthStorage(async authStorage => {
			await searchKimi({
				query: 'site:github.com intitle:changelog filetype:md after:2024-01-01 "bun runtime" -deprecated',
				authStorage,
				fetch: captureBodyFetch(capture),
			});
		});
		const sent = capture.body?.text_query ?? "";
		expect(sent).toContain("site:github.com");
		expect(sent).toContain("intitle:changelog");
		expect(sent).toContain("filetype:md");
		expect(sent).toContain('"bun runtime"');
		expect(sent).toContain("-deprecated");
		expect(sent).not.toContain("after:");
	});
});
