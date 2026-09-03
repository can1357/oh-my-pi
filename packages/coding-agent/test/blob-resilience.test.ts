import { afterEach, describe, expect, it } from "bun:test";
import type { Context, ImageContent, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { type BlobBackend, LocalBlobBackend } from "../src/blob-broker/broker";
import { probeExposureHealth } from "../src/blob-broker/exposure";
import type { BlobBrokerWorkerConfig } from "../src/blob-broker/protocol";
import type { BlobPublication } from "../src/blob-broker/publication";
import { FallbackBlobBackend, ImageUrlService } from "../src/blob-broker/service";
import type { LazyBlobFetcher } from "../src/blob-broker/store";

const IMAGE_BYTES = new Uint8Array(Buffer.from("resilient-image"));
const IMAGE_B64 = Buffer.from(IMAGE_BYTES).toString("base64");
const cleanups: Array<() => void> = [];

type ProbeFetch = (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => Promise<Response>;

function injectedFetch(implementation: ProbeFetch): typeof globalThis.fetch {
	return Object.assign(implementation, { preconnect: globalThis.fetch.preconnect });
}

function publication(destination: "direct" | "chevereto", url: string): BlobPublication {
	return { destination, url, bytes: IMAGE_BYTES.byteLength };
}

const model: Model = buildModel({
	id: "resilience-model",
	name: "Resilience Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_192,
});

function imageContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: [{ type: "image", data: IMAGE_B64, mimeType: "image/png" }],
				timestamp: 0,
			},
		],
	};
}

function onlyImage(context: Context): ImageContent {
	const message = context.messages[0];
	if (!message || !Array.isArray(message.content)) throw new Error("missing image message");
	const image = message.content.find(block => block.type === "image");
	if (image?.type !== "image") throw new Error("missing image block");
	return image;
}

interface UploadEdge {
	readonly origin: string;
	readonly uploadSizes: number[];
}

function startUploadEdge(): UploadEdge {
	const uploadSizes: number[] = [];
	let origin = "";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			const url = new URL(request.url);
			if (url.pathname === "/.well-known/omp-blob-health") {
				return new Response(null, { status: 204 });
			}
			if (url.pathname === "/upload" && request.method === "POST") {
				const form = await request.formData();
				const source = form.get("source");
				if (!(source instanceof File)) return new Response("missing source", { status: 400 });
				uploadSizes.push(source.size);
				return Response.json({
					image: { id: `upload-${uploadSizes.length}`, url: `${origin}/uploaded/${uploadSizes.length}.png` },
				});
			}
			return new Response(null, { status: 404 });
		},
	});
	server.unref();
	origin = `http://127.0.0.1:${server.port}`;
	cleanups.push(() => server.stop(true));
	return { origin, uploadSizes };
}

function directConfig(origin?: string): BlobBrokerWorkerConfig {
	return {
		kind: "direct",
		options: {},
		credentials: {},
		bindHost: "127.0.0.1",
		...(origin ? { publicBaseUrl: origin } : {}),
	};
}

function cheveretoConfig(origin: string): BlobBrokerWorkerConfig {
	return {
		kind: "chevereto",
		options: { endpoint: `${origin}/upload` },
		credentials: { apiKey: "test-key" },
		bindHost: "127.0.0.1",
	};
}

function service(configs: readonly BlobBrokerWorkerConfig[]): ImageUrlService {
	const instance = new ImageUrlService(process.cwd(), configs, { daemon: false });
	cleanups.push(() => instance.stop());
	return instance;
}

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("public exposure health", () => {
	it("serves the private health route from the local blob origin", async () => {
		const backend = new LocalBlobBackend(directConfig());
		cleanups.push(() => backend.stop());

		const baseUrl = await backend.ensureStarted();
		expect(baseUrl).not.toBeNull();
		expect((await fetch(`${baseUrl}/.well-known/omp-blob-health?nonce=test`)).status).toBe(204);
	});

	it("waits for delayed readiness and cache-busts every attempt", async () => {
		const urls: string[] = [];
		let calls = 0;
		const fetch = injectedFetch(async (input, init) => {
			urls.push(String(input));
			expect(init?.cache).toBe("no-store");
			calls++;
			return new Response(null, { status: calls === 3 ? 204 : 503 });
		});

		await probeExposureHealth("https://edge.example/base/", fetch, {
			attempts: 3,
			backoffMs: 0,
			timeoutMs: 50,
		});

		expect(urls).toHaveLength(3);
		expect(urls.map(value => new URL(value).pathname)).toEqual([
			"/.well-known/omp-blob-health",
			"/.well-known/omp-blob-health",
			"/.well-known/omp-blob-health",
		]);
		expect(new Set(urls.map(value => new URL(value).searchParams.get("nonce"))).size).toBe(3);
	});

	it("rejects an explicit non-204 response after the bounded attempts", async () => {
		let calls = 0;
		const fetch = injectedFetch(async () => {
			calls++;
			return new Response(null, { status: 200 });
		});

		await expect(
			probeExposureHealth("https://edge.example", fetch, { attempts: 2, backoffMs: 0, timeoutMs: 50 }),
		).rejects.toThrow("Exposure health probe for https://edge.example failed with status HTTP 200");
		expect(calls).toBe(2);
	});

	it("reports a timed-out edge without waiting between attempts", async () => {
		const signals: AbortSignal[] = [];
		const fetch = injectedFetch(async (_input, init) => {
			if (init?.signal instanceof AbortSignal) signals.push(init.signal);
			throw new DOMException("edge timed out", "TimeoutError");
		});

		await expect(
			probeExposureHealth("https://edge.example", fetch, { attempts: 2, backoffMs: 0, timeoutMs: 50 }),
		).rejects.toThrow("Exposure health probe for https://edge.example failed with status timeout");
		expect(signals).toHaveLength(2);
	});
});

describe("FallbackBlobBackend", () => {
	it("publishes sequentially after a throwing backend and materializes bytes once", async () => {
		const calls: string[] = [];
		let byteCalls = 0;
		const first: BlobBackend = {
			supportsLazy: false,
			async ensureBlob(_key, _mimeType, getBytes) {
				calls.push("first");
				expect(getBytes()).toEqual(IMAGE_BYTES);
				throw new Error("dead backend");
			},
			async ensureLazy() {
				return null;
			},
			stop() {},
		};
		const second: BlobBackend = {
			supportsLazy: false,
			async ensureBlob(_key, _mimeType, getBytes) {
				calls.push("second");
				expect(getBytes()).toEqual(IMAGE_BYTES);
				return publication("chevereto", "https://healthy.example/image.png");
			},
			async ensureLazy() {
				return null;
			},
			stop() {},
		};
		const backend = new FallbackBlobBackend([first, second]);

		expect(
			await backend.ensureBlob("image-key", "image/png", () => {
				byteCalls++;
				return IMAGE_BYTES;
			}),
		).toEqual(publication("chevereto", "https://healthy.example/image.png"));
		expect(calls).toEqual(["first", "second"]);
		expect(byteCalls).toBe(1);
	});

	it("tries lazy-capable backends sequentially without invoking the producer", async () => {
		const calls: string[] = [];
		let producerCalls = 0;
		const fetcher: LazyBlobFetcher = async () => {
			producerCalls++;
			return IMAGE_BYTES;
		};
		const unsupported: BlobBackend = {
			supportsLazy: false,
			async ensureBlob() {
				return null;
			},
			async ensureLazy() {
				throw new Error("unsupported backend must be skipped");
			},
			stop() {},
		};
		const dead: BlobBackend = {
			supportsLazy: true,
			async ensureBlob() {
				return null;
			},
			async ensureLazy(_key, _mimeType, receivedFetcher) {
				calls.push("dead");
				expect(receivedFetcher).toBe(fetcher);
				throw new Error("dead lazy backend");
			},
			stop() {},
		};
		const healthy: BlobBackend = {
			supportsLazy: true,
			async ensureBlob() {
				return null;
			},
			async ensureLazy(_key, _mimeType, receivedFetcher) {
				calls.push("healthy");
				expect(receivedFetcher).toBe(fetcher);
				return publication("direct", "https://healthy.example/lazy.png");
			},
			stop() {},
		};
		const backend = new FallbackBlobBackend([unsupported, dead, healthy]);

		expect(await backend.ensureLazy("lazy-key", "image/png", fetcher)).toEqual(
			publication("direct", "https://healthy.example/lazy.png"),
		);
		expect(calls).toEqual(["dead", "healthy"]);
		expect(producerCalls).toBe(0);
	});
});

describe("ImageUrlService ordered failover", () => {
	it("keeps a healthy publication stable and advances past its destination when rejected", async () => {
		const edge = startUploadEdge();
		const broker = service([cheveretoConfig(edge.origin), directConfig(edge.origin)]);
		const pristine = imageContext();

		const first = await broker.decorateContext(pristine, model);
		const firstUrl = onlyImage(first).url;
		expect(firstUrl).toBe(`${edge.origin}/uploaded/1.png`);

		const stable = await broker.decorateContext(pristine, model);
		expect(onlyImage(stable).url).toBe(firstUrl);
		expect(edge.uploadSizes).toEqual([IMAGE_BYTES.byteLength]);

		const advanced = await broker.fallbackContext(first, model);
		const advancedImage = onlyImage(advanced);
		expect(advancedImage.url).toMatch(new RegExp(`^${edge.origin.replaceAll(".", "\\.")}/[0-9a-f]{32}\\.png$`));
		expect(advancedImage.url).not.toBe(firstUrl);
		expect(advancedImage.data).toBe(IMAGE_B64);
		expect(edge.uploadSizes).toEqual([IMAGE_BYTES.byteLength]);

		const inline = await broker.fallbackContext(advanced, model);
		expect(onlyImage(inline).data).toBe(IMAGE_B64);
		expect(onlyImage(inline).url).toBeUndefined();
	});

	it("materializes a lazy frame before retrying through the following uploader", async () => {
		const edge = startUploadEdge();
		const broker = service([directConfig(edge.origin), cheveretoConfig(edge.origin)]);
		const frames = await broker.frameSink.framesFor(
			"lazy resilience frame\n".repeat(20),
			snapcompact.resolveShape(),
			1,
		);
		expect(frames).toHaveLength(1);
		const lazyFrame = frames?.[0];
		if (!lazyFrame) throw new Error("missing lazy frame");
		expect(lazyFrame.data).toBe("");
		expect(lazyFrame.url).toMatch(new RegExp(`^${edge.origin.replaceAll(".", "\\.")}/`));
		const context: Context = {
			messages: [{ role: "user", content: [lazyFrame], timestamp: 0 }],
		};

		const recovered = await broker.fallbackContext(context, model);
		const recoveredImage = onlyImage(recovered);
		expect(recoveredImage.url).toBe(`${edge.origin}/uploaded/1.png`);
		expect(recoveredImage.data.length).toBeGreaterThan(0);
		expect(edge.uploadSizes).toEqual([Buffer.from(recoveredImage.data, "base64").byteLength]);
	});
});
