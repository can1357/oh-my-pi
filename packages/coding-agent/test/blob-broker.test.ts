import { afterAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { LocalBlobBackend } from "../src/blob-broker/broker";
import { contextHasImageUrls, supportsRemoteImageUrls } from "../src/blob-broker/context-images";
import { ImageUrlService } from "../src/blob-broker/service";
import { type BlobPersistence, BlobRegistry } from "../src/blob-broker/store";
import { wrapStreamFnWithBlobUrlFallback } from "../src/blob-broker/stream-fallback";
import { createCommandUploader, extractUploadUrl, splitCommandTemplate } from "../src/blob-broker/uploaders";
import { BlobStore as SessionBlobStore } from "../src/session/blob-store";

const PNG_B64 = Buffer.from("blob-broker-test-bytes-1").toString("base64");
const OTHER_B64 = Buffer.from("blob-broker-test-bytes-2").toString("base64");

function makeModel(api: string, provider: string): Model {
	return buildModel({
		id: "test-model",
		name: "Test Model",
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
	});
}

const anthropicModel = makeModel("anthropic-messages", "anthropic");

function makeContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: PNG_B64, mimeType: "image/png" },
				],
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "screenshot",
				content: [{ type: "image", data: OTHER_B64, mimeType: "image/jpeg" }],
				isError: false,
				timestamp: 0,
			},
		],
	};
}

const cleanups: Array<() => void> = [];

function makeService(): ImageUrlService {
	const service = new ImageUrlService(
		process.cwd(),
		[{ kind: "direct", options: {}, credentials: {}, bindHost: "127.0.0.1" }],
		{ daemon: false },
	);
	cleanups.push(() => service.stop());
	return service;
}

afterAll(() => {
	for (const cleanup of cleanups) cleanup();
});

describe("LocalBlobBackend (serve mode)", () => {
	it("serves registered blobs over HTTP with stable per-content urls", async () => {
		const backend = new LocalBlobBackend({ kind: "direct", options: {}, credentials: {}, bindHost: "127.0.0.1" });
		cleanups.push(() => backend.stop());
		const bytes = new Uint8Array(Buffer.from(PNG_B64, "base64"));

		const publication = await backend.ensureBlob("key-1", "image/png", () => bytes);
		expect(publication).toMatchObject({ destination: "direct", bytes: bytes.byteLength });
		expect(publication?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\.png$/);
		// Same content key → same publication (byte-identical resend, provider caches)
		// — resolved via lookup, without invoking the bytes thunk again.
		expect(
			await backend.ensureBlob("key-1", "image/png", () => {
				throw new Error("bytes must not be re-materialized on a key hit");
			}),
		).toEqual(publication);
		expect(await backend.ensureBlob("key-2", "image/jpeg", () => bytes)).not.toEqual(publication);

		const response = await fetch(publication?.url ?? "", {
			headers: { "user-agent": "OpenAI File Downloader", "openai-internal-smokescreener": "responses-role" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
		expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(PNG_B64);

		// OpenAI fetches every image twice; the second GET must serve identically.
		const again = await fetch(publication?.url ?? "");
		expect(Buffer.from(await again.arrayBuffer()).toString("base64")).toBe(PNG_B64);

		const head = await fetch(publication?.url ?? "", { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));

		const url = publication?.url ?? "";
		const base = url.slice(0, url.lastIndexOf("/"));
		expect((await fetch(`${base}/${"0".repeat(32)}.png`)).status).toBe(404);
		expect((await fetch(`${base}/anything`, { method: "POST" })).status).toBe(405);
	});
});

describe("BlobRegistry lazy blobs", () => {
	it("registers lazily without rendering and lets re-registration swap the fetcher", async () => {
		const store = new BlobRegistry();
		let renders = 0;
		const entry = store.registerLazy("lazy-1", "image/png", async () => {
			renders++;
			return new Uint8Array(Buffer.from("0123456789"));
		});
		// Registration renders nothing.
		expect(renders).toBe(0);
		expect(entry.bytes).toBe(0);
		// Re-registration keeps the token (URL stability across session restarts)
		// but replaces the fetcher with the newest source.
		expect(store.registerLazy("lazy-1", "image/png", async () => null).path).toBe(entry.path);

		const response = await store.serve(new Request(`http://blob.local/${entry.path}`));
		// The replacement fetcher answers (and reports the source gone): 410, and
		// the original fetcher was never invoked.
		expect(response.status).toBe(410);
		expect(renders).toBe(0);
	});

	it("evicts resident bytes only, re-rendering lazy blobs on the next fetch", async () => {
		const store = new BlobRegistry({ maxBytes: 10 });
		let renders = 0;
		const bytes = new Uint8Array(Buffer.from("0123456789"));
		const lazyEntry = store.registerLazy("lazy", "image/png", async () => {
			renders++;
			return bytes;
		});
		expect(lazyEntry.bytes).toBe(0);
		const request = () => new Request(`http://blob.local/${lazyEntry.path}`);

		expect(await (await store.serve(request())).arrayBuffer()).toEqual(bytes.buffer as ArrayBuffer);
		expect(renders).toBe(1);
		// Second fetch is served from resident bytes.
		await store.serve(request());
		expect(renders).toBe(1);
		// A new blob over budget evicts the lazy blob's bytes; entry survives.
		const eagerEntry = await store.registerBytes("eager", "image/png", new Uint8Array(Buffer.from("0123456789")));
		expect(eagerEntry.bytes).toBe(bytes.byteLength);
		expect((await store.serve(request())).status).toBe(200);
		expect(renders).toBe(2);
	});

	it("responds 410 when a lazy source is gone", async () => {
		const store = new BlobRegistry();
		const entry = store.registerLazy("gone", "image/png", async () => null);
		expect(entry.bytes).toBe(0);
		const response = await store.serve(new Request(`http://blob.local/${entry.path}`));
		expect(response.status).toBe(410);
	});
});

describe("BlobRegistry persistence", () => {
	let persistSeq = 0;
	function makePersist(ttlMs: number): BlobPersistence {
		const dir = path.join(os.tmpdir(), `omp-blob-registry-${process.pid}-${persistSeq++}`);
		fs.mkdirSync(dir, { recursive: true });
		cleanups.push(() => void fs.promises.rm(dir, { recursive: true, force: true }));
		return { blobsDir: dir, indexPath: path.join(dir, "urls-index.json"), ttlMs };
	}

	it("keeps the same link across registry restarts, serving bytes from the blob store", async () => {
		const persist = makePersist(60_000);
		const bytes = new Uint8Array(Buffer.from("resume-stable-bytes"));

		const first = new BlobRegistry({ persist });
		const entry = await first.registerBytes("conv-image", "image/png", bytes);
		expect(entry.bytes).toBe(bytes.byteLength);
		first.flush();

		// A fresh registry (daemon restart / conversation resume) resolves the
		// same key to the same token without needing the bytes again…
		const second = new BlobRegistry({ persist });
		const resumed = second.lookup("conv-image");
		expect(resumed?.path).toBe(entry.path);
		expect(resumed?.bytes).toBe(bytes.byteLength);
		// …and serves the content from the content-addressed store on disk.
		const served = await second.serve(new Request(`http://blob.local/${entry.path}`));
		expect(served.status).toBe(200);
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
	});

	it("expires links after the serving window and mints a new token on re-registration", async () => {
		let clock = 1_000_000;
		const registry = new BlobRegistry({ persist: makePersist(150), now: () => clock });
		const bytes = new Uint8Array(Buffer.from("short-lived"));
		const entry = await registry.registerBytes("ttl-image", "image/png", bytes);
		expect(entry.bytes).toBe(bytes.byteLength);

		clock += 260;
		expect((await registry.serve(new Request(`http://blob.local/${entry.path}`))).status).toBe(410);
		expect(registry.lookup("ttl-image")).toBeNull();
		// A post-expiry re-registration is a fresh link.
		expect((await registry.registerBytes("ttl-image", "image/png", bytes)).path).not.toBe(entry.path);
	});

	it("re-arms the window on registration, not on fetch", async () => {
		let clock = 1_000_000;
		const registry = new BlobRegistry({ persist: makePersist(800), now: () => clock });
		const bytes = new Uint8Array(Buffer.from("refreshed"));
		const entry = await registry.registerBytes("resumed-image", "image/png", bytes);
		expect(entry.bytes).toBe(bytes.byteLength);

		clock += 500;
		// The resumed conversation re-registers (lookup hit) → window re-armed.
		const resumed = registry.lookup("resumed-image");
		expect(resumed?.path).toBe(entry.path);
		expect(resumed?.bytes).toBe(bytes.byteLength);
		clock += 500;
		// 1000ms since first post (> ttl) but 500ms since refresh: still alive.
		expect((await registry.serve(new Request(`http://blob.local/${entry.path}`))).status).toBe(200);
	});

	it("serves images the session store already externalized without rewriting them", async () => {
		const persist = makePersist(60_000);
		const sessionStore = new SessionBlobStore(persist.blobsDir);
		const bytes = Buffer.from("already-externalized");
		const { hash } = await sessionStore.put(bytes);

		const registry = new BlobRegistry({ persist });
		const entry = await registry.registerBytes("session-image", "image/png", new Uint8Array(bytes));
		expect(entry.bytes).toBe(bytes.byteLength);
		const served = await registry.serve(new Request(`http://blob.local/${entry.path}`));
		expect(served.status).toBe(200);
		expect(Buffer.from(await served.arrayBuffer()).toString()).toBe("already-externalized");
		// Same content address: registration reused the existing blob file.
		expect(await sessionStore.has(hash)).toBe(true);
	});
});

describe("ImageUrlService", () => {
	it("decorates gated models, dedups by content, and leaves quarantined providers inline", async () => {
		const service = makeService();
		const context = makeContext();

		const decorated = await service.decorateContext(context, anthropicModel);
		expect(decorated).not.toBe(context);
		const [user, toolResult] = decorated.messages;
		if (user.role !== "user" || typeof user.content === "string") throw new Error("unexpected shape");
		const image = user.content[1];
		if (image.type !== "image") throw new Error("unexpected block");
		expect(image.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
		expect(image.data).toBe(PNG_B64);
		if (toolResult.role !== "toolResult") throw new Error("unexpected shape");
		const toolImage = toolResult.content[0];
		if (toolImage.type !== "image") throw new Error("unexpected block");
		expect(toolImage.url).toMatch(/\.jpg$/);

		// Same bytes on the next turn resolve to the same url.
		const again = await service.decorateContext(makeContext(), anthropicModel);
		const againUser = again.messages[0];
		if (againUser.role !== "user" || typeof againUser.content === "string") throw new Error("unexpected shape");
		const againImage = againUser.content[1];
		if (againImage.type !== "image") throw new Error("unexpected block");
		expect(againImage.url).toBe(image.url);

		// Non-fetching API: untouched context, by reference.
		expect(await service.decorateContext(context, makeModel("ollama-chat", "ollama"))).toBe(context);

		service.quarantine("anthropic", "test");
		expect(await service.decorateContext(context, anthropicModel)).toBe(context);
	});

	it("serves lazy snapcompact frames on fetch and materializes them for inline retries", async () => {
		const service = makeService();
		const shape = snapcompact.resolveShape();
		const text = "lazy frame body\n".repeat(40);

		const frames = await service.frameSink.framesFor(text, shape, 2);
		expect(frames).not.toBeNull();
		for (const frame of frames ?? []) {
			expect(frame.data).toBe("");
			expect(frame.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
			expect(frame.mimeType).toBe("image/png");
		}

		// Fetching the URL triggers the render and yields a real PNG.
		const served = await fetch((frames ?? [])[0].url as string);
		expect(served.status).toBe(200);
		const bytes = new Uint8Array(await served.arrayBuffer());
		expect(bytes.byteLength).toBeGreaterThan(8);
		expect(Array.from(bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]); // "PNG"

		// Inline retry: placeholder frames gain data and lose their urls.
		const context: Context = {
			messages: [{ role: "user", content: [{ type: "text", text: "ctx" }, ...(frames ?? [])], timestamp: 0 }],
		};
		const inlined = await service.inlineContext(context);
		expect(contextHasImageUrls(inlined)).toBe(false);
		const user = inlined.messages[0];
		if (user.role !== "user" || typeof user.content === "string") throw new Error("unexpected shape");
		const restored = user.content[1];
		if (restored.type !== "image") throw new Error("unexpected block");
		expect(restored.data.length).toBeGreaterThan(0);
	});
});

describe("supportsRemoteImageUrls", () => {
	it("admits verified url-fetching surfaces and refuses shared-API lookalikes", () => {
		expect(supportsRemoteImageUrls(anthropicModel)).toBe(true);
		expect(supportsRemoteImageUrls(makeModel("openai-codex-responses", "openai-codex"))).toBe(true);
		expect(supportsRemoteImageUrls(makeModel("openai-responses", "xai"))).toBe(true);
		expect(supportsRemoteImageUrls(makeModel("google-gemini-cli", "google-antigravity"))).toBe(true);
		// Same API shape, backend that cannot fetch arbitrary URLs.
		expect(supportsRemoteImageUrls(makeModel("anthropic-messages", "opencode"))).toBe(false);
		// Moonshot-native hosts reject remote image URLs on both transports
		// ("unsupported image url" 400) despite the openai-completions catalog api.
		expect(supportsRemoteImageUrls(makeModel("openai-completions", "kimi-code"))).toBe(false);
		expect(supportsRemoteImageUrls(makeModel("anthropic-messages", "kimi-code"))).toBe(false);
		expect(supportsRemoteImageUrls(makeModel("openai-completions", "moonshot"))).toBe(false);
		expect(supportsRemoteImageUrls(makeModel("google-gemini-cli", "google-gemini-cli"))).toBe(false);
		expect(supportsRemoteImageUrls(makeModel("bedrock-converse-stream", "amazon-bedrock"))).toBe(false);
	});
});

describe("uploaders", () => {
	it("splits command templates with quotes and substitutes after splitting", () => {
		expect(splitCommandTemplate(`pasta -b -f {file}`)).toEqual(["pasta", "-b", "-f", "{file}"]);
		expect(splitCommandTemplate(`up --name "two words" '{file}'`)).toEqual(["up", "--name", "two words", "{file}"]);
		expect(splitCommandTemplate(`a\\ b c`)).toEqual(["a b", "c"]);
	});

	it("extracts the last url on stdout and trims trailing punctuation", () => {
		expect(extractUploadUrl("uploading...\ndone: https://i.example/x.png.\n")).toBe("https://i.example/x.png");
		expect(extractUploadUrl("progress 10%\nprogress 99%")).toBeNull();
	});

	it("runs a command uploader end to end against a stub binary", async () => {
		const stub = path.join(os.tmpdir(), `omp-test-uploader-${process.pid}.sh`);
		await Bun.write(
			stub,
			`#!/bin/sh\ntest -s "$2" || exit 3\necho "uploaded $2"\necho "https://files.example/abc.$3"\n`,
		);
		await fs.promises.chmod(stub, 0o755);
		cleanups.push(() => void fs.promises.rm(stub, { force: true }));

		const uploader = createCommandUploader(`${stub} --x {file} {ext}`);
		const publication = await uploader.upload({
			bytes: new Uint8Array(Buffer.from("payload")),
			mimeType: "image/png",
			extension: "png",
		});
		expect(publication).toEqual({
			url: "https://files.example/abc.png",
			destination: "command",
			bytes: 7,
		});
	});

	it("rejects command uploads when the project directory becomes inaccessible", async () => {
		const projectDir = getProjectDir();
		const accessSync = fs.accessSync;
		const access = vi.spyOn(fs, "accessSync").mockImplementation((target, mode) => {
			if (target === projectDir) {
				throw Object.assign(new Error("operation not permitted"), { code: "EACCES" });
			}
			return accessSync(target, mode);
		});
		const uploader = createCommandUploader(
			`${process.execPath} -e "console.log('https://files.example/' + process.cwd())" {file}`,
		);
		try {
			await expect(
				uploader.upload({
					bytes: new Uint8Array(Buffer.from("payload")),
					mimeType: "image/png",
					extension: "png",
				}),
			).rejects.toThrow(`Project directory is not accessible: ${projectDir}`);
		} finally {
			access.mockRestore();
		}
	});
});

function errorMessage(message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: 0,
	};
}

function doneMessage(): AssistantMessage {
	return { ...errorMessage(""), stopReason: "stop", errorMessage: undefined };
}

function streamOf(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	for (const event of events) stream.push(event);
	return stream;
}

describe("wrapStreamFnWithBlobUrlFallback", () => {
	it("retries an error-first decorated request inline and quarantines on success", async () => {
		const service = makeService();
		const calls: Context[] = [];
		const done = doneMessage();
		const base = (_model: Model, context: Context) => {
			calls.push(context);
			if (calls.length === 1) {
				return streamOf([
					{ type: "start", partial: errorMessage("") },
					{ type: "error", reason: "error", error: errorMessage("Could not fetch image") },
				]);
			}
			return streamOf([
				{ type: "start", partial: done },
				{ type: "done", reason: "stop", message: done },
			]);
		};
		const wrapped = wrapStreamFnWithBlobUrlFallback(base as never, service);

		const decorated = await service.decorateContext(makeContext(), anthropicModel);
		const stream = await wrapped(anthropicModel, decorated, undefined);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);

		expect(calls).toHaveLength(2);
		expect(contextHasImageUrls(calls[0])).toBe(true);
		expect(contextHasImageUrls(calls[1])).toBe(false);
		expect(events.map(event => event.type)).toEqual(["start", "done"]);
		expect((await stream.result()).stopReason).toBe("stop");
		expect(service.isQuarantined("anthropic")).toBe(true);
	});

	it("does not retry once content streamed, and passes undecorated contexts through", async () => {
		const service = makeService();
		const calls: Context[] = [];
		const partial = errorMessage("");
		const base = (_model: Model, context: Context) => {
			calls.push(context);
			return streamOf([
				{ type: "start", partial },
				{ type: "text_start", contentIndex: 0, partial },
				{ type: "error", reason: "error", error: errorMessage("mid-stream failure") },
			]);
		};
		const wrapped = wrapStreamFnWithBlobUrlFallback(base as never, service);

		const decorated = await service.decorateContext(makeContext(), anthropicModel);
		const stream = await wrapped(anthropicModel, decorated, undefined);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(calls).toHaveLength(1);
		expect(service.isQuarantined("anthropic")).toBe(false);

		// No urls in the context → wrapper is a pass-through, single call.
		const plain = makeContext();
		const passStream = await wrapped(anthropicModel, plain, undefined);
		expect((await passStream.result()).stopReason).toBe("error");
		expect(calls).toHaveLength(2);
		expect(calls[1]).toBe(plain);
	});
});
