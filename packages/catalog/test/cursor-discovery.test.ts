import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http2 from "node:http2";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
// Import from source, not the package specifier: the workspace `node_modules`
// copy resolves to the primary checkout, not this worktree.
import {
	__cursorDiscoveryHttp2Snapshot,
	__cursorH2ConnectingSize,
	__setCursorDiscoveryHttp2EstablishBodyGate,
	__setCursorDiscoveryHttp2IdleEvictMs,
	__setCursorDiscoveryTimeoutSignal,
	disposeCursorDiscoveryHttp2Pool,
	fetchCursorUsableModels,
} from "../src/discovery/cursor";
import { GetUsableModelsResponseSchema, ModelDetailsSchema } from "../src/discovery/cursor-proto";
import { create, toBinary } from "../src/discovery/protobuf";
import { resolveProviderModels } from "../src/model-manager";
import { cursorModelManagerOptions } from "../src/provider-models/special";
import type { ModelSpec } from "../src/types";

const FIXTURE_MODEL_IDS = [
	// Reference-less ids from families whose native catalogs are multimodal.
	"claude-opus-4-8-99999999",
	"gpt-5.5-codex-20991231",
	"gemini-4-pro-exp",
	// Reference-less ids from text-only families.
	"composer-3",
	// Reference-less K3 effort variants omit Cursor thinkingDetails.
	"kimi-k3-high",
	"kimi-k3-low",
	"kimi-k3-max",
	"grok-code-fast-2",
	// Versioned Cursor Grok siblings: bundled references read reasoning:false,
	// but the id marks them reasoning.
	"cursor-grok-4.5-high",
	"cursor-grok-4.6-xhigh",
	// Bundled-reference ids: the reference stays authoritative.
	"claude-4.5-opus-high",
	"claude-4.6-opus-high",
	"composer-1",
];

let server: http2.Http2Server;
let baseUrl: string;

beforeAll(async () => {
	const response = create(GetUsableModelsResponseSchema, {
		models: FIXTURE_MODEL_IDS.map(modelId => create(ModelDetailsSchema, { modelId })),
	});
	const payload = Buffer.from(toBinary(GetUsableModelsResponseSchema, response));

	server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		stream.on("end", () => {
			if (headers[":path"] !== "/agent.v1.AgentService/GetUsableModels") {
				stream.respond({ ":status": 404 });
				stream.end();
				return;
			}
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.end(payload);
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
	server?.close();
});
beforeEach(() => {
	disposeCursorDiscoveryHttp2Pool();
	__setCursorDiscoveryHttp2EstablishBodyGate(undefined);
	__setCursorDiscoveryHttp2IdleEvictMs(undefined);
	__setCursorDiscoveryTimeoutSignal(undefined);
});

afterEach(() => {
	disposeCursorDiscoveryHttp2Pool();
	__setCursorDiscoveryHttp2EstablishBodyGate(undefined);
	__setCursorDiscoveryHttp2IdleEvictMs(undefined);
	__setCursorDiscoveryTimeoutSignal(undefined);
});

async function discover(): Promise<Map<string, ModelSpec<"cursor-agent">>> {
	const models = await fetchCursorUsableModels({ apiKey: "test-key", baseUrl });
	expect(models).not.toBeNull();
	return new Map((models ?? []).map(model => [model.id, model]));
}

describe("cursor discovery input modalities (issue #4726)", () => {
	it("classifies reference-less multimodal-family models as text+image", async () => {
		const byId = await discover();
		expect(byId.get("claude-opus-4-8-99999999")?.input).toEqual(["text", "image"]);
		expect(byId.get("gpt-5.5-codex-20991231")?.input).toEqual(["text", "image"]);
		expect(byId.get("gemini-4-pro-exp")?.input).toEqual(["text", "image"]);
	});

	it("keeps reference-less text-only families text-only", async () => {
		const byId = await discover();
		expect(byId.get("composer-3")?.input).toEqual(["text"]);
		expect(byId.get("grok-code-fast-2")?.input).toEqual(["text"]);
	});

	it("recognizes reference-less Kimi K3 effort variants as reasoning models", async () => {
		const byId = await discover();
		expect(byId.get("kimi-k3-high")?.reasoning).toBe(true);
		expect(byId.get("kimi-k3-low")?.reasoning).toBe(true);
		expect(byId.get("kimi-k3-max")?.reasoning).toBe(true);
	});

	it("marks versioned Cursor Grok ids as reasoning despite reasoning:false references (issue #8803)", async () => {
		const byId = await discover();
		expect(byId.get("cursor-grok-4.5-high")?.reasoning).toBe(true);
		expect(byId.get("cursor-grok-4.6-xhigh")?.reasoning).toBe(true);
		// grok-code-* coding models lack the version digit and stay non-reasoning.
		expect(byId.get("grok-code-fast-2")?.reasoning).toBe(false);
	});

	it("keeps bundled references authoritative for input modalities", async () => {
		const byId = await discover();
		// Bundled cursor references carry their own input classification; the
		// id-based inference must not override it in either direction.
		expect(byId.get("claude-4.5-opus-high")?.input).toEqual(["text", "image"]);
		expect(byId.get("claude-4.6-opus-high")?.input).toEqual(["text"]);
		expect(byId.get("composer-1")?.input).toEqual(["text"]);
	});

	it("preserves fallback defaults for reference-less models", async () => {
		const byId = await discover();
		const spec = byId.get("claude-opus-4-8-99999999");
		expect(spec?.provider).toBe("cursor");
		expect(spec?.api).toBe("cursor-agent");
		expect(spec?.contextWindow).toBe(200_000);
		expect(spec?.maxTokens).toBe(64_000);
		expect(spec?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

const servers = new Set<http2.Http2Server>();
const tempDirs = new Set<string>();

afterEach(async () => {
	await Promise.all(
		[...servers].map(srv => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			srv.close(error => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
			return promise;
		}),
	);
	await Promise.all([...tempDirs].map(dir => fs.rm(dir, { recursive: true, force: true })));
	servers.clear();
	tempDirs.clear();
});

function requireTcpAddress(address: string | net.AddressInfo | null): net.AddressInfo {
	if (!address || typeof address === "string") {
		throw new Error("HTTP/2 test server did not bind to a TCP address");
	}
	return address;
}

function startCursorDiscoveryServer(body: Uint8Array, seenHeaders?: http2.IncomingHttpHeaders[]): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const srv = http2.createServer();
	servers.add(srv);
	srv.once("error", reject);
	srv.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		seenHeaders?.push(headers);
		stream.respond({ ":status": 200, "content-type": "application/proto" });
		stream.end(Buffer.from(body));
	});
	srv.listen(0, "127.0.0.1", () => {
		resolve(`http://127.0.0.1:${requireTcpAddress(srv.address()).port}`);
	});
	return promise;
}

async function createTempCachePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-cache-"));
	tempDirs.add(dir);
	return path.join(dir, "models.db");
}

function cursorModelSpec(id: string): ModelSpec<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

describe("fetchCursorUsableModels", () => {
	it("preserves Cursor max-mode metadata from GetUsableModels", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, {
					modelId: "cursor-composer-max",
					displayName: "Cursor Composer Max",
					maxMode: true,
				}),
			],
		});
		const maxModeBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: maxModeBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({
				id: "cursor-composer-max",
				name: "Cursor Composer Max",
				api: "cursor-agent",
				provider: "cursor",
				cursorMaxMode: true,
			}),
		]);
	});

	it("assigns the 1M window from display-name labels across families", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, { modelId: "claude-opus-5-high", displayName: "Opus 5 1M" }),
				create(ModelDetailsSchema, { modelId: "gpt-5.5-high", displayName: "GPT-5.5 1M High" }),
				create(ModelDetailsSchema, { modelId: "gpt-5.6-sol-medium", displayName: "GPT-5.6 Sol 1M" }),
			],
		});
		const labeledBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: labeledBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({ id: "claude-opus-5-high", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "gpt-5.5-high", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "gpt-5.6-sol-medium", contextWindow: 1_000_000 }),
		]);
	});

	it("assigns the 1M window to natively 1M families Cursor serves unlabeled", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, { modelId: "kimi-k3-max", displayName: "Kimi K3" }),
				create(ModelDetailsSchema, { modelId: "moonshotai/kimi-k3", displayName: "Kimi K3" }),
				create(ModelDetailsSchema, { modelId: "k3", displayName: "K3" }),
				create(ModelDetailsSchema, { modelId: "kimi/k3", displayName: "K3" }),
				create(ModelDetailsSchema, { modelId: "glm-5.2-max", displayName: "GLM 5.2 Max" }),
				create(ModelDetailsSchema, { modelId: "glm-5.10-high", displayName: "GLM 5.10 High" }),
				create(ModelDetailsSchema, { modelId: "glm-6-max", displayName: "GLM 6 Max" }),
			],
		});
		const nativeBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: nativeBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({ id: "glm-5.10-high", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "glm-5.2-max", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "glm-6-max", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "k3", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "kimi-k3-max", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "kimi/k3", contextWindow: 1_000_000 }),
			expect.objectContaining({ id: "moonshotai/kimi-k3", contextWindow: 1_000_000 }),
		]);
	});

	it("keeps the default window below the GLM 5.2 floor and outside the coding variants", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, { modelId: "glm-5.1-high", displayName: "GLM 5.1 High" }),
				create(ModelDetailsSchema, { modelId: "glm-5.2-flash", displayName: "GLM 5.2 Flash" }),
				create(ModelDetailsSchema, { modelId: "k3-256k", displayName: "K3-256k" }),
			],
		});
		const nativeBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: nativeBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({ id: "glm-5.1-high", contextWindow: 200_000 }),
			expect.objectContaining({ id: "glm-5.2-flash", contextWindow: 200_000 }),
			expect.objectContaining({ id: "k3-256k", contextWindow: 200_000 }),
		]);
	});

	it("assigns the 1M window to unlabeled max-mode Claude models", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, {
					modelId: "claude-opus-4-8-high-fast",
					displayName: "Opus 4.8 Fast",
					maxMode: true,
				}),
			],
		});
		const maxModeBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: maxModeBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({ id: "claude-opus-4-8-high-fast", cursorMaxMode: true, contextWindow: 1_000_000 }),
		]);
	});

	it("keeps the default window for unlabeled non-max models and max-mode models outside 1M families", async () => {
		// Unbundled ids: the contract under test is "no 1M signal → fallback
		// preserved", so neither id may carry a bundled cursor reference whose
		// snapshot window would replace the 200k default fallback.
		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, { modelId: "cursor-composer-max", maxMode: true }),
				create(ModelDetailsSchema, { modelId: "claude-opus-9-high", displayName: "Opus 9" }),
			],
		});
		const defaultBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: defaultBaseUrl, timeoutMs: 1_000 });

		expect(models).toEqual([
			expect.objectContaining({ id: "claude-opus-9-high", cursorMaxMode: false, contextWindow: 200_000 }),
			expect.objectContaining({ id: "cursor-composer-max", cursorMaxMode: true, contextWindow: 200_000 }),
		]);
	});

	it("raises a bundled reference window when the reference id is served with a 1M label", async () => {
		// `claude-4.5-sonnet` is a bundled cursor reference with a 200k window;
		// served with a 1M display name it must expose the 1M ceiling.
		const response = create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "claude-4.5-sonnet", displayName: "Sonnet 4.5 1M" })],
		});
		const referenceBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({
			apiKey: "test-token",
			baseUrl: referenceBaseUrl,
			timeoutMs: 1_000,
		});

		expect(models).toEqual([expect.objectContaining({ id: "claude-4.5-sonnet", contextWindow: 1_000_000 })]);
	});

	it("ignores Cursor cache rows written before 1M context windows were persisted", async () => {
		const cacheDbPath = await createTempCachePath();
		const staleSpec = { ...cursorModelSpec("claude-opus-4-8-high-fast"), cursorMaxMode: true };
		await resolveProviderModels(
			{
				providerId: "cursor",
				cacheProviderId: "cursor:max-mode-v2",
				cacheDbPath,
				staticModels: [],
				fetchDynamicModels: async () => [staleSpec],
				now: () => 1,
			},
			"online",
		);

		const response = create(GetUsableModelsResponseSchema, {
			models: [
				create(ModelDetailsSchema, {
					modelId: staleSpec.id,
					displayName: staleSpec.name,
					maxMode: true,
				}),
			],
		});
		const staleBaseUrl = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));
		const result = await resolveProviderModels(
			{
				...cursorModelManagerOptions({ apiKey: "test-token", baseUrl: staleBaseUrl }),
				cacheDbPath,
				staticModels: [],
				now: () => 2,
			},
			"online-if-uncached",
		);

		expect(result.models).toEqual([
			expect.objectContaining({
				id: staleSpec.id,
				cursorMaxMode: true,
				contextWindow: 1_000_000,
			}),
		]);
	});

	it("pins the shared client version on the wire and forwards explicit overrides", async () => {
		const seen: http2.IncomingHttpHeaders[] = [];
		const response = create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "claude-opus-4-8-high-fast" })],
		});
		const url = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response), seen);

		const defaulted = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 1_000 });
		const overridden = await fetchCursorUsableModels({
			apiKey: "test-token",
			baseUrl: url,
			clientVersion: "cli-0000.00.00-override",
			timeoutMs: 1_000,
		});

		expect(defaulted).toEqual([expect.objectContaining({ id: "claude-opus-4-8-high-fast" })]);
		expect(overridden).toEqual(defaulted);
		expect(seen.map(headers => headers["x-cursor-client-version"])).toEqual([
			"cli-2026.08.11-e8db854",
			"cli-0000.00.00-override",
		]);
	});

	it("reuses one HTTP/2 session for sequential GetUsableModels calls", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "composer-3" })],
		});
		const body = toBinary(GetUsableModelsResponseSchema, response);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const srv = http2.createServer();
		servers.add(srv);
		let sessions = 0;
		srv.once("error", reject);
		srv.on("session", () => {
			sessions++;
		});
		srv.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.end(Buffer.from(body));
		});
		srv.listen(0, "127.0.0.1", () => {
			resolve(`http://127.0.0.1:${requireTcpAddress(srv.address()).port}`);
		});
		const url = await promise;

		const first = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 1_000 });
		const second = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 1_000 });

		expect(first).toEqual([expect.objectContaining({ id: "composer-3" })]);
		expect(second).toEqual(first);
		expect(sessions).toBe(1);
	});

	it("unrefs the pooled session once outstanding leases drop to zero", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "composer-3" })],
		});
		const url = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 1_000 });

		expect(models).toEqual([expect.objectContaining({ id: "composer-3" })]);
		expect(__cursorDiscoveryHttp2Snapshot()).toEqual([
			expect.objectContaining({ outstanding: 0, draining: false, referenced: false }),
		]);
	});
	it("discards the pooled session when GetUsableModels times out", async () => {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const srv = http2.createServer();
		servers.add(srv);
		srv.once("error", reject);
		srv.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.on("data", () => {});
		});
		srv.listen(0, "127.0.0.1", () => {
			resolve(`http://127.0.0.1:${requireTcpAddress(srv.address()).port}`);
		});
		const url = await promise;
		expect(await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 50 })).toBeNull();
		expect(__cursorDiscoveryHttp2Snapshot()).toEqual([]);
	});

	it("removes the timeout signal's abort listener after a successful discovery", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "composer-3" })],
		});
		const url = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));
		// A long `timeoutMs` arms a signal that never fires: swap the module-local
		// factory for a counting wrapper so the test can see the listener
		// bookkeeping. The abort listener `readUnaryResponse` installs must come
		// off when the read settles, or it retains `finish` — and through it the
		// request, the lease, and every buffered chunk — until the timer's own GC.
		const inner = new AbortController().signal;
		let listeners = 0;
		const counted = new Proxy(inner, {
			get(target, prop) {
				if (prop === "addEventListener") {
					return (type: string, listener: EventListener, options?: unknown) => {
						listeners++;
						target.addEventListener(type, listener, options as AddEventListenerOptions);
					};
				}
				if (prop === "removeEventListener") {
					return (type: string, listener: EventListener, options?: unknown) => {
						listeners--;
						target.removeEventListener(type, listener, options as EventListenerOptions);
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as AbortSignal;
		let timeoutFactoryCalls = 0;
		__setCursorDiscoveryTimeoutSignal(() => {
			timeoutFactoryCalls++;
			return counted;
		});
		try {
			const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 60_000 });
			expect(timeoutFactoryCalls).toBe(1);
			expect(models).toEqual([expect.objectContaining({ id: "composer-3" })]);
			// Every listener taken on the timeout signal (the read's own plus
			// the pool's connect-wait and lease guards) was removed on settle.
			expect(listeners).toBe(0);
		} finally {
			__setCursorDiscoveryTimeoutSignal(undefined);
		}
	});

	it("cancels a connect whose last waiter aborted mid-handshake instead of publishing it", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "composer-3" })],
		});
		const url = await startCursorDiscoveryServer(toBinary(GetUsableModelsResponseSchema, response));
		const { promise: released, resolve: releaseGate } = Promise.withResolvers<void>();
		const { promise: gated, resolve: sawGate } = Promise.withResolvers<void>();
		__setCursorDiscoveryHttp2EstablishBodyGate(async () => {
			sawGate();
			await released;
		});

		const pending = fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 20 });
		await gated;
		expect(__cursorDiscoveryHttp2Snapshot()).toEqual([]);
		expect(await pending).toBeNull();
		// The last live waiter left before the handshake completed, so the
		// connect is cancelled and must never publish a session into the pool —
		// nor leave a destroyed one reserved for the next discovery.
		expect(__cursorH2ConnectingSize()).toBe(0);
		expect(__cursorDiscoveryHttp2Snapshot()).toEqual([]);
		releaseGate();
		// The suspended establish body's post-gate continuation is pure
		// microtasks (the settled guard returns before any connect), so drain
		// them rather than sleeping.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(__cursorH2ConnectingSize()).toBe(0);
		expect(__cursorDiscoveryHttp2Snapshot()).toEqual([]);
		// A later discovery retries a fresh connect instead of joining the
		// cancelled reservation.
		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 1_000 });
		expect(models).toEqual([expect.objectContaining({ id: "composer-3" })]);
	});

	it("evicts an idle pooled session on a later acquisition instead of retaining it forever", async () => {
		const response = create(GetUsableModelsResponseSchema, {
			models: [create(ModelDetailsSchema, { modelId: "composer-3" })],
		});
		const body = toBinary(GetUsableModelsResponseSchema, response);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const srv = http2.createServer();
		servers.add(srv);
		let sessions = 0;
		srv.once("error", reject);
		srv.on("session", () => {
			sessions++;
		});
		srv.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.end(Buffer.from(body));
		});
		srv.listen(0, "127.0.0.1", () => {
			resolve(`http://127.0.0.1:${requireTcpAddress(srv.address()).port}`);
		});
		const url = await promise;

		const first = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 1_000 });
		expect(first).toEqual([expect.objectContaining({ id: "composer-3" })]);
		expect(__cursorDiscoveryHttp2Snapshot()).toHaveLength(1);

		// Real platform clock: eviction is gated on Date.now() deltas and has
		// no deterministic seam — faking timers would break the real http2
		// fixture stack — so age the entry past a shrunken window instead.
		__setCursorDiscoveryHttp2IdleEvictMs(20);
		await Bun.sleep(40);
		const second = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 1_000 });

		expect(second).toEqual(first);
		// The idle entry was destroyed before the pool was consulted, so this
		// discovery opened a fresh session rather than reusing the stale one.
		expect(sessions).toBe(2);
	});

	it("maps request failures to null", async () => {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const srv = http2.createServer();
		servers.add(srv);
		srv.once("error", reject);
		srv.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.respond({ ":status": 500 });
			stream.end();
		});
		srv.listen(0, "127.0.0.1", () => {
			resolve(`http://127.0.0.1:${requireTcpAddress(srv.address()).port}`);
		});
		const url = await promise;

		const models = await fetchCursorUsableModels({ apiKey: "test-token", baseUrl: url, timeoutMs: 1_000 });

		expect(models).toBeNull();
	});
});
