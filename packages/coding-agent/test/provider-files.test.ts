import { describe, expect, test } from "bun:test";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	hashProviderFileContent,
	ProviderFileCache,
	type ProviderFileClient,
	type ProviderFileHandle,
} from "@oh-my-pi/pi-coding-agent/blob-broker/provider-file-types";
import {
	type ProviderFileClientFactory,
	ProviderFileManager,
} from "@oh-my-pi/pi-coding-agent/blob-broker/provider-files";
import { createAnthropicFileClient } from "@oh-my-pi/pi-coding-agent/blob-broker/provider-files-anthropic";
import { createGeminiProviderFileClient } from "@oh-my-pi/pi-coding-agent/blob-broker/provider-files-gemini";
import { createOpenAIFileClient } from "@oh-my-pi/pi-coding-agent/blob-broker/provider-files-openai";
import type { FetchImpl } from "@oh-my-pi/pi-coding-agent/blob-broker/uploader-runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

interface RecordedRequest {
	readonly url: string;
	readonly init: RequestInit;
}

function testModel<TApi extends Api>(api: TApi, provider: string, baseUrl: string): Model<TApi> {
	return buildModel({
		id: `${provider}-vision-test`,
		name: `${provider} vision test`,
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

const openAIModel = testModel("openai-responses", "openai", "https://api.openai.com/v1");
const anthropicModel = testModel("anthropic-messages", "anthropic", "https://api.anthropic.com");
const geminiModel = testModel("google-generative-ai", "google", "https://generativelanguage.googleapis.com/v1beta");
const unsupportedModel = testModel("openai-responses", "openrouter", "https://openrouter.ai/api/v1");

function scriptedFetch(responses: readonly Response[]): {
	readonly fetch: FetchImpl;
	readonly requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	let responseIndex = 0;
	return {
		requests,
		fetch: async (input, init = {}) => {
			const url = input instanceof Request ? input.url : String(input);
			requests.push({ url, init });
			const response = responses[responseIndex++];
			if (!response) throw new Error(`Unexpected request ${url}`);
			return response;
		},
	};
}

function normalizedHeaders(init: RequestInit): Record<string, string> {
	return Object.fromEntries(new Headers(init.headers).entries());
}

function requireFormData(init: RequestInit): FormData {
	if (!(init.body instanceof FormData)) throw new Error("Expected multipart request body");
	return init.body;
}

function requireFile(value: string | File | null): File {
	if (!(value instanceof File)) throw new Error("Expected multipart file field");
	return value;
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolvePromise: (value: T | PromiseLike<T>) => void = () => {
		throw new Error("Deferred promise was not initialized");
	};
	const promise = new Promise<T>(resolve => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

describe("provider-native file clients", () => {
	test("OpenAI uses the vision multipart contract and authenticated file deletion", async () => {
		const bytes = new Uint8Array([0, 1, 2, 255]);
		const signal = new AbortController().signal;
		const wire = scriptedFetch([
			Response.json({ id: "file/id 1", bytes: bytes.byteLength, status: "processed" }),
			Response.json({ id: "file/id 1", deleted: true }),
		]);
		const client = createOpenAIFileClient(openAIModel, "openai-secret", wire.fetch);
		if (!client) throw new Error("Expected the official OpenAI model to support native files");

		const handle = await client.upload({
			bytes,
			mimeType: "image/png",
			filename: "screenshots\\frame.png",
			signal,
		});

		expect(wire.requests).toHaveLength(1);
		const upload = wire.requests[0];
		expect(upload.url).toBe("https://api.openai.com/v1/files");
		expect(Object.keys(upload.init).sort()).toEqual(["body", "headers", "method", "signal"]);
		expect(upload.init.method).toBe("POST");
		expect(upload.init.signal).toBe(signal);
		expect(normalizedHeaders(upload.init)).toEqual({ authorization: "Bearer openai-secret" });
		const form = requireFormData(upload.init);
		expect(form.get("purpose")).toBe("vision");
		const file = requireFile(form.get("file"));
		expect(file.name).toBe("frame.png");
		expect(file.type).toBe("image/png");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
		expect(handle).toEqual({
			provider: "openai",
			id: "file/id 1",
			mimeType: "image/png",
			bytes: 4,
			delete: {
				method: "DELETE",
				url: "https://api.openai.com/v1/files/file%2Fid%201",
				headers: { Authorization: "Bearer openai-secret" },
			},
		});

		await client.delete(handle);
		expect(wire.requests).toHaveLength(2);
		const deletion = wire.requests[1];
		expect(deletion).toEqual({
			url: "https://api.openai.com/v1/files/file%2Fid%201",
			init: { method: "DELETE", headers: { Authorization: "Bearer openai-secret" } },
		});
	});

	test("Anthropic uses its beta multipart headers, response metadata, and delete endpoint", async () => {
		const expiresAt = "2026-08-22T12:30:00.000Z";
		const bytes = new Uint8Array([9, 8, 7]);
		const signal = new AbortController().signal;
		const wire = scriptedFetch([
			Response.json({
				id: "file_123/odd",
				mime_type: "image/webp",
				size_bytes: 31,
				expires_at: expiresAt,
			}),
			new Response(null, { status: 204 }),
		]);
		const client = createAnthropicFileClient(anthropicModel, "anthropic-secret", wire.fetch);
		if (!client) throw new Error("Expected the official Anthropic model to support native files");

		const handle = await client.upload({ bytes, mimeType: "image/png", filename: "capture.png", signal });

		expect(wire.requests).toHaveLength(1);
		const upload = wire.requests[0];
		expect(upload.url).toBe("https://api.anthropic.com/v1/files");
		expect(Object.keys(upload.init).sort()).toEqual(["body", "headers", "method", "signal"]);
		expect(upload.init.method).toBe("POST");
		expect(upload.init.signal).toBe(signal);
		expect(normalizedHeaders(upload.init)).toEqual({
			"anthropic-beta": "files-api-2025-04-14",
			"anthropic-version": "2023-06-01",
			"x-api-key": "anthropic-secret",
		});
		const file = requireFile(requireFormData(upload.init).get("file"));
		expect(file.name).toBe("capture.png");
		expect(file.type).toBe("image/png");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
		expect(handle).toEqual({
			provider: "anthropic",
			id: "file_123/odd",
			mimeType: "image/webp",
			bytes: 31,
			expiresAt: Date.parse(expiresAt),
			delete: {
				method: "DELETE",
				url: "https://api.anthropic.com/v1/files/file_123%2Fodd",
				headers: {
					"x-api-key": "anthropic-secret",
					"anthropic-version": "2023-06-01",
					"anthropic-beta": "files-api-2025-04-14",
				},
			},
		});

		await client.delete(handle);
		expect(wire.requests).toHaveLength(2);
		const deletion = wire.requests[1];
		expect(deletion.url).toBe("https://api.anthropic.com/v1/files/file_123%2Fodd");
		expect(Object.keys(deletion.init).sort()).toEqual(["headers", "method"]);
		expect(deletion.init.method).toBe("DELETE");
		expect(normalizedHeaders(deletion.init)).toEqual({
			"anthropic-beta": "files-api-2025-04-14",
			"anthropic-version": "2023-06-01",
			"x-api-key": "anthropic-secret",
		});
	});

	test("Gemini performs resumable start, byte finalize, and resource deletion on distinct wires", async () => {
		const bytes = new Uint8Array([4, 5, 6, 7, 8]);
		const signal = new AbortController().signal;
		const expirationTime = "2026-08-23T00:00:00.000Z";
		const uploadUrl = "https://upload.example.test/session/abc?upload-token=opaque";
		const wire = scriptedFetch([
			new Response(null, { status: 200, headers: { "X-Goog-Upload-URL": uploadUrl } }),
			Response.json({
				file: {
					name: "files/gemini-1",
					uri: "https://generativelanguage.googleapis.com/v1beta/files/gemini-1",
					mimeType: "image/png",
					expirationTime,
					state: "ACTIVE",
				},
			}),
			new Response(null, { status: 204 }),
		]);
		const client = createGeminiProviderFileClient(geminiModel, "gemini-secret", wire.fetch);
		if (!client) throw new Error("Expected the official Gemini model to support native files");

		const handle = await client.upload({ bytes, mimeType: "image/png", filename: "frame.png", signal });

		expect(wire.requests).toHaveLength(2);
		const start = wire.requests[0];
		expect(start.url).toBe("https://generativelanguage.googleapis.com/upload/v1beta/files");
		expect(Object.keys(start.init).sort()).toEqual(["body", "headers", "method", "signal"]);
		expect(start.init.method).toBe("POST");
		expect(start.init.signal).toBe(signal);
		expect(normalizedHeaders(start.init)).toEqual({
			"content-type": "application/json",
			"x-goog-api-key": "gemini-secret",
			"x-goog-upload-command": "start",
			"x-goog-upload-header-content-length": "5",
			"x-goog-upload-header-content-type": "image/png",
			"x-goog-upload-protocol": "resumable",
		});
		expect(start.init.body).toBe(JSON.stringify({ file: { display_name: "frame.png" } }));

		const finalize = wire.requests[1];
		expect(finalize.url).toBe(uploadUrl);
		expect(Object.keys(finalize.init).sort()).toEqual(["body", "headers", "method", "signal"]);
		expect(finalize.init.method).toBe("POST");
		expect(finalize.init.signal).toBe(signal);
		expect(normalizedHeaders(finalize.init)).toEqual({
			"content-length": "5",
			"x-goog-upload-command": "upload, finalize",
			"x-goog-upload-offset": "0",
		});
		expect(finalize.init.body).toEqual(bytes);
		expect(handle).toEqual({
			provider: "google",
			id: "files/gemini-1",
			uri: "https://generativelanguage.googleapis.com/v1beta/files/gemini-1",
			mimeType: "image/png",
			bytes: 5,
			expiresAt: Date.parse(expirationTime),
			delete: {
				method: "DELETE",
				url: "https://generativelanguage.googleapis.com/v1beta/files/gemini-1",
				headers: { "x-goog-api-key": "gemini-secret" },
			},
		});

		await client.delete(handle);
		expect(wire.requests).toHaveLength(3);
		expect(wire.requests[2]).toEqual({
			url: "https://generativelanguage.googleapis.com/v1beta/files/gemini-1",
			init: { method: "DELETE", headers: { "x-goog-api-key": "gemini-secret" } },
		});
	});

	test("all clients reject compatible-looking non-official endpoints before network access", () => {
		let requestCount = 0;
		const forbiddenFetch: FetchImpl = async () => {
			requestCount++;
			throw new Error("A rejected model must not reach the network");
		};

		expect(
			createOpenAIFileClient({ ...openAIModel, baseUrl: "https://openrouter.ai/api/v1" }, "secret", forbiddenFetch),
		).toBeNull();
		expect(
			createAnthropicFileClient(
				{ ...anthropicModel, baseUrl: "https://anthropic-proxy.example.test" },
				"secret",
				forbiddenFetch,
			),
		).toBeNull();
		expect(
			createGeminiProviderFileClient(
				{ ...geminiModel, baseUrl: "https://vertex.example.test/v1beta" },
				"secret",
				forbiddenFetch,
			),
		).toBeNull();
		expect(requestCount).toBe(0);
	});
});

describe("ProviderFileCache", () => {
	test("persists sanitized handles by account and drops only the account whose handle expires", async () => {
		using tempDir = TempDir.createSync("@omp-provider-file-cache-");
		const indexPath = tempDir.join("provider-files.json");
		const bytes = new Uint8Array([1, 3, 3, 7]);
		const contentHash = hashProviderFileContent(bytes);
		let now = 1_000;
		const cache = new ProviderFileCache(indexPath, { saveDebounceMs: 60_000, now: () => now });
		cache.set("openai", "account-a-secret", contentHash, {
			provider: "openai",
			id: "account-a-file",
			mimeType: "image/png",
			bytes: bytes.byteLength,
			expiresAt: 2_000,
			delete: {
				method: "DELETE",
				url: "https://api.openai.com/v1/files/account-a-file",
				headers: { Authorization: "Bearer account-a-secret", "x-safe": "retained" },
			},
		});
		cache.set("openai", "account-b-secret", contentHash, {
			provider: "openai",
			id: "account-b-file",
			mimeType: "image/png",
			bytes: bytes.byteLength,
			delete: {
				method: "DELETE",
				url: "https://api.openai.com/v1/files/account-b-file",
				headers: { Authorization: "Bearer account-b-secret", "x-safe": "retained" },
			},
		});
		cache.save();

		const persisted = await Bun.file(indexPath).text();
		expect(persisted).not.toContain("account-a-secret");
		expect(persisted).not.toContain("account-b-secret");
		now = 1_500;
		const restored = new ProviderFileCache(indexPath, { saveDebounceMs: 60_000, now: () => now });
		expect(restored.get("openai", "account-a-secret", contentHash)?.id).toBe("account-a-file");
		expect(restored.get("openai", "account-b-secret", contentHash)?.id).toBe("account-b-file");
		expect(restored.get("openai", "another-account", contentHash)).toBeUndefined();
		expect(restored.get("openai", "account-a-secret", contentHash)?.delete.headers).toEqual({
			"x-safe": "retained",
		});

		now = 2_000;
		expect(restored.get("openai", "account-a-secret", contentHash)).toBeUndefined();
		expect(restored.get("openai", "account-b-secret", contentHash)?.id).toBe("account-b-file");
		expect(restored.status()).toMatchObject({
			entries: 1,
			bytes: 4,
			providers: { openai: 1, anthropic: 0, google: 0 },
			dirty: true,
		});
		restored.save();
		const reloaded = new ProviderFileCache(indexPath, { saveDebounceMs: 60_000, now: () => now });
		expect(reloaded.get("openai", "account-a-secret", contentHash)).toBeUndefined();
		expect(reloaded.get("openai", "account-b-secret", contentHash)?.id).toBe("account-b-file");
	});
});

describe("ProviderFileManager", () => {
	function contextWithRepeatedImage(): Context {
		return {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "first" },
						{ type: "image", data: "AQID", mimeType: "image/png" },
					],
					timestamp: 1,
				},
				{
					role: "developer",
					content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "screenshot",
					content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
	}

	test("deduplicates concurrent uploads, decorates every image-bearing input transiently, and reuses the cache", async () => {
		using tempDir = TempDir.createSync("@omp-provider-file-manager-");
		const cache = new ProviderFileCache(tempDir.join("provider-files.json"), { saveDebounceMs: 60_000 });
		const started = deferred<void>();
		const release = deferred<void>();
		let uploadCount = 0;
		const client: ProviderFileClient = {
			provider: "openai",
			async upload(request): Promise<ProviderFileHandle> {
				uploadCount++;
				expect(request.bytes).toEqual(new Uint8Array([1, 2, 3]));
				expect(request.mimeType).toBe("image/png");
				started.resolve(undefined);
				await release.promise;
				return {
					provider: "openai",
					id: `uploaded-${uploadCount}`,
					mimeType: request.mimeType,
					bytes: request.bytes.byteLength,
					delete: { method: "DELETE", url: `https://api.openai.com/v1/files/uploaded-${uploadCount}` },
				};
			},
			async delete(): Promise<void> {},
		};
		const factory: ProviderFileClientFactory = model => (model.provider === "openai" ? client : null);
		const manager = new ProviderFileManager(cache, async () => "account-a", [factory]);
		const original = contextWithRepeatedImage();

		const firstDecoration = manager.decorateContext(original, openAIModel);
		const secondDecoration = manager.decorateContext(original, openAIModel);
		await started.promise;
		expect(uploadCount).toBe(1);
		release.resolve(undefined);
		const [first, second] = await Promise.all([firstDecoration, secondDecoration]);

		expect(first).toEqual({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "first" },
						{
							type: "image",
							data: "AQID",
							mimeType: "image/png",
							providerFile: { provider: "openai", id: "uploaded-1" },
						},
					],
					timestamp: 1,
				},
				{
					role: "developer",
					content: [
						{
							type: "image",
							data: "AQID",
							mimeType: "image/png",
							providerFile: { provider: "openai", id: "uploaded-1" },
						},
					],
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "screenshot",
					content: [
						{
							type: "image",
							data: "AQID",
							mimeType: "image/png",
							providerFile: { provider: "openai", id: "uploaded-1" },
						},
					],
					isError: false,
					timestamp: 3,
				},
			],
		});
		expect(second).toEqual(first);
		expect(original).toEqual(contextWithRepeatedImage());
		expect(await manager.decorateContext(original, openAIModel)).toEqual(first);
		expect(uploadCount).toBe(1);
		expect(manager.status()).toMatchObject({
			entries: 1,
			bytes: 3,
			providers: { openai: 1, anthropic: 0, google: 0 },
		});
		manager.save();
		expect(manager.status().dirty).toBe(false);
		expect(manager.deleteAll()).toHaveLength(1);
		expect(manager.status()).toMatchObject({
			entries: 0,
			bytes: 0,
			providers: { openai: 0, anthropic: 0, google: 0 },
			dirty: true,
		});
		manager.save();
	});

	test("replaces a mismatched reference, leaves unsupported models inline, and invalidates rejected handles", async () => {
		using tempDir = TempDir.createSync("@omp-provider-file-manager-invalidation-");
		const cache = new ProviderFileCache(tempDir.join("provider-files.json"), { saveDebounceMs: 60_000 });
		let uploadCount = 0;
		const deleted: string[] = [];
		const client: ProviderFileClient = {
			provider: "openai",
			async upload(request): Promise<ProviderFileHandle> {
				uploadCount++;
				return {
					provider: "openai",
					id: `fresh-${uploadCount}`,
					mimeType: request.mimeType,
					bytes: request.bytes.byteLength,
					delete: { method: "DELETE", url: `https://api.openai.com/v1/files/fresh-${uploadCount}` },
				};
			},
			async delete(handle): Promise<void> {
				if (handle.id) deleted.push(handle.id);
			},
		};
		const factory: ProviderFileClientFactory = model => (model.provider === "openai" ? client : null);
		const manager = new ProviderFileManager(cache, async () => "account-a", [factory]);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							data: "AQID",
							mimeType: "image/png",
							providerFile: {
								provider: "google",
								uri: "https://generativelanguage.googleapis.com/v1beta/files/stale",
							},
						},
					],
					timestamp: 1,
				},
			],
		};

		const decorated = await manager.decorateContext(context, openAIModel);
		expect(decorated.messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "image",
						data: "AQID",
						mimeType: "image/png",
						providerFile: { provider: "openai", id: "fresh-1" },
					},
				],
				timestamp: 1,
			},
		]);

		const unsupported = await manager.decorateContext(context, unsupportedModel);
		expect(unsupported).toBe(context);
		expect(unsupported).toEqual(context);
		expect(uploadCount).toBe(1);

		await manager.invalidateContext(decorated, openAIModel);
		expect(manager.status().entries).toBe(0);
		const redecorated = await manager.decorateContext(context, openAIModel);
		expect(redecorated.messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "image",
						data: "AQID",
						mimeType: "image/png",
						providerFile: { provider: "openai", id: "fresh-2" },
					},
				],
				timestamp: 1,
			},
		]);
		expect(uploadCount).toBe(2);
		expect(deleted).toEqual([]);
		manager.save();
	});
});
