import { afterEach, describe, expect, it, vi } from "bun:test";
import { SafeDiscoveryError, safeDiscoverModels } from "@oh-my-pi/pi-ai/auth-gateway/safe-discovery";

afterEach(() => {
	vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function stubFetch(response: Response) {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(Object.assign(async () => response, { preconnect: fetch.preconnect }));
}

function forbidFetch() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async () => {
				throw new Error("fetch must not be called");
			},
			{ preconnect: fetch.preconnect },
		),
	);
}

describe("safeDiscoverModels", () => {
	it("rejects http without allowHttp (negative)", async () => {
		const fetchSpy = forbidFetch();
		await expect(safeDiscoverModels("http://example.com")).rejects.toBeInstanceOf(SafeDiscoveryError);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects http://127.0.0.1/models without allowPrivate (negative)", async () => {
		const fetchSpy = forbidFetch();
		await expect(safeDiscoverModels("http://127.0.0.1/models", { allowHttp: true })).rejects.toBeInstanceOf(
			SafeDiscoveryError,
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns data[] when allowHttp and allowPrivate are set", async () => {
		const fetchSpy = stubFetch(jsonResponse({ data: [{ id: "m" }] }));
		const models = await safeDiscoverModels("http://127.0.0.1/models", {
			allowHttp: true,
			allowPrivate: true,
		});
		expect(models).toEqual([{ id: "m" }]);
		expect(models).toHaveLength(1);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const init = fetchSpy.mock.calls[0]?.[1];
		expect(init?.method).toBe("GET");
		expect(init?.redirect).toBe("error");
	});

	it("rejects non-http(s) schemes (negative)", async () => {
		const fetchSpy = forbidFetch();
		await expect(safeDiscoverModels("ftp://example.com/models")).rejects.toBeInstanceOf(SafeDiscoveryError);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects 10/8, 192.168/16, 169.254/16, 0.0.0.0, localhost, and ::1 (negative)", async () => {
		const fetchSpy = forbidFetch();
		const hosts = ["10.1.2.3", "192.168.0.1", "169.254.1.1", "0.0.0.0", "localhost", "[::1]"];
		for (const host of hosts) {
			await expect(safeDiscoverModels(`https://${host}/models`)).rejects.toBeInstanceOf(SafeDiscoveryError);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("accepts a top-level JSON array", async () => {
		stubFetch(jsonResponse([{ id: "a" }, { id: "b" }]));
		const models = await safeDiscoverModels("https://example.com/v1/models");
		expect(models).toEqual([{ id: "a" }, { id: "b" }]);
	});

	it("throws when JSON is neither an array nor {data: array} (negative)", async () => {
		stubFetch(jsonResponse({ models: [{ id: "m" }] }));
		await expect(safeDiscoverModels("https://example.com/v1/models")).rejects.toBeInstanceOf(SafeDiscoveryError);
	});

	it("throws when content-length exceeds maxBytes (negative)", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () => {
					return new Response("[]", {
						status: 200,
						headers: { "content-length": "1000001", "content-type": "application/json" },
					});
				},
				{ preconnect: fetch.preconnect },
			),
		);
		await expect(safeDiscoverModels("https://example.com/v1/models")).rejects.toBeInstanceOf(SafeDiscoveryError);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("throws when the body exceeds maxBytes while reading (negative)", async () => {
		const payload = new TextEncoder().encode("abcdefghij");
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () => {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(payload.subarray(0, 4));
							controller.enqueue(payload.subarray(4));
							controller.close();
						},
					});
					return new Response(stream, { status: 200 });
				},
				{ preconnect: fetch.preconnect },
			),
		);
		await expect(safeDiscoverModels("https://example.com/v1/models", { maxBytes: 8 })).rejects.toBeInstanceOf(
			SafeDiscoveryError,
		);
	});

	it("throws when the list exceeds maxModels (negative)", async () => {
		stubFetch(jsonResponse({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }));
		await expect(safeDiscoverModels("https://example.com/v1/models", { maxModels: 2 })).rejects.toBeInstanceOf(
			SafeDiscoveryError,
		);
	});
});
