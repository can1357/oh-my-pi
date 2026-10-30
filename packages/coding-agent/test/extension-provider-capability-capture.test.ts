/**
 * Validate and use the same read; never two reads of the same name.
 *
 * A capability `registerProvider` accepts is read once, when the registration is admitted, and
 * the captured function is what every later use applies — on the author's own object. Reading a
 * name to decide a capability exists and reading it again to call it is two calls into the
 * extension, and an author's getter is free to answer differently: the registry served a
 * substitute's stream, persisted a substitute's models, and threw on a capability it had just
 * proved. This covers all three capabilities at once because the mechanism is one mechanism; a
 * fourth would belong here without a fourth test.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import { getCustomApi } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "capability-capture";
const API_ID = "capability-capture-api";
const SOURCE = "<inline-0>";

let dir: TempDir;
let auth: AuthStorage;
let registry: ModelRegistry;
let runtime: ExtensionRuntime;
let release: () => void;

beforeEach(async () => {
	dir = TempDir.createSync("@capability-capture-");
	auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	registry = new ModelRegistry(auth, path.join(dir.path(), "models.json"));
	runtime = new ExtensionRuntime();
	release = runtime.beginSession();
});

afterEach(() => {
	release();
	registry.clearSourceRegistrations(SOURCE);
	auth.close();
	dir.removeSync();
});

/** A property that answers once with `first` and thereafter with `rest`, counting its reads. */
function oneShot<T>(target: object, key: string, first: T, rest: T): { reads: () => number } {
	let reads = 0;
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: true,
		get: () => {
			reads++;
			return reads === 1 ? first : rest;
		},
	});
	return { reads: () => reads };
}

const MODEL = {
	id: "capability-capture-model",
	name: "Capability Capture",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 100,
};

test("a capability is captured once at admission and applied on the author's own object", async () => {
	const calls: string[] = [];
	// Each capability is written as a method on an object with private state, so applying the
	// captured function anywhere but its own receiver would throw rather than quietly pass.
	class Oauth {
		readonly #tag = "authored";
		name = "Capability capture";
		login = async () => ({ access: "a", refresh: "r", expires: Date.now() + 3_600_000 });
		getApiKey = (credentials: { access: string }) => credentials.access;
		authoredModifyModels(models: Record<string, unknown>[]): Record<string, unknown>[] {
			calls.push(`modifyModels:${this.#tag}`);
			return models.map(model => (model.provider === PROVIDER ? { ...model, name: this.#tag } : model));
		}
	}
	const oauth = new Oauth();
	const substituteModify = (models: Record<string, unknown>[]): Record<string, unknown>[] =>
		models.map(model => (model.provider === PROVIDER ? { ...model, name: "substitute" } : model));
	const modifyReads = oneShot(oauth, "modifyModels", oauth.authoredModifyModels, substituteModify);

	/** The smallest thing the stream contract accepts: it iterates and reports a terminal. */
	const producer = (marker: string) => ({
		marker,
		async *[Symbol.asyncIterator]() {},
		result: async () => ({ marker }),
	});

	class Config {
		readonly #tag = "authored";
		api = API_ID;
		baseUrl = "https://capability.invalid/v1";
		apiKey = "CAPABILITY_KEY";
		oauth = oauth;
		models = [MODEL];
		authoredStream = () => {
			calls.push(`streamSimple:${this.#tag}`);
			return producer(this.#tag);
		};
		authoredDiscovery = async () => {
			calls.push(`fetchDynamicModels:${this.#tag}`);
			return [];
		};
	}
	const config = new Config();
	const streamReads = oneShot(config, "streamSimple", config.authoredStream, () => {
		calls.push("streamSimple:substitute");
		return producer("substitute");
	});
	const discoveryReads = oneShot(config, "fetchDynamicModels", config.authoredDiscovery, async () => {
		calls.push("fetchDynamicModels:substitute");
		return [];
	});

	// A credential, so the credential-aware projection runs at registration.
	await auth.credentials.set(PROVIDER, {
		type: "oauth",
		access: "capability-access",
		refresh: "capability-refresh",
		expires: Date.now() + 3_600_000,
	});

	registry.registerProvider(PROVIDER, config as never, SOURCE, runtime);

	// Every capability was read exactly once, at admission.
	expect({
		modifyModels: modifyReads.reads(),
		streamSimple: streamReads.reads(),
		fetchDynamicModels: discoveryReads.reads(),
	}).toEqual({ modifyModels: 1, streamSimple: 1, fetchDynamicModels: 1 });

	// And each use runs the function that read produced, on its own receiver.
	expect(registry.find(PROVIDER, MODEL.id)?.name).toBe("authored");
	getCustomApi(API_ID)?.streamSimple({ id: MODEL.id, provider: PROVIDER } as never, { messages: [] } as never);
	await registry.refreshRuntimeProviders("online").catch(() => undefined);

	// The projection reruns whenever the catalog is recomposed; what matters is that every run
	// of every capability is the authored one, never the substitute a second read would give.
	expect([...new Set(calls)].sort()).toEqual([
		"fetchDynamicModels:authored",
		"modifyModels:authored",
		"streamSimple:authored",
	]);
	expect({
		modifyModels: modifyReads.reads(),
		streamSimple: streamReads.reads(),
		fetchDynamicModels: discoveryReads.reads(),
	}).toEqual({ modifyModels: 1, streamSimple: 1, fetchDynamicModels: 1 });
}, 20_000);
