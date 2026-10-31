/**
 * Round-twenty-two regressions for what `ModelRegistry` keeps of an extension's provider data, and
 * which registration answers once a discovery pass or a projected resolver outlives its own; and
 * round twenty-three's for the signal a projected resolver is handed.
 *
 * Each `describe` holds one finding: a model definition is copied by the fields a model has, not
 * by the keys its object enumerates; data an extension hands over holds no functions; a departed
 * discovery pass cannot roll the catalog back through the model cache; a departed projected
 * resolver's rejection gives way to the live registration as its fulfilment does; and the abort
 * signal a projected resolver is handed runs its listeners as its session's work, only until the
 * call is over.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as path from "node:path";
import { type Api, clearCustomApis, type Model, streamSimple } from "@oh-my-pi/pi-ai";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import {
	ModelRegistry,
	type ProviderConfigInput,
	type ProviderDiscoveryState,
} from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS } from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { extensionCallbackScope } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "registration-data";
const HOST_PROVIDER = "registration-data-host";
const SOURCE = "ext://registration-data";
const HOST_SOURCE = "host://registration-data";
const SOURCES = [SOURCE, HOST_SOURCE];
const BASE_URL = "https://registration-data.invalid/v1";
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

function ids(provider = PROVIDER): string[] {
	return registry.getProviderModels(provider).map(entry => entry.id);
}

function registered(provider = PROVIDER, id = "m"): Model<Api> {
	const found = registry.find(provider, id);
	if (!found) throw new Error(`${provider}/${id} is not registered`);
	return found;
}

/** A real request through the production serializer to an in-process endpoint. */
async function request(cached: Model<Api>): Promise<void> {
	const output = streamSimple(
		cached,
		{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
		{
			apiKey: "key",
			fetch: async () =>
				new Response(
					'data: {"id":"r","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				),
		},
	);
	try {
		await output.result();
	} catch {}
}

beforeEach(async () => {
	dir = TempDir.createSync("@registration-data-");
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

describe("R21-4: a session's model definition is copied by the fields a model has", () => {
	/** An ordinary model class: its `id` is a prototype getter, as a class writes one. */
	class Definition {
		get id(): string {
			return "m";
		}
		name = "m";
		reasoning = false;
		input: ("text" | "image")[] = ["text"];
		cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		contextWindow = 10_000;
		maxTokens = 100;
	}

	function provider(models: ModelDefinition[]): ProviderConfigInput {
		return { api: "openai-completions", baseUrl: BASE_URL, apiKey: "key", models };
	}

	test("a model class whose id is a prototype getter registers as it does for the host", () => {
		const { runtime } = owner();

		registry.registerProvider(HOST_PROVIDER, provider([new Definition()]), HOST_SOURCE);
		registry.registerProvider(PROVIDER, provider([new Definition()]), SOURCE, runtime);

		expect({ host: ids(HOST_PROVIDER), extension: ids() }).toEqual({ host: ["m"], extension: ["m"] });
	});

	for (const shape of ["inherited", "non-enumerable"] as const) {
		test(`a definition whose every field is ${shape} registers`, () => {
			const { runtime } = owner();
			const plain = model();
			let row: ModelDefinition;
			if (shape === "inherited") {
				row = Object.create(plain);
			} else {
				row = {} as ModelDefinition;
				for (const [key, value] of Object.entries(plain)) Object.defineProperty(row, key, { value });
			}

			registry.registerProvider(PROVIDER, provider([row]), SOURCE, runtime);

			expect(ids()).toEqual(["m"]);
		});
	}

	test("a known shape nested in a definition keeps its inherited fields", () => {
		const { runtime } = owner();

		registry.registerProvider(
			PROVIDER,
			provider([model("m", { cost: Object.create({ input: 3, output: 5, cacheRead: 1, cacheWrite: 2 }) })]),
			SOURCE,
			runtime,
		);

		const { input, output, cacheRead, cacheWrite } = registered().cost;
		expect({ input, output, cacheRead, cacheWrite }).toEqual({ input: 3, output: 5, cacheRead: 1, cacheWrite: 2 });
	});

	test("a discovered row is read by the same fields", async () => {
		const { runtime } = owner();
		registry.registerProvider(
			PROVIDER,
			{
				api: "openai-completions",
				baseUrl: BASE_URL,
				apiKey: "key",
				fetchDynamicModels: async () => [new Definition()],
			},
			SOURCE,
			runtime,
		);

		await registry.refreshRuntimeProviders("online");

		expect(ids()).toEqual(["m"]);
	});

	test("a projected row is read by the fields a model has", async () => {
		const { runtime } = owner();
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			{
				...provider([model()]),
				oauth: {
					name: "Registration data",
					login: async () => OAUTH_CREDENTIAL,
					// Every field of the projected row is inherited; the new name is non-enumerable.
					modifyModels: rows =>
						rows.map(row =>
							row.provider === PROVIDER ? Object.create(row, { name: { value: "Renamed" } }) : row,
						),
				},
			},
			SOURCE,
			runtime,
		);

		expect(ids()).toEqual(["m"]);
		expect(registered().name).toBe("Renamed");
	});
});

describe("R21-2: data an extension hands over holds no functions", () => {
	function provider(extra: Partial<ProviderConfigInput>): ProviderConfigInput {
		return { api: "openai-completions", baseUrl: BASE_URL, apiKey: "key", models: [model()], ...extra };
	}

	test("a serializer hook nested in compat is refused at registration, naming the field", () => {
		const { runtime } = owner();
		let calls = 0;
		const compat = {
			extraBody: {
				nested: {
					toJSON() {
						calls++;
						return { tag: "serialized" };
					},
				},
			},
		} as NonNullable<ModelDefinition["compat"]>;

		expect(() =>
			registry.registerProvider(PROVIDER, provider({ models: [model("m", { compat })] }), SOURCE, runtime),
		).toThrow(
			`Provider ${PROVIDER}: models[0].compat.extraBody.nested.toJSON is a function, but it must be data. Compute the value before registering the provider.`,
		);
		expect(ids()).toEqual([]);
		expect(calls).toBe(0);
	});

	test("a callable record is refused rather than kept", () => {
		const { runtime } = owner();
		let reads = 0;
		const callable = new Proxy(
			Object.assign(() => {}, { nested: { tag: "callable" } }),
			{
				ownKeys(target) {
					reads++;
					return Reflect.ownKeys(target);
				},
			},
		);
		const compat = { extraBody: callable } as unknown as NonNullable<ModelDefinition["compat"]>;

		expect(() =>
			registry.registerProvider(PROVIDER, provider({ models: [model("m", { compat })] }), SOURCE, runtime),
		).toThrow(`Provider ${PROVIDER}: models[0].compat.extraBody is a function, but it must be data.`);
		expect(ids()).toEqual([]);
		expect(reads).toBe(0);
	});

	test("a provider-level header computed by a function is refused, naming the header", () => {
		const { runtime } = owner();
		const headers = { "x-computed": () => "value" } as unknown as Record<string, string>;

		expect(() => registry.registerProvider(PROVIDER, provider({ headers }), SOURCE, runtime)).toThrow(
			`Provider ${PROVIDER}: headers["x-computed"] is a function, but it must be data.`,
		);
	});

	test("a discovered row carrying a function is not published, and the function never runs", async () => {
		const { runtime, release } = owner();
		let calls = 0;
		const compat = {
			extraBody: {
				nested: {
					toJSON() {
						calls++;
						return { tag: "serialized" };
					},
				},
			},
		} as NonNullable<ModelDefinition["compat"]>;
		registry.registerProvider(
			PROVIDER,
			{
				api: "openai-completions",
				baseUrl: BASE_URL,
				apiKey: "key",
				models: [model("static")],
				fetchDynamicModels: async () => [model("dynamic", { compat })],
			},
			SOURCE,
			runtime,
		);

		await registry.refreshRuntimeProviders("online");
		release();
		for (const id of ids()) await request(registered(PROVIDER, id));

		expect(ids()).not.toContain("dynamic");
		expect(calls).toBe(0);
	});

	test("a projected row carrying a function is not applied, and the function never runs", async () => {
		const { runtime, release } = owner();
		let calls = 0;
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			provider({
				oauth: {
					name: "Registration data",
					login: async () => OAUTH_CREDENTIAL,
					modifyModels: rows =>
						rows.map(row =>
							row.provider === PROVIDER
								? {
										...row,
										name: "Projected",
										compatConfig: {
											extraBody: {
												nested: {
													toJSON() {
														calls++;
														return { tag: "serialized" };
													},
												},
											},
										},
									}
								: row,
						),
				},
			}),
			SOURCE,
			runtime,
		);

		const cached = registered();
		release();
		await request(cached);

		expect(cached.name).toBe("m");
		expect(calls).toBe(0);
	});
});

describe("R21-3: a departed discovery pass cannot roll the catalog back through the model cache", () => {
	interface DepartedPass {
		/** The withdrawn child's pass, still waiting on its fetch. */
		readonly departing: Promise<void>;
		readonly finish: PromiseWithResolvers<readonly ModelDefinition[]>;
		/** The catalog and discovery state after the parent's newer pass. */
		readonly before: { ids: string[]; state: ProviderDiscoveryState | undefined };
	}

	/** Parent discovers `old`; the child's pass starts and waits on its fetch; the child is
	 *  withdrawn; the parent discovers `new`. */
	async function departedPass(): Promise<DepartedPass> {
		const parent = owner();
		const child = owner();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<readonly ModelDefinition[]>();
		let version = "old";
		const discovering = (fetchDynamicModels: () => Promise<readonly ModelDefinition[]>): ProviderConfigInput => ({
			api: "openai-completions",
			baseUrl: BASE_URL,
			apiKey: "key",
			fetchDynamicModels,
		});
		registry.registerProvider(
			PROVIDER,
			discovering(async () => [model(version)]),
			SOURCE,
			parent.runtime,
		);
		await registry.refreshRuntimeProviders("online");
		registry.registerProvider(
			PROVIDER,
			discovering(async () => {
				entered.resolve();
				return finish.promise;
			}),
			SOURCE,
			child.runtime,
		);
		const departing = registry.refreshRuntimeProviders("online");
		await entered.promise;
		registry.unregisterProvider(PROVIDER, child.runtime);
		version = "new";
		await registry.refreshRuntimeProviders("online");
		return { departing, finish, before: { ids: ids(), state: registry.getProviderDiscoveryState(PROVIDER) } };
	}

	for (const outcome of ["resolve", "reject"] as const) {
		test(`a withdrawn child's fetch that settles (${outcome}) after the parent's newer pass leaves the parent's catalog`, async () => {
			const { departing, finish, before } = await departedPass();

			if (outcome === "resolve") finish.resolve([model("departed")]);
			else finish.reject(new Error("departed child failed"));
			await departing;

			expect(before.ids).toEqual(["new"]);
			expect({ ids: ids(), state: registry.getProviderDiscoveryState(PROVIDER) }).toEqual(before);
		});
	}

	test("a withdrawn child's pass that times out after the parent's newer pass leaves the parent's state", async () => {
		jest.useFakeTimers();
		try {
			const { departing, before } = await departedPass();

			jest.advanceTimersByTime(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS);
			await departing;

			expect(before.ids).toEqual(["new"]);
			expect({ ids: ids(), state: registry.getProviderDiscoveryState(PROVIDER) }).toEqual(before);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a live discovery whose fetch fails still serves no other source's cached rows", async () => {
		const parent = owner();
		const child = owner();
		registry.registerProvider(
			PROVIDER,
			{
				api: "openai-completions",
				baseUrl: BASE_URL,
				apiKey: "key",
				fetchDynamicModels: async () => [model("parent")],
			},
			SOURCE,
			parent.runtime,
		);
		await registry.refreshRuntimeProviders("online");
		registry.registerProvider(
			PROVIDER,
			{
				api: "openai-completions",
				baseUrl: BASE_URL,
				apiKey: "key",
				fetchDynamicModels: async () => {
					throw new Error("child fetch failed");
				},
			},
			"ext://registration-data-other",
			child.runtime,
		);

		await registry.refreshRuntimeProviders("online");

		expect(ids()).not.toContain("parent");
		registry.clearSourceRegistrations("ext://registration-data-other");
	});
});

describe("R21-5: a departed projected resolver's rejection gives way to the live registration", () => {
	function projecting(label: string, resolve: () => Promise<Record<string, string>>): ProviderConfigInput {
		return {
			api: "openai-completions",
			baseUrl: BASE_URL,
			models: [model()],
			oauth: {
				name: `Registration data ${label}`,
				login: async () => OAUTH_CREDENTIAL,
				modifyModels: rows =>
					rows.map(row => (row.provider === PROVIDER ? { ...row, resolveHeaders: resolve } : row)),
			},
		};
	}

	test("a child's resolver rejecting after the child withdrew answers from the parent", async () => {
		const parent = owner();
		const child = owner();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<Record<string, string>>();
		let parentCalls = 0;
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			projecting("parent", async () => {
				parentCalls++;
				return { "x-owner": "parent" };
			}),
			SOURCE,
			parent.runtime,
		);
		registry.registerProvider(
			PROVIDER,
			projecting("child", () => {
				entered.resolve();
				return finish.promise;
			}),
			SOURCE,
			child.runtime,
		);

		const pending = registry.resolveModelHeaders(registered());
		await entered.promise;
		registry.unregisterProvider(PROVIDER, child.runtime);
		finish.reject(new Error("departed resolver failed"));

		await expect(pending).resolves.toEqual({ "x-owner": "parent" });
		expect(parentCalls).toBe(1);
	});

	test("a resolver rejecting while its registration still answers keeps its error", async () => {
		const only = owner();
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			projecting("only", async () => {
				throw new Error("live resolver failed");
			}),
			SOURCE,
			only.runtime,
		);

		await expect(registry.resolveModelHeaders(registered())).rejects.toThrow("live resolver failed");
	});
});

describe("R23-3: a projected resolver's abort listener runs as its session's work, until its call is over", () => {
	/** A projection whose resolver for `provider`'s rows is `resolve`. */
	function projecting(
		provider: string,
		resolve: (signal?: AbortSignal) => Promise<Record<string, string>>,
	): ProviderConfigInput {
		return {
			api: "openai-completions",
			baseUrl: BASE_URL,
			apiKey: "key",
			models: [model()],
			oauth: {
				name: `Signal ${provider}`,
				login: async () => OAUTH_CREDENTIAL,
				modifyModels: rows =>
					rows.map(row => (row.provider === provider ? { ...row, resolveHeaders: resolve } : row)),
			},
		};
	}

	/** The abort listeners `signal` still holds, as its own add/remove calls report them. */
	function abortListeners(signal: AbortSignal): Set<unknown> {
		const listening = new Set<unknown>();
		const add = signal.addEventListener.bind(signal);
		const remove = signal.removeEventListener.bind(signal);
		signal.addEventListener = (...args: Parameters<typeof add>) => {
			if (args[0] === "abort") listening.add(args[1]);
			add(...args);
		};
		signal.removeEventListener = (...args: Parameters<typeof remove>) => {
			if (args[0] === "abort") listening.delete(args[1]);
			remove(...args);
		};
		return listening;
	}

	test("an abort during the call reaches the resolver's listener as its session's work, with a copy of the caller's reason", async () => {
		const { runtime } = owner();
		const entered = Promise.withResolvers<void>();
		const ran: Array<{ inside: boolean; retired: boolean; reason: unknown }> = [];
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			projecting(PROVIDER, signal => {
				const done = Promise.withResolvers<Record<string, string>>();
				signal!.addEventListener(
					"abort",
					() => {
						ran.push({
							inside: extensionCallbackScope.getStore() === runtime,
							retired: runtime.isRetired,
							reason: signal!.reason,
						});
						done.resolve({ "x-aborted": "true" });
					},
					{ once: true },
				);
				entered.resolve();
				return done.promise;
			}),
			SOURCE,
			runtime,
		);
		const caller = new AbortController();
		const reason = new Error("caller aborted");

		const pending = registered().resolveHeaders!(caller.signal);
		await entered.promise;
		caller.abort(reason);

		await expect(pending).resolves.toEqual({ "x-aborted": "true" });
		expect(ran).toHaveLength(1);
		expect(ran[0]).toMatchObject({ inside: true, retired: false });
		// The reason is the caller's own object, which it reads again after the abort: a copy crosses.
		expect(ran[0]!.reason).not.toBe(reason);
		expect(ran[0]!.reason).toBeInstanceOf(Error);
		expect((ran[0]!.reason as Error).message).toBe("caller aborted");
	});

	test("once the call is over and its session gone, an abort reaches no resolver listener", async () => {
		const { runtime, release } = owner();
		const ran: Array<{ inside: boolean; retired: boolean }> = [];
		let calls = 0;
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			projecting(PROVIDER, async signal => {
				calls++;
				signal!.addEventListener(
					"abort",
					() => ran.push({ inside: extensionCallbackScope.getStore() === runtime, retired: runtime.isRetired }),
					{ once: true },
				);
				return { "x-done": "true" };
			}),
			SOURCE,
			runtime,
		);
		const caller = new AbortController();

		await registered().resolveHeaders!(caller.signal);
		await runtime.waitForPendingCallbacks();
		release();
		caller.abort("after the terminal");

		expect(calls).toBe(1);
		expect(ran).toEqual([]);
	});

	test("a long-lived caller signal keeps no listener across calls, fulfilled or failed", async () => {
		const { runtime } = owner();
		let calls = 0;
		let failing = false;
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			projecting(PROVIDER, async signal => {
				calls++;
				signal!.addEventListener("abort", () => {});
				if (failing) throw new Error("resolver failed");
				return { "x-done": "true" };
			}),
			SOURCE,
			runtime,
		);
		const caller = new AbortController();
		const listeners = abortListeners(caller.signal);
		const left: number[] = [];

		for (let round = 0; round < 3; round++) {
			failing = false;
			await registered().resolveHeaders!(caller.signal);
			left.push(listeners.size);
			failing = true;
			await expect(registered().resolveHeaders!(caller.signal)).rejects.toThrow("resolver failed");
			left.push(listeners.size);
		}

		expect(calls).toBe(6);
		expect(left).toEqual([0, 0, 0, 0, 0, 0]);
	});

	test("a host registration's resolver is handed the caller's own signal", async () => {
		const handed: Array<AbortSignal | undefined> = [];
		await auth.credentials.set(HOST_PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			HOST_PROVIDER,
			projecting(HOST_PROVIDER, async signal => {
				handed.push(signal);
				return {};
			}),
			HOST_SOURCE,
		);
		const caller = new AbortController();

		await registered(HOST_PROVIDER).resolveHeaders!(caller.signal);

		expect(handed).toHaveLength(1);
		expect(handed[0]).toBe(caller.signal);
	});
});
