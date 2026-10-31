import { afterEach, describe, expect, it, vi } from "bun:test";
import { downloadFile, getLatestVersion } from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function mockDownloadResponse(response: Response): void {
	const fetchMock: typeof globalThis.fetch = Object.assign(async () => response, {
		preconnect: globalThis.fetch.preconnect,
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

describe("tool asset downloads", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes a completed response body to disk", async () => {
		using tempDir = TempDir.createSync("@omp-tool-download-");
		const dest = tempDir.join("tool.bin");
		mockDownloadResponse(new Response("tool-bytes"));

		await downloadFile("https://example.test/tool.bin", dest);

		expect(await Bun.file(dest).text()).toBe("tool-bytes");
	});

	it("aborts a stalled response body and removes the partial file", async () => {
		using tempDir = TempDir.createSync("@omp-tool-download-stall-");
		const dest = tempDir.join("tool.bin");
		const stalled = Promise.withResolvers<void>();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
			},
			pull() {
				stalled.resolve();
			},
		});
		mockDownloadResponse(new Response(body));
		const controller = new AbortController();

		const download = downloadFile("https://example.test/tool.bin", dest, { signal: controller.signal });
		await stalled.promise;
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));

		await expect(download).rejects.toThrow("Download timed out: https://example.test/tool.bin");
		expect(await Bun.file(dest).exists()).toBe(false);
	});
});

describe("github release lookup", () => {
	const TOKEN_ENV = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

	function snapshotTokenEnv(): Record<string, string | undefined> {
		return { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
	}

	function restoreTokenEnv(previous: Record<string, string | undefined>): void {
		for (const name of TOKEN_ENV) {
			const value = previous[name];
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}

	function captureFetch(tag: string): RequestInit[] {
		const requests: RequestInit[] = [];
		const fetchMock: typeof globalThis.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				requests.push(init ?? {});
				return new Response(JSON.stringify({ tag_name: `v${tag}` }));
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		return requests;
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the environment token as a bearer credential", async () => {
		const previous = snapshotTokenEnv();
		delete process.env.GITHUB_TOKEN;
		process.env.GH_TOKEN = "gho_test_token";
		try {
			const requests = captureFetch("1.2.3");

			await expect(getLatestVersion("chmln/sd")).resolves.toBe("1.2.3");

			const headers = requests[0]?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer gho_test_token");
		} finally {
			restoreTokenEnv(previous);
		}
	});

	it("omits the credential when no token is configured", async () => {
		const previous = snapshotTokenEnv();
		for (const name of TOKEN_ENV) {
			delete process.env[name];
		}
		try {
			const requests = captureFetch("1.2.3");

			await expect(getLatestVersion("chmln/sd")).resolves.toBe("1.2.3");

			const headers = requests[0]?.headers as Record<string, string>;
			expect(headers.Authorization).toBeUndefined();
		} finally {
			restoreTokenEnv(previous);
		}
	});
});
