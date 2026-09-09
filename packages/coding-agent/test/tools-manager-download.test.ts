import { afterEach, describe, expect, it, vi } from "bun:test";
import { downloadFile } from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
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

		const download = downloadFile("https://example.test/tool.bin", dest, controller.signal);
		await stalled.promise;
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));

		await expect(download).rejects.toThrow("Download timed out: https://example.test/tool.bin");
		expect(await Bun.file(dest).exists()).toBe(false);
	});
});
