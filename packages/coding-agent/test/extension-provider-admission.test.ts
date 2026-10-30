/**
 * Measures the admission boundary instead of arguing about it.
 *
 * Four rounds of review each agreed the list of places the host calls into an extension's
 * provider, and each round found more: a getter evaluated to find a callback, a configuration
 * field read at registration, a header resolver a modifier returned, a stream still producing
 * after its session went. "Is the enumeration complete?" is not a question a reading of the code
 * can keep answering.
 *
 * So the provider registered here is instrumented rather than described: **every** property is a
 * getter and every function records, at the moment it runs, whether it is running inside its
 * owning session's admission scope. The product surface is then driven twice — once while the
 * session is live, once after it has gone — and two things are asserted of every recording:
 *
 *   while live:  every read and every call happened inside that session's admission;
 *   once gone:   there is no read and no call at all.
 *
 * A new consumer that reaches author code without asking shows up here as a recorded access with
 * `inside: false`, or as an access after release, whoever writes it and whenever they write it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { getCustomApi } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { EventBus, extensionCallbackScope } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/** One access to an author-defined property or function, and where it happened. */
interface Access {
	/** Dotted path of the property, e.g. `usage.fetchUsage`. */
	readonly path: string;
	/** `read` for evaluating the property, `call` for running the function it produced. */
	readonly kind: "read" | "call";
	/** Whether the owning session's admission scope was active. */
	readonly inside: boolean;
	/** Whether that session had already released its hold. */
	readonly afterRelease: boolean;
}

const PROVIDER = "admission-harness-provider";
const API_ID = "admission-harness-api";
const MODEL_ID = "admission-harness-model";
const SOURCE_ID = "<inline-0>";

describe("every path into an extension's provider is admitted", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let runtime: ExtensionRuntime;
	let release: () => void;
	let accesses: Access[];
	let released: boolean;

	beforeEach(async () => {
		dir = TempDir.createSync("@admission-harness-");
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		registry = new ModelRegistry(auth, path.join(dir.path(), "models.json"));
		runtime = new ExtensionRuntime();
		release = runtime.beginSession();
		accesses = [];
		released = false;
	});

	afterEach(() => {
		release();
		registry.clearSourceRegistrations(SOURCE_ID);
		auth.close();
		dir.removeSync();
	});

	function note(accessPath: string, kind: "read" | "call"): void {
		accesses.push({
			path: accessPath,
			kind,
			inside: extensionCallbackScope.getStore() === runtime,
			afterRelease: released,
		});
	}

	/** A function that records its own invocation before doing the author's work. */
	function authored<A extends unknown[], R>(accessPath: string, body: (...args: A) => R): (...args: A) => R {
		return function (this: unknown, ...args: A): R {
			note(accessPath, "call");
			return body.apply(this, args);
		};
	}

	/**
	 * Builds an object whose every property is a getter that records being read. The value a
	 * getter produces is built fresh on each read, exactly as a provider written with accessors
	 * would behave, so a consumer that reads twice is visible as two reads.
	 */
	function instrument<T extends object>(prefix: string, members: { [K in keyof T]: () => T[K] }): T {
		const target = {} as T;
		for (const key of Object.keys(members) as (keyof T & string)[]) {
			Object.defineProperty(target, key, {
				enumerable: true,
				configurable: true,
				get: () => {
					note(`${prefix}${key}`, "read");
					return members[key]();
				},
			});
		}
		return target;
	}

	function buildConfig(): Record<string, unknown> {
		const usage = instrument<Record<string, unknown>>("usage.", {
			id: () => PROVIDER,
			cacheVersion: () => 1,
			supports: () => authored("usage.supports", () => true),
			validatesCredentials: () => true,
			fetchUsage: () => authored("usage.fetchUsage", async () => ({ provider: PROVIDER, fetchedAt: 1, limits: [] })),
			parseRateLimitHeaders: () => authored("usage.parseRateLimitHeaders", () => null),
		});
		const oauth = instrument<Record<string, unknown>>("oauth.", {
			name: () => "Admission harness",
			login: () =>
				authored("oauth.login", async () => ({
					access: "harness-access",
					refresh: "harness-refresh",
					expires: Date.now() + 3_600_000,
				})),
			getApiKey: () => authored("oauth.getApiKey", (credentials: { access: string }) => credentials.access),
			refreshToken: () =>
				authored("oauth.refreshToken", async (credentials: object) => ({
					...credentials,
					access: "harness-refreshed",
					expires: Date.now() + 3_600_000,
				})),
			modifyModels: () =>
				authored("oauth.modifyModels", (models: Record<string, unknown>[]) =>
					models.map(model =>
						model.provider === PROVIDER
							? { ...model, resolveHeaders: authored("model.resolveHeaders", () => ({ "x-harness": "1" })) }
							: model,
					),
				),
		});
		return instrument<Record<string, unknown>>("", {
			api: () => API_ID,
			baseUrl: () => "https://admission.invalid/v1",
			apiKey: () => "HARNESS_KEY",
			headers: () => undefined,
			authHeader: () => undefined,
			compat: () => undefined,
			remoteCompaction: () => undefined,
			usage: () => usage,
			oauth: () => oauth,
			streamSimple: () => authored("streamSimple", () => ({ done: true })),
			fetchDynamicModels: () => authored("fetchDynamicModels", async () => []),
			models: () => [
				{
					id: MODEL_ID,
					name: "Admission Harness Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10_000,
					maxTokens: 100,
				},
			],
		});
	}

	/** Registers through `pi.registerProvider` and drains the queue the way a host does. */
	async function registerThroughQueue(): Promise<void> {
		const config = buildConfig();
		await loadExtensionFromFactory(
			pi => {
				(pi as unknown as { registerProvider: (name: string, value: unknown) => void }).registerProvider(
					PROVIDER,
					config,
				);
			},
			dir.path(),
			new EventBus(),
			runtime,
			SOURCE_ID,
		);
		for (const entry of runtime.pendingProviderRegistrations.splice(0)) {
			registry.registerProvider(entry.name, entry.config, entry.sourceId);
		}
	}

	/** Registers the way `ExtensionRunner.initialize` rewires it: straight at the registry. */
	function registerThroughRegistry(): void {
		registry.registerProvider(
			PROVIDER,
			buildConfig() as Parameters<ModelRegistry["registerProvider"]>[1],
			SOURCE_ID,
			runtime,
		);
	}

	/** Every host route that can reach this provider, each one named for the report. */
	const drives: Record<string, () => Promise<void>> = {
		// `registry.getAll` is deliberately NOT a route here. The credential-aware projection runs
		// when the registration is taken, not when the catalog is read, so `getAll` reaches no
		// author code afterwards and would sit in this list recording nothing — which is what
		// four routes did for several rounds while looking green. The projection is covered where
		// it actually happens: the registration assertion below requires `oauth.modifyModels` to
		// have been called, and `model.resolveHeaders` exercises what it produced.
		"usage.reports": async () => {
			await auth.usage.reports({ provider: PROVIDER }).catch(() => undefined);
		},
		"usage.ingestHeaders": async () => {
			auth.usage.ingestHeaders(PROVIDER, { "x-ratelimit-remaining": "1" });
		},
		"health.check": async () => {
			await auth.health.check({ excludeProviders: new Set(["anthropic"]) }).catch(() => undefined);
		},
		"oauth.login": async () => {
			await auth.oauth.login(PROVIDER, { onAuth: () => undefined, onPrompt: async () => "" }).catch(() => undefined);
		},
		"keys.get": async () => {
			await auth.keys.get(PROVIDER).catch(() => undefined);
		},
		"registry.refreshRuntimeProviders": async () => {
			await registry.refreshRuntimeProviders("online").catch(() => undefined);
		},
		"model.resolveHeaders": async () => {
			const model = registry.find(PROVIDER, MODEL_ID) as
				| { resolveHeaders?: (signal?: unknown) => unknown }
				| undefined;
			await Promise.resolve(model?.resolveHeaders?.(undefined)).catch(() => undefined);
		},
		"customApi.streamSimple": async () => {
			const api = getCustomApi(API_ID);
			try {
				api?.streamSimple({ id: MODEL_ID, provider: PROVIDER } as never, { messages: [] } as never);
			} catch {}
		},
	};

	/** `path kind ×count`, so a failure names the routes rather than printing every access. */
	function summarise(entries: readonly Access[]): string[] {
		const counts = new Map<string, number>();
		for (const entry of entries) {
			const key = `${entry.path} ${entry.kind}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts].map(([key, count]) => `${key} ×${count}`).sort();
	}

	for (const [phase, register] of Object.entries({
		queued: registerThroughQueue,
		initialized: async () => registerThroughRegistry(),
	})) {
		test(`${phase} registration: nothing reaches the author outside admission, and nothing at all once the session has gone`, async () => {
			// The credential comes first: several routes only reach a provider that has one to
			// work with — header ingestion needs an active OAuth credential, and the
			// credential-health probe and the credential-aware projection need one to probe and
			// to project against. Seeded after registration they would each return early and
			// record nothing, which is indistinguishable from passing.
			await auth.credentials.set(PROVIDER, {
				type: "oauth",
				access: "harness-access",
				refresh: "harness-refresh",
				expires: Date.now() + 3_600_000,
			});
			await register();
			// Registration itself is a host route: whatever it read of the author's configuration
			// is the author's code running, and has to have been admitted like any other. It must
			// also have reached the provider — a registration that read nothing would mean the
			// fixture, not the host, had changed.
			const registration = summarise(accesses);
			expect({ phase, outside: summarise(accesses.filter(access => !access.inside)) }).toEqual({
				phase,
				outside: [],
			});
			expect({ phase, projected: registration.some(entry => entry.startsWith("oauth.modifyModels call")) }).toEqual({
				phase,
				projected: true,
			});
			expect(registration.length).toBeGreaterThan(5);

			// A route that records nothing proves nothing, and silence reads exactly like success.
			// Four of these were green for rounds while reaching no author code at all, and the
			// health route that recorded nothing was where the next escape was found. So a route
			// that claims to drive the provider must reach it, and one that genuinely cannot is
			// removed from this list rather than left here looking like evidence.
			const silent: string[] = [];
			for (const [name, drive] of Object.entries(drives)) {
				const before = accesses.length;
				await drive();
				const reached = accesses.slice(before);
				const outside = summarise(reached.filter(access => !access.inside));
				expect({ phase, route: name, outside }).toEqual({ phase, route: name, outside: [] });
				if (reached.length === 0) silent.push(name);
			}
			expect({ phase, reachedNothing: silent }).toEqual({ phase, reachedNothing: [] });

			// Now the session goes. Every route is driven again, and the author must not run.
			release();
			released = true;
			const afterRelease = accesses.length;
			for (const drive of Object.values(drives)) await drive();
			expect({ phase, afterRelease: summarise(accesses.slice(afterRelease)) }).toEqual({
				phase,
				afterRelease: [],
			});
		}, 30_000);
	}
});
