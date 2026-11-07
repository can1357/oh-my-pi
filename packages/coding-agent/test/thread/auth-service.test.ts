import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { ModelRegistry } from "../../src/config/model-registry";
import { anthropicSlowModeLanes } from "../../src/session/anthropic-slow-mode";
import type { MainThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { WorkerPeer } from "../../src/thread/services";
import { authService } from "../../src/thread/services/auth";
import type { AuthProbe, AuthTestGlobals } from "../fixtures/auth-service-worker";

const PROVIDER = "unit-oauth-thread";
const LANE = "cred:thread-test";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("auth thread service", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let registry: ModelRegistry;
	let worker: Worker | undefined;
	let link: MainThreadLink | undefined;
	let peer: WorkerPeer;
	let probe: AuthProbe;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-thread-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		const modelsPath = path.join(tempDir, "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"unit-mirror": {
						baseUrl: "https://unit-mirror.example.invalid/v1",
						api: "openai-completions",
						apiKey: "mirror-config-key",
						models: [{ id: "mirror-model", name: "Mirror Model" }],
					},
				},
			}),
		);
		registry = new ModelRegistry(storage, modelsPath, { cacheDbPath: path.join(tempDir, "models.db") });

		const spawned = new Worker(new URL("../fixtures/auth-service-worker.ts", import.meta.url).href, {
			type: "module",
		});
		worker = spawned;
		const channel = new MessageChannel();
		const counter = new SharedArrayBuffer(4);
		const { promise: ready, resolve: onReady } = Promise.withResolvers<void>();
		const readyListener = (event: MessageEvent): void => {
			if (event.data?.ready) {
				spawned.removeEventListener("message", readyListener);
				onReady();
			}
		};
		spawned.addEventListener("message", readyListener);
		spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
		await ready;
		const mainLink: MainThreadLink = new RpcLink(
			{
				send: frame => spawned.postMessage(frame),
				listen: handler => {
					const listener = (event: MessageEvent<RpcFrame>): void => handler(event.data);
					spawned.addEventListener("message", listener);
					return () => spawned.removeEventListener("message", listener);
				},
			},
			{ name: "main↔auth-fixture", syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
		);
		link = mainLink;
		mainLink.handle("ping", nonce => nonce);
		peer = { threadId: "w1", link: mainLink };
		authService.installMain?.(peer);
		const { promise: probed, resolve: onProbe } = Promise.withResolvers<AuthProbe>();
		const test: AuthTestGlobals = { storage, ready: received => onProbe(received) };
		await mainLink.call("boot", { [authService.name]: authService.globals?.(peer), test });
		probe = await probed;
	});

	afterEach(async () => {
		link?.close("test done");
		link = undefined;
		await worker?.terminate();
		worker = undefined;
		anthropicSlowModeLanes.lane(LANE).reset();
		vi.restoreAllMocks();
		storage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function storeAccounts(): Promise<{ a: number; b: number }> {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [a, b] = storage.oauth.accounts(PROVIDER);
		if (!a || !b) throw new Error("expected two stored accounts");
		return { a: a.credentialId, b: b.credentialId };
	}

	it("hands the worker one canonical AuthStorage that resolves on the main instance", async () => {
		const { b } = await storeAccounts();
		expect(await probe.sameStorage(storage)).toBe(true);
		expect(storage.sessions.pin(PROVIDER, "pinned", b)).toBe(true);

		expect(await probe.key(PROVIDER, "pinned")).toBe("access-b");
		expect(await probe.accountId(PROVIDER, "pinned")).toBe("acc-b");
	});

	it("restricts main lookups with a worker lease until the worker unrestricts", async () => {
		const { a, b } = await storeAccounts();
		const handle = await probe.restrict(PROVIDER, "child", ["account:acc-b"]);

		expect(storage.sessions.permits(PROVIDER, "child", a)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-b");
		expect(await probe.key(PROVIDER, "child")).toBe("access-b");

		await probe.unrestrict(PROVIDER, "child", handle);
		expect(storage.sessions.permits(PROVIDER, "child", a)).toBe(true);
		expect(storage.sessions.permits(PROVIDER, "child", b)).toBe(true);
	});

	it("rebuilds main-thread auth errors by class in the worker", async () => {
		await storeAccounts();
		await probe.restrict(PROVIDER, "nowhere", ["account:acc-z"]);

		const outcome = await probe.keyError(PROVIDER, "nowhere");
		expect(outcome.missingApiKey).toBe(true);
		expect(outcome.message).toContain(`No API key for provider: ${PROVIDER}`);
	});

	it("releases every lease a worker holds when it exits", async () => {
		const { a } = await storeAccounts();
		await probe.restrict(PROVIDER, "orphan", ["account:acc-b"]);
		expect(storage.sessions.permits(PROVIDER, "orphan", a)).toBe(false);

		authService.onWorkerExit?.(peer, "crashed");
		expect(storage.sessions.permits(PROVIDER, "orphan", a)).toBe(true);
	});

	it("delivers main credential events to worker listeners until they unsubscribe", async () => {
		await probe.watchGenerations();
		await storeAccounts();
		// Frames to the worker are ordered: the listener call lands before this read.
		expect((await probe.generations()).at(-1)).toBe(storage.credentials.generation);

		await probe.unwatchGenerations();
		const seen = (await probe.generations()).length;
		await storage.credentials.remove(PROVIDER);
		expect((await probe.generations()).length).toBe(seen);
	});

	it("answers worker auth availability from one cached batch until main's credentials change", async () => {
		// Main lists stored providers once per batch.
		const batches = vi.spyOn(storage.credentials, "all");
		const keyless = vi.spyOn(storage.keys, "keyless");
		// The first lookup brings every bundled provider along with the asked one.
		expect(await probe.sourceKinds([PROVIDER, "anthropic", "openai"])).toHaveLength(3);
		expect(batches).toHaveBeenCalledTimes(1);
		const answered = new Set(keyless.mock.calls.map(([provider]) => provider));
		for (const provider of [PROVIDER, "anthropic", "openai"]) expect(answered.has(provider)).toBe(true);

		// A provider main did not list costs an answer of its own, not another batch.
		expect(await probe.sourceKinds([PROVIDER, "unit-other"])).toEqual([undefined, undefined]);
		expect(await probe.sourceKinds([PROVIDER, "unit-other", "anthropic"])).toHaveLength(3);
		expect(batches).toHaveBeenCalledTimes(1);

		// The generation bump reaches the worker before this probe call (frames are ordered).
		await storeAccounts();
		expect(await probe.sourceKinds([PROVIDER, "unit-other"])).toEqual(["oauth", undefined]);
		expect(batches).toHaveBeenCalledTimes(2);
	});

	it("resolves a worker's OAuth identity from main once main stores an account after the worker saw none", async () => {
		expect(await probe.accountId(PROVIDER, "pinned")).toBeUndefined();

		const { b } = await storeAccounts();
		expect(storage.sessions.pin(PROVIDER, "pinned", b)).toBe(true);
		expect(await probe.key(PROVIDER, "pinned")).toBe("access-b");
		expect(await probe.accountId(PROVIDER, "pinned")).toBe("acc-b");
	});

	it("mirrors the main ModelRegistry locally over the shared AuthStorage", async () => {
		const first = await probe.registry(registry);
		expect(first).toEqual({
			local: true,
			canonical: true,
			sharesAuth: true,
			hasModel: true,
			apiKey: "mirror-config-key",
		});
		expect((await probe.registry(registry)).canonical).toBe(true);
		// The mirror never clears or reinstalls the key config main's registry owns.
		expect(await storage.keys.get("unit-mirror")).toBe("mirror-config-key");
	});

	it("reads main's key generation through the worker, a change and a change back included", async () => {
		const provider = "unit-worker-generation";
		const start = await probe.keyGeneration(provider);
		expect(start).toBe(storage.keys.generation(provider));
		// Written on main, read on the worker.
		storage.keys.setRuntime(provider, "fake-main-key");
		expect(await probe.keyGeneration(provider)).toBe(start + 1);
		// Written on the worker: a worker holds no batch open across the thread
		// boundary, so a change and a change back are two changes, not none.
		await probe.setRuntimeKey(provider, "fake-worker-key");
		expect(await probe.keyGeneration(provider)).toBe(start + 2);
		await probe.setRuntimeKey(provider, "fake-main-key");
		expect(await probe.keyGeneration(provider)).toBe(start + 3);
		expect(storage.keys.generation(provider)).toBe(start + 3);
		// A worker write that leaves the overrides as they were counts on neither side.
		await probe.setRuntimeKey(provider, "fake-main-key");
		expect(await probe.keyGeneration(provider)).toBe(start + 3);
		expect(storage.keys.generation(provider)).toBe(start + 3);
	});

	for (const [entry, change] of [
		["keys.setRuntime", (provider: string) => probe.setRuntimeKey(provider, "fake-worker-runtime-key")],
		["keys.setConfig", (provider: string) => probe.setConfigKey(provider, "fake-worker-config-key")],
	] as const) {
		it(`refuses a main discovery whose key a worker replaced through ${entry} while it resolved`, async () => {
			const gate = path.join(tempDir, "held.gate");
			const started = path.join(tempDir, "held.started");
			const heldKey = `!sh -c 'touch ${started}; while [ ! -f ${gate} ]; do sleep 0.02; done; echo fake-original-key'`;
			const heldPath = path.join(tempDir, "held-models.yml");
			await Bun.write(
				heldPath,
				`providers:\n  anthropic:\n    baseUrl: http://held-key.invalid\n    apiKey: "${heldKey}"\n`,
			);
			const sent: Array<string | null> = [];
			const held = new ModelRegistry(storage, heldPath, {
				cacheDbPath: path.join(tempDir, "held-models.db"),
				fetch: async (input, init) => {
					if (String(input) !== "http://held-key.invalid/v1/models") throw new Error(`offline: ${String(input)}`);
					sent.push(new Headers(init?.headers).get("x-api-key"));
					return Response.json({ data: [{ id: "held-model", type: "model" }] });
				},
			});
			try {
				const inFlight = held.refreshProvider("anthropic", "online");
				// The key command runs in a child process; its marker file is its only signal.
				while (!(await fs.exists(started))) await Bun.sleep(10);
				// The worker's change is a notify; frames are ordered, so main applied it before this resolves.
				await change("anthropic");
				await Bun.write(gate, "");
				await inFlight;
				expect(sent).not.toContain("fake-original-key");
				expect(held.find("anthropic", "held-model")).toBeUndefined();
			} finally {
				await Bun.write(gate, "");
			}
		});
	}

	it("shares the main thread's slow-mode lane state", async () => {
		const observed = await probe.observeWrapUp(LANE);
		expect(observed).toEqual({ remoteLane: true, stage: "wrap_up" });
		expect(anthropicSlowModeLanes.lane(LANE).status()?.stage).toBe("wrap_up");
	});
});
