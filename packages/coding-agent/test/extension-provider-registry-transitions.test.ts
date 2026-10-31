/**
 * Round-twenty regressions for the registry transitions round nineteen left open.
 *
 * Each `describe` holds one finding: which queued occurrence an ownerless drain registers, which
 * registration a discovery's rows belong to once its fetch returns, what of an author's nested
 * data the registry reads after registration, and what a departing registration leaves for the
 * one still in force.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	type Api,
	clearCustomApis,
	createAssistantMessageEventStream,
	getCustomApi,
	type Model,
	streamSimple,
} from "@oh-my-pi/pi-ai";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { providerCallGate } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/callback-ownership";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { extensionCallbackScope } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "registry-transitions";
const OTHER_PROVIDER = "registry-transitions-other";
const SOURCE = "ext://registry-transitions";
const OTHER_SOURCE = "ext://registry-transitions-other";
const HOST_SOURCE = "host://registry-transitions";
const OTHER_HOST_SOURCE = "host://registry-transitions-other";
const SOURCES = [SOURCE, OTHER_SOURCE, HOST_SOURCE, OTHER_HOST_SOURCE];
const OAUTH_CREDENTIAL = {
	type: "oauth" as const,
	access: "access",
	refresh: "refresh",
	expires: Date.now() + 3_600_000,
};

type ModelDefinition = NonNullable<ProviderConfigInput["models"]>[number];

function model(id = "m", extra: Partial<ModelDefinition> = {}): ModelDefinition {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 100,
		...extra,
	};
}

interface Owner {
	readonly runtime: ExtensionRuntime;
	readonly release: () => void;
}

let dir: TempDir;
let auth: AuthStorage;
let registry: ModelRegistry;
const releases: Array<() => void> = [];

function owner(): Owner {
	const runtime = new ExtensionRuntime();
	const release = runtime.beginSession();
	releases.push(release);
	return { runtime, release };
}

function report(label: string): UsageReport {
	return { provider: PROVIDER, fetchedAt: 1, limits: [], metadata: { source: label } };
}

/** Drains a runtime's queue the documented way: the three queued fields, no owner. */
function drain(runtime: ExtensionRuntime): void {
	for (const entry of runtime.pendingProviderRegistrations.splice(0)) {
		registry.registerProvider(entry.name, entry.config, entry.sourceId);
	}
}

function ids(provider = PROVIDER): string[] {
	return registry.getProviderModels(provider).map(entry => entry.id);
}

/** A fake OpenAI-compatible endpoint, so a real request serializes without reaching a network. */
const fakeCompletions = async (): Promise<Response> =>
	new Response(
		'data: {"id":"r","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
		{ headers: { "content-type": "text/event-stream" } },
	);

beforeEach(async () => {
	dir = TempDir.createSync("@registry-transitions-");
	auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	registry = new ModelRegistry(auth, path.join(dir.path(), "models.json"));
});

afterEach(() => {
	for (const release of releases.splice(0)) release();
	registry.clearSourceRegistrations(SOURCES);
	clearCustomApis();
	for (const source of SOURCES) unregisterOAuthProviders(source);
	auth.close();
	dir.removeSync();
});

describe("R19-2: an ownerless drain registers the occurrence it took out of the queue", () => {
	function shared(calls?: string[]): ProviderConfigInput {
		return {
			apiKey: "key",
			usage: {
				id: PROVIDER,
				async fetchUsage() {
					calls?.push(extensionCallbackScope.getStore() === undefined ? "unowned" : "owned");
					return report("shared");
				},
			},
		};
	}

	test("draining only the child's queue registers the child's occurrence", () => {
		const parent = owner();
		const child = owner();
		const config = shared();
		parent.runtime.registerProvider(PROVIDER, config, SOURCE);
		child.runtime.registerProvider(PROVIDER, config, SOURCE);

		drain(child.runtime);

		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(child.runtime));
		expect(parent.runtime.pendingProviderRegistrations).toHaveLength(1);
	});

	test("withdrawing and retiring that child leaves nothing installed under the undrained parent", async () => {
		const parent = owner();
		const child = owner();
		const calls: string[] = [];
		const config = shared(calls);
		parent.runtime.registerProvider(PROVIDER, config, SOURCE);
		child.runtime.registerProvider(PROVIDER, config, SOURCE);
		drain(child.runtime);

		registry.unregisterProvider(PROVIDER, child.runtime);
		child.release();

		await expect(auth.usage.reports({ provider: PROVIDER })).resolves.toEqual([]);
		expect(calls).toEqual([]);
		// The parent's own occurrence is still queued, and still its own once drained.
		drain(parent.runtime);
		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(parent.runtime));
	});

	test("iterating one queue in place registers that queue's occurrence", () => {
		const parent = owner();
		const child = owner();
		const config = shared();
		parent.runtime.registerProvider(PROVIDER, config, SOURCE);
		child.runtime.registerProvider(PROVIDER, config, SOURCE);

		for (const entry of child.runtime.pendingProviderRegistrations) {
			registry.registerProvider(entry.name, entry.config, entry.sourceId);
		}

		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(child.runtime));
	});

	test("two sessions' identical occurrences both out of their queues are refused, not guessed", () => {
		const parent = owner();
		const child = owner();
		const config = shared();
		parent.runtime.registerProvider(PROVIDER, config, SOURCE);
		child.runtime.registerProvider(PROVIDER, config, SOURCE);
		const drained = [
			...parent.runtime.pendingProviderRegistrations.splice(0),
			...child.runtime.pendingProviderRegistrations.splice(0),
		];

		const [first] = drained;
		expect(() => registry.registerProvider(first.name, first.config, first.sourceId)).toThrow(/owner/);
		expect(auth.usage.providerEntryFor(PROVIDER)).toBeUndefined();
		// Passing the owner settles it.
		for (const entry of drained) registry.registerProvider(entry.name, entry.config, entry.sourceId, entry.owner);
		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(child.runtime));
	});

	test("a configuration waiting only in one session's queue is that session's", () => {
		const parent = owner();
		const config = shared();
		parent.runtime.registerProvider(PROVIDER, config, SOURCE);

		registry.registerProvider(PROVIDER, config, SOURCE);

		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(parent.runtime));
	});

	test("an in-place forEach drain with one session registers under that session", () => {
		const parent = owner();
		parent.runtime.registerProvider(PROVIDER, shared(), SOURCE);

		parent.runtime.pendingProviderRegistrations.forEach(entry => {
			registry.registerProvider(entry.name, entry.config, entry.sourceId);
		});

		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(parent.runtime));
	});

	test("an in-place forEach drain over one of two sessions' identical queues is refused with what to do", () => {
		const parent = owner();
		const child = owner();
		const config = shared();
		parent.runtime.registerProvider(PROVIDER, config, SOURCE);
		child.runtime.registerProvider(PROVIDER, config, SOURCE);

		expect(() =>
			parent.runtime.pendingProviderRegistrations.forEach(entry => {
				registry.registerProvider(entry.name, entry.config, entry.sourceId);
			}),
		).toThrow(
			`Provider "${PROVIDER}": queued registrations of this configuration by several sessions match, so which session this one belongs to cannot be told. Pass the record's owner, as registerProvider(entry.name, entry.config, entry.sourceId, entry.owner), or drain one queue at a time by taking its records out of the queue (for example with splice) before registering them.`,
		);
		expect(auth.usage.providerEntryFor(PROVIDER)).toBeUndefined();

		drain(parent.runtime);
		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(parent.runtime));
	});
});

describe("R19-3: discovery publishes only what the registration in force produced", () => {
	function discovering(
		fetch: () => Promise<readonly ModelDefinition[]>,
		extra: Partial<ProviderConfigInput> = {},
	): ProviderConfigInput {
		return {
			api: "openai-completions",
			baseUrl: "https://transitions.invalid/v1",
			apiKey: "key",
			fetchDynamicModels: fetch,
			...extra,
		};
	}

	test("a child withdrawn during its fetch publishes nothing; the parent keeps the provider", async () => {
		const parent = owner();
		const child = owner();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<readonly ModelDefinition[]>();
		registry.registerProvider(
			PROVIDER,
			discovering(async () => [model("parent")], { models: [model("parent")] }),
			SOURCE,
			parent.runtime,
		);
		registry.registerProvider(
			PROVIDER,
			discovering(async () => {
				entered.resolve();
				return finish.promise;
			}),
			SOURCE,
			child.runtime,
		);

		const pending = registry.refreshRuntimeProviders("online");
		await entered.promise;
		registry.unregisterProvider(PROVIDER, child.runtime);
		finish.resolve([model("departed-child")]);
		await pending;

		expect(ids()).not.toContain("departed-child");
		expect(ids()).toContain("parent");
	});

	test("the last registration withdrawn during its fetch resurrects no model", async () => {
		const only = owner();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<readonly ModelDefinition[]>();
		registry.registerProvider(
			PROVIDER,
			discovering(async () => {
				entered.resolve();
				return finish.promise;
			}),
			SOURCE,
			only.runtime,
		);

		const pending = registry.refreshRuntimeProviders("online");
		await entered.promise;
		registry.unregisterProvider(PROVIDER, only.runtime);
		finish.resolve([model("ghost")]);
		await pending;

		expect(ids()).toEqual([]);
	});

	test("rows that came back before a withdrawal are not published after it", async () => {
		const parent = owner();
		const child = owner();
		const other = owner();
		const childFetched = Promise.withResolvers<void>();
		const otherEntered = Promise.withResolvers<void>();
		const otherFinish = Promise.withResolvers<readonly ModelDefinition[]>();
		registry.registerProvider(
			PROVIDER,
			discovering(async () => [model("parent-dynamic")]),
			SOURCE,
			parent.runtime,
		);
		registry.registerProvider(
			PROVIDER,
			discovering(async () => {
				childFetched.resolve();
				return [model("child-dynamic")];
			}),
			SOURCE,
			child.runtime,
		);
		// A second provider whose discovery is still running holds the pass open after the child's
		// rows have come back.
		registry.registerProvider(
			OTHER_PROVIDER,
			discovering(async () => {
				otherEntered.resolve();
				return otherFinish.promise;
			}),
			SOURCE,
			other.runtime,
		);

		const pending = registry.refreshRuntimeProviders("online");
		await Promise.all([childFetched.promise, otherEntered.promise]);
		// The child's pipeline after its fetch is microtasks and synchronous cache I/O; one
		// macrotask turn lets all of it finish, so its rows are back and only publication is left.
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		registry.unregisterProvider(PROVIDER, child.runtime);
		otherFinish.resolve([model("other-dynamic")]);
		await pending;

		expect(ids()).not.toContain("child-dynamic");
		expect(ids(OTHER_PROVIDER)).toContain("other-dynamic");
	});

	test("a departed extension's discovered rows do not come back from the model cache", async () => {
		const parent = owner();
		const child = owner();
		registry.registerProvider(
			PROVIDER,
			discovering(async () => [model("parent-dynamic")]),
			SOURCE,
			parent.runtime,
		);
		registry.registerProvider(
			PROVIDER,
			discovering(async () => [model("child-dynamic")]),
			OTHER_SOURCE,
			child.runtime,
		);
		await registry.refreshRuntimeProviders("online");
		expect(ids()).toContain("child-dynamic");

		registry.unregisterProvider(PROVIDER, child.runtime);
		expect(ids()).not.toContain("child-dynamic");

		// The cache is fresh and holds the child's rows; the parent's discovery answers now.
		await registry.refreshRuntimeProviders("online-if-uncached");
		expect(ids()).not.toContain("child-dynamic");
		expect(ids()).toContain("parent-dynamic");
	});
});

describe("nested author data is read once, inside the registration's admission", () => {
	interface Access {
		readonly trap: string;
		readonly inside: boolean;
	}

	function recordingHeaders(runtime: ExtensionRuntime, accesses: Access[]): Record<string, string> {
		const note = (trap: string) => accesses.push({ trap, inside: extensionCallbackScope.getStore() === runtime });
		return new Proxy<Record<string, string>>(
			{ "x-transitions": "sentinel" },
			{
				ownKeys(target) {
					note("ownKeys");
					return Reflect.ownKeys(target);
				},
				getOwnPropertyDescriptor(target, key) {
					note("getOwnPropertyDescriptor");
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
				get(target, key, receiver) {
					note(`get:${String(key)}`);
					return Reflect.get(target, key, receiver);
				},
			},
		);
	}

	function recordingCompat(runtime: ExtensionRuntime, reads: boolean[]): NonNullable<ModelDefinition["compat"]> {
		const extraBody = {
			get transitionsTag(): string {
				reads.push(extensionCallbackScope.getStore() === runtime);
				return "sentinel";
			},
		};
		return { extraBody } as NonNullable<ModelDefinition["compat"]>;
	}

	async function request(cached: Model<Api>): Promise<void> {
		const output = streamSimple(
			cached,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{ apiKey: "key", fetch: fakeCompletions },
		);
		try {
			await output.result();
		} catch {}
	}

	test("a session's nested data is kept as registered: mutating it afterwards reaches no request", async () => {
		// The host half — a host registration's objects stay live — is pinned by
		// model-registry-runtime-provider.test.ts ("registerProvider keeps runtime header objects
		// live for request-time reads").
		const { runtime } = owner();
		const providerHeaders: Record<string, string> = { "X-Request-ID": "request-1" };
		const modelHeaders: Record<string, string> = { "X-Message-ID": "message-1" };
		registry.registerProvider(
			PROVIDER,
			{
				baseUrl: "https://transitions.invalid/v1",
				api: "openai-completions",
				apiKey: "key",
				headers: providerHeaders,
				models: [model("m", { headers: modelHeaders })],
			},
			SOURCE,
			runtime,
		);

		providerHeaders["X-Request-ID"] = "request-2";
		providerHeaders["X-Turn-ID"] = "turn-2";
		modelHeaders["X-Message-ID"] = "message-2";

		const cached = registry.find(PROVIDER, "m");
		if (!cached) throw new Error("model was not registered");
		expect(await registry.resolveModelHeaders(cached)).toEqual({
			"X-Request-ID": "request-1",
			"X-Message-ID": "message-1",
		});
	});

	test("a headers Proxy's traps run inside registration and never again", async () => {
		const { runtime, release } = owner();
		const accesses: Access[] = [];
		registry.registerProvider(
			PROVIDER,
			{
				headers: recordingHeaders(runtime, accesses),
				baseUrl: "https://transitions.invalid/v1",
				api: "openai-completions",
				apiKey: "key",
				models: [model()],
			},
			SOURCE,
			runtime,
		);
		expect(accesses.length).toBeGreaterThan(0);
		expect(accesses.filter(access => !access.inside)).toEqual([]);
		accesses.length = 0;

		await registry.getProviderHeaders(PROVIDER);
		const cached = registry.find(PROVIDER, "m");
		if (!cached) throw new Error("model was not registered");
		await registry.resolveModelHeaders(cached);
		release();
		await registry.getProviderHeaders(PROVIDER);

		expect(accesses).toEqual([]);
	});

	test("a registered model's nested compat getter is not read by a request after release", async () => {
		const { runtime, release } = owner();
		const reads: boolean[] = [];
		registry.registerProvider(
			PROVIDER,
			{
				api: "openai-completions",
				baseUrl: "https://transitions.invalid/v1",
				apiKey: "key",
				models: [model("m", { compat: recordingCompat(runtime, reads) })],
			},
			SOURCE,
			runtime,
		);
		const cached = registry.find(PROVIDER, "m");
		if (!cached) throw new Error("model was not registered");
		expect(reads.every(inside => inside)).toBe(true);
		reads.length = 0;

		release();
		await request(cached);

		expect(reads).toEqual([]);
	});

	test("a discovered row's nested compat getter is read inside discovery and never after", async () => {
		const { runtime, release } = owner();
		const reads: boolean[] = [];
		registry.registerProvider(
			PROVIDER,
			{
				api: "openai-completions",
				baseUrl: "https://transitions.invalid/v1",
				apiKey: "key",
				fetchDynamicModels: async () => [model("dynamic", { compat: recordingCompat(runtime, reads) })],
			},
			SOURCE,
			runtime,
		);
		await registry.refreshRuntimeProviders("online");
		const cached = registry.find(PROVIDER, "dynamic");
		if (!cached) throw new Error("model was not discovered");
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every(inside => inside)).toBe(true);
		reads.length = 0;

		release();
		await request(cached);

		expect(reads).toEqual([]);
	});

	test("a projected row's nested compat getter is read inside the projection and never after", async () => {
		const { runtime, release } = owner();
		const reads: boolean[] = [];
		const compat = recordingCompat(runtime, reads);
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			{
				api: "openai-completions",
				baseUrl: "https://transitions.invalid/v1",
				apiKey: "key",
				models: [model()],
				oauth: {
					name: "Transitions",
					login: async () => OAUTH_CREDENTIAL,
					modifyModels: rows =>
						rows.map(row => (row.provider === PROVIDER ? { ...row, compatConfig: compat } : row)),
				},
			},
			SOURCE,
			runtime,
		);
		const cached = registry.find(PROVIDER, "m");
		if (!cached) throw new Error("model was not registered");
		expect(reads.every(inside => inside)).toBe(true);
		reads.length = 0;

		release();
		await request(cached);

		expect(reads).toEqual([]);
	});
});

describe("a departing registration leaves the provider to the registration in force", () => {
	test("a different extension's child withdrawn: catalog, base URL, key and stream are the parent's", async () => {
		const parent = owner();
		const child = owner();
		const config = (label: string): ProviderConfigInput => ({
			baseUrl: `https://${label}.invalid/v1`,
			api: `${PROVIDER}-${label}` as Api,
			apiKey: `${label}-key`,
			models: [model(label)],
			streamSimple: () => createAssistantMessageEventStream(),
		});
		registry.registerProvider(PROVIDER, config("parent"), SOURCE, parent.runtime);
		registry.registerProvider(PROVIDER, config("child"), OTHER_SOURCE, child.runtime);

		registry.unregisterProvider(PROVIDER, child.runtime);

		const models = registry.getProviderModels(PROVIDER);
		expect({
			ids: models.map(entry => entry.id),
			baseUrl: registry.getProviderBaseUrl(PROVIDER),
			key: await registry.getApiKeyForProvider(PROVIDER),
			dispatchable: models.map(entry => getCustomApi(entry.api) !== undefined),
		}).toEqual({ ids: ["parent"], baseUrl: "https://parent.invalid/v1", key: "parent-key", dispatchable: [true] });
	});

	test("one host source handing off to another leaves a session's live usage provider", () => {
		const parent = owner();
		registry.registerProvider(
			PROVIDER,
			{ apiKey: "parent", usage: { id: PROVIDER, fetchUsage: async () => report("parent") } },
			SOURCE,
			parent.runtime,
		);
		registry.registerProvider(
			PROVIDER,
			{ apiKey: "host", usage: { id: PROVIDER, fetchUsage: async () => report("host") } },
			HOST_SOURCE,
		);

		registry.registerProvider(PROVIDER, { apiKey: "host2" }, OTHER_HOST_SOURCE);

		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(parent.runtime));
	});

	test("clearing a host source leaves a session's live usage provider", () => {
		const parent = owner();
		registry.registerProvider(
			PROVIDER,
			{ apiKey: "parent", usage: { id: PROVIDER, fetchUsage: async () => report("parent") } },
			SOURCE,
			parent.runtime,
		);
		registry.registerProvider(
			PROVIDER,
			{ apiKey: "host", usage: { id: PROVIDER, fetchUsage: async () => report("host") } },
			HOST_SOURCE,
		);

		registry.clearSourceRegistrations(HOST_SOURCE);

		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(parent.runtime));
	});

	for (const departure of ["retired", "withdrawn"] as const) {
		test(`a cached resolver the ${departure} child's projection produced answers from the parent's`, async () => {
			const parent = owner();
			const child = owner();
			const calls: string[] = [];
			await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
			for (const [label, session] of [
				["parent", parent],
				["child", child],
			] as const) {
				registry.registerProvider(
					PROVIDER,
					{
						baseUrl: "https://transitions.invalid/v1",
						api: "openai-completions",
						models: [model()],
						oauth: {
							name: "Transitions",
							login: async () => OAUTH_CREDENTIAL,
							modifyModels: rows =>
								rows.map(row =>
									row.provider === PROVIDER
										? {
												...row,
												resolveHeaders: async () => {
													calls.push(label);
													return { "x-owner": label };
												},
											}
										: row,
								),
						},
					},
					SOURCE,
					session.runtime,
				);
			}
			const cached = registry.find(PROVIDER, "m");
			if (!cached) throw new Error("model was not registered");

			if (departure === "retired") child.release();
			else registry.unregisterProvider(PROVIDER, child.runtime);

			await expect(registry.resolveModelHeaders(cached)).resolves.toEqual({ "x-owner": "parent" });
			expect(calls).toEqual(["parent"]);
		});
	}
});
