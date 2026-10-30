/**
 * Round-eighteen regressions for what `ModelRegistry` does with an extension's provider
 * configuration between the moment it is queued and the moment its last registration goes.
 *
 * Each `describe` holds one review finding: who a queued registration belongs to, which reads
 * of the author's object are admitted, which receiver a stored method runs on, who owns a
 * callback a modifier produced, and what a withdrawal or a second source takes away.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	type Api,
	clearCustomApis,
	createAssistantMessageEventStream,
	getCustomApi,
	type Model,
	registerCustomApi,
	streamSimple,
	unregisterCustomApi,
} from "@oh-my-pi/pi-ai";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { providerCallGate } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/callback-ownership";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { extensionCallbackScope } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "registration-boundaries";
const SOURCE = "ext://registration-boundaries";
const OTHER_SOURCE = "ext://registration-boundaries-other";
const API_ID = "registration-boundaries-api";
const MODEL: NonNullable<ProviderConfigInput["models"]>[number] = {
	id: "m",
	name: "Original",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 100,
};
const OAUTH_CREDENTIAL = {
	type: "oauth" as const,
	access: "access",
	refresh: "refresh",
	expires: Date.now() + 3_600_000,
};

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

beforeEach(async () => {
	dir = TempDir.createSync("@registration-boundaries-");
	auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	registry = new ModelRegistry(auth, path.join(dir.path(), "models.json"));
});

afterEach(() => {
	for (const release of releases.splice(0)) release();
	registry.clearSourceRegistrations([SOURCE, OTHER_SOURCE]);
	clearCustomApis();
	unregisterOAuthProviders(SOURCE);
	unregisterOAuthProviders(OTHER_SOURCE);
	auth.close();
	dir.removeSync();
});

describe("R17-5: a queued registration belongs to the session that queued it", () => {
	test("one configuration object queued by two sessions keeps both owners", async () => {
		const parent = owner();
		const child = owner();
		const config: ProviderConfigInput = {
			apiKey: "key",
			usage: { id: PROVIDER, fetchUsage: async () => report("shared") },
		};
		parent.runtime.registerProvider(PROVIDER, config, SOURCE);
		child.runtime.registerProvider(PROVIDER, config, SOURCE);
		drain(parent.runtime);
		drain(child.runtime);

		child.release();

		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(parent.runtime));
		await expect(auth.usage.reports({ provider: PROVIDER })).resolves.toHaveLength(1);
	});

	test("the author's object stays reusable by a later session", () => {
		const first = owner();
		const second = owner();
		const config: ProviderConfigInput = { apiKey: "key", usage: { id: PROVIDER, fetchUsage: async () => null } };
		first.runtime.registerProvider(PROVIDER, config, SOURCE);
		drain(first.runtime);
		first.release();

		second.runtime.registerProvider(PROVIDER, config, SOURCE);
		drain(second.runtime);

		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(second.runtime));
	});

	test("a registration withdrawn from the queue lends its owner to nobody", () => {
		const withdrawn = owner();
		const queued = owner();
		const config: ProviderConfigInput = { apiKey: "key", usage: { id: PROVIDER, fetchUsage: async () => null } };
		withdrawn.runtime.registerProvider(PROVIDER, config, SOURCE);
		withdrawn.runtime.unregisterProvider(PROVIDER);
		queued.runtime.registerProvider(PROVIDER, config, SOURCE);
		drain(queued.runtime);

		expect(auth.usage.providerEntryFor(PROVIDER)?.gate).toBe(providerCallGate(queued.runtime));
	});
});

describe("R17-3: registration reads the author's configuration once, inside its admission", () => {
	/** A configuration whose every top-level field is a getter recording where it was read. */
	function instrumented(runtime: ExtensionRuntime): { config: ProviderConfigInput; reads: Map<string, boolean[]> } {
		const reads = new Map<string, boolean[]>();
		const values: Record<string, () => unknown> = {
			baseUrl: () => "https://boundaries.invalid/v1",
			apiKey: () => "key",
			api: () => API_ID,
			headers: () => undefined,
			authHeader: () => undefined,
			compat: () => undefined,
			remoteCompaction: () => undefined,
			transport: () => undefined,
			usage: () => undefined,
			oauth: () => undefined,
			streamSimple: () => () => createAssistantMessageEventStream(),
			fetchDynamicModels: () => async () => [],
			models: () => [MODEL],
		};
		const config = {};
		for (const [key, value] of Object.entries(values)) {
			Object.defineProperty(config, key, {
				enumerable: true,
				get: () => {
					const seen = reads.get(key) ?? [];
					seen.push(extensionCallbackScope.getStore() === runtime);
					reads.set(key, seen);
					return value();
				},
			});
		}
		return { config: config as ProviderConfigInput, reads };
	}

	for (const phase of ["queued", "direct"] as const) {
		test(`${phase}: each field is read once and inside the owning session`, () => {
			const { runtime } = owner();
			const { config, reads } = instrumented(runtime);
			if (phase === "queued") {
				runtime.registerProvider(PROVIDER, config, SOURCE);
				drain(runtime);
			} else {
				registry.registerProvider(PROVIDER, config, SOURCE, runtime);
			}

			expect(reads.size).toBeGreaterThan(0);
			for (const [key, seen] of reads) expect({ key, seen }).toEqual({ key, seen: [true] });
		});

		test(`${phase}: a retired owner's configuration is not evaluated at all`, () => {
			const { runtime, release } = owner();
			const { config, reads } = instrumented(runtime);
			if (phase === "queued") {
				runtime.registerProvider(PROVIDER, config, SOURCE);
				release();
				drain(runtime);
			} else {
				release();
				registry.registerProvider(PROVIDER, config, SOURCE, runtime);
			}

			expect([...reads.keys()]).toEqual([]);
			expect(registry.find(PROVIDER, MODEL.id)).toBeUndefined();
		});
	}
});

describe("R17-6: stored methods run on the author's object, read when they are used", () => {
	test("a modifier written as a class method keeps its receiver", async () => {
		const { runtime } = owner();
		class OAuth {
			name = "Boundaries";
			#label = "Projected";
			login = async () => OAUTH_CREDENTIAL;
			modifyModels(models: Model<Api>[]): Model<Api>[] {
				return models.map(model => (model.provider === PROVIDER ? { ...model, name: this.#label } : model));
			}
		}
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			{ baseUrl: "https://boundaries.invalid/v1", api: "openai-completions", models: [MODEL], oauth: new OAuth() },
			SOURCE,
			runtime,
		);

		expect(registry.find(PROVIDER, MODEL.id)?.name).toBe("Projected");
	});

	test("a modifier replaced after registration is not the one that runs", async () => {
		// Reversed deliberately. This pinned the dynamic per-call read, which was half of one
		// contract and half of another: the registry snapshots a registration's data, so
		// snapshotting its data and re-reading its methods meant a getter could answer twice and
		// differently. A capability is captured at admission like everything else, and
		// re-registering is how a provider changes one.
		const { runtime } = owner();
		let old = 0;
		let fresh = 0;
		const oauth: NonNullable<ProviderConfigInput["oauth"]> = {
			name: "Boundaries",
			login: async () => OAUTH_CREDENTIAL,
			modifyModels(models) {
				old++;
				return models;
			},
		};
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			{ baseUrl: "https://boundaries.invalid/v1", api: "openai-completions", models: [MODEL], oauth },
			SOURCE,
			runtime,
		);
		old = 0;
		oauth.modifyModels = models => {
			fresh++;
			return models;
		};
		await registry.refresh("offline");
		registry.getAll();

		expect({ old: old > 0, fresh }).toEqual({ old: true, fresh: 0 });
	});

	test("discovery written as a class method keeps its receiver", async () => {
		const { runtime } = owner();
		class Config {
			baseUrl = "https://boundaries.invalid/v1";
			api = "openai-completions" as const;
			apiKey = "key";
			#model = MODEL;
			async fetchDynamicModels() {
				return [this.#model];
			}
		}
		registry.registerProvider(PROVIDER, new Config(), SOURCE, runtime);
		await registry.refreshRuntimeProviders("online");

		expect(registry.find(PROVIDER, MODEL.id)).toBeDefined();
	});

	test("a retired session's projection gives way to the live parent's", async () => {
		const parent = owner();
		const child = owner();
		const config = (label: string): ProviderConfigInput => ({
			baseUrl: "https://boundaries.invalid/v1",
			api: "openai-completions",
			models: [MODEL],
			oauth: {
				name: "Boundaries",
				login: async () => OAUTH_CREDENTIAL,
				modifyModels: models =>
					models.map(model => (model.provider === PROVIDER ? { ...model, name: label } : model)),
			},
		});
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(PROVIDER, config("parent"), SOURCE, parent.runtime);
		registry.registerProvider(PROVIDER, config("child"), SOURCE, child.runtime);
		expect(registry.find(PROVIDER, MODEL.id)?.name).toBe("child");

		child.release();
		await registry.refresh("offline");

		expect(registry.find(PROVIDER, MODEL.id)?.name).toBe("parent");
	});

	test("a retired session's discovery gives way to the live parent's", async () => {
		const parent = owner();
		const child = owner();
		const config = (id: string): ProviderConfigInput => ({
			baseUrl: "https://boundaries.invalid/v1",
			api: "openai-completions",
			apiKey: "key",
			fetchDynamicModels: async () => [{ ...MODEL, id }],
		});
		registry.registerProvider(PROVIDER, config("parent-dynamic"), SOURCE, parent.runtime);
		registry.registerProvider(PROVIDER, config("child-dynamic"), SOURCE, child.runtime);

		child.release();
		await registry.refreshRuntimeProviders("online");

		expect(registry.find(PROVIDER, "parent-dynamic")).toBeDefined();
		expect(registry.find(PROVIDER, "child-dynamic")).toBeUndefined();
	});
});

describe("R17-2: a header resolver a modifier returned is owned by the registration that produced it", () => {
	test("the host stream consumer cannot reach it once that session is gone", async () => {
		const { runtime, release } = owner();
		const seen: boolean[] = [];
		const oauth: NonNullable<ProviderConfigInput["oauth"]> = {
			name: "Boundaries",
			login: async () => OAUTH_CREDENTIAL,
			modifyModels: models =>
				models.map(model =>
					model.provider === PROVIDER
						? {
								...model,
								resolveHeaders: async () => {
									seen.push(extensionCallbackScope.getStore() === runtime);
									return {};
								},
							}
						: model,
				),
		};
		await auth.credentials.set(PROVIDER, OAUTH_CREDENTIAL);
		registry.registerProvider(
			PROVIDER,
			{
				baseUrl: "https://boundaries.invalid/v1",
				api: API_ID,
				apiKey: "key",
				models: [MODEL],
				oauth,
				streamSimple: () => createAssistantMessageEventStream(),
			},
			SOURCE,
			runtime,
		);
		const cached = registry.find(PROVIDER, MODEL.id);
		if (!cached?.resolveHeaders) throw new Error("the modifier's resolver did not reach the model");

		// Live: the host's call runs as that session's work.
		await cached.resolveHeaders();
		expect(seen).toEqual([true]);

		release();
		try {
			await streamSimple(cached, { messages: [] }, { apiKey: "key" }).result();
		} catch {}

		expect(seen).toEqual([true]);
	});
});

describe("R17-4: withdrawal and a second source take away only the departing registration", () => {
	test("a session's public withdrawal leaves the parent's stream and catalog", () => {
		const parent = owner();
		const child = owner();
		const calls: string[] = [];
		const config = (label: string): ProviderConfigInput => ({
			baseUrl: "https://boundaries.invalid/v1",
			api: API_ID,
			apiKey: "key",
			models: [MODEL],
			streamSimple: () => {
				calls.push(label);
				return createAssistantMessageEventStream();
			},
		});
		registry.registerProvider(PROVIDER, config("parent"), SOURCE, parent.runtime);
		registry.registerProvider(PROVIDER, config("child"), SOURCE, child.runtime);
		const model = registry.find(PROVIDER, MODEL.id);
		if (!model) throw new Error("model was not registered");

		registry.unregisterProvider(PROVIDER, child.runtime);
		getCustomApi(API_ID)?.streamSimple(model, { messages: [] });

		expect(calls).toEqual(["parent"]);
		expect(registry.find(PROVIDER, MODEL.id)).toBeDefined();
	});

	test("a registration from a second source does not remove the first source's live usage", async () => {
		const parent = owner();
		const child = owner();
		const config = (label: string): ProviderConfigInput => ({
			apiKey: "key",
			usage: { id: PROVIDER, fetchUsage: async () => report(label) },
		});
		registry.registerProvider(PROVIDER, config("parent"), SOURCE, parent.runtime);
		registry.registerProvider(PROVIDER, config("child"), OTHER_SOURCE, child.runtime);

		child.release();
		const answer = await auth.usage.reports({ provider: PROVIDER });

		expect(answer?.map(entry => entry.metadata?.source)).toEqual(["parent"]);
	});

	test("withdrawing a second source's registration gives discovery back to the first", async () => {
		const parent = owner();
		const child = owner();
		registry.registerProvider(
			PROVIDER,
			{
				baseUrl: "https://boundaries.invalid/v1",
				api: "openai-completions",
				apiKey: "key",
				fetchDynamicModels: async () => [{ ...MODEL, id: "parent-dynamic" }],
			},
			SOURCE,
			parent.runtime,
		);
		registry.registerProvider(
			PROVIDER,
			{ baseUrl: "https://boundaries.invalid/v1", api: "openai-completions", apiKey: "key", models: [MODEL] },
			OTHER_SOURCE,
			child.runtime,
		);

		registry.unregisterProvider(PROVIDER, child.runtime);
		await registry.refreshRuntimeProviders("online");

		expect(registry.find(PROVIDER, "parent-dynamic")).toBeDefined();
	});

	test("removing one custom API registration leaves every other gate's, retired or not", () => {
		const parent = owner();
		const child = owner();
		const stream = () => createAssistantMessageEventStream();
		registerCustomApi(API_ID, stream, SOURCE, undefined, providerCallGate(parent.runtime));
		registerCustomApi(API_ID, stream, SOURCE, undefined, providerCallGate(child.runtime));
		registerCustomApi(API_ID, stream, SOURCE);

		parent.release();
		unregisterCustomApi(API_ID, providerCallGate(child.runtime));
		unregisterCustomApi(API_ID);
		expect(getCustomApi(API_ID)).toBeUndefined();

		// Retirement only stopped the parent's entry being selected; the next session it serves
		// finds it still registered.
		releases.push(parent.runtime.beginSession());
		expect(getCustomApi(API_ID)).toBeDefined();
	});
});
