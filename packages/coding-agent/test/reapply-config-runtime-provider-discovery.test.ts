/**
 * `--reapply-config` must give a configured `modelRoles.default` supplied by an
 * EXTENSION its cold-cache discovery retry, not just one supplied by a
 * config-declared discovery provider.
 *
 * An extension that registers a provider with `fetchDynamicModels` installs a
 * RUNTIME model manager. `modelRegistry.refresh()` discovers those, but
 * `getDiscoverableProviders()` reports only the config-declared half of the
 * discovery surface. So with every implicit/config discovery provider disabled
 * or absent, a guard written against that list sees an empty array and returns
 * before the refresh can run — even though a runtime manager is registered and
 * holds the configured default. The resume then falls through to the baked
 * session model, which is exactly what the flag was asked to override.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const RUNTIME_PROVIDER = "reapply-runtime-gw";
const RUNTIME_MODEL = "reapply-runtime-model";
// A bare id that an all-self-alias list spells: `default` is BOTH the sentinel
// spelling and a real model id a provider may register.
const LATE_DEFAULT_MODEL = "default";

/** The implicit discovery providers the registry always adds; disabled so the
 * config-declared discoverable list is genuinely empty. */
const IMPLICIT_DISCOVERY_PROVIDERS = ["ollama", "llama.cpp", "lm-studio"];

describe("--reapply-config runtime-provider cold discovery", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let dynamicModelId = RUNTIME_MODEL;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@omp-reapply-runtime-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-reapply-runtime-");
	});

	afterEach(async () => {
		// Release any still-parked fetch before teardown so a failing assertion
		// cannot leave the gate closed for the next test.
		overlapGate?.open();
		overlapGate = undefined;
		dynamicFetches = 0;
		eagerFetchSettled = false;
		fallbackRacedEagerFetch = false;
		if (session) {
			await session.dispose();
			session = undefined;
		}
		tempDir.removeSync();
	});

	function anthropicModel(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function modelValue(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	/**
	 * Config-declared discoverable providers for these settings, read from a
	 * throwaway registry so the assertion never perturbs the one under test.
	 */
	function countConfigDiscoverableProviders(settings: Settings): number {
		const probe = new ModelRegistry(authStorage, path.join(tempDir.path(), "probe-models.yml"), { settings });
		return probe.getDiscoverableProviders().length;
	}

	let dynamicFetches = 0;
	/** True once the eagerly-started runtime discovery fetch has produced its models. */
	let eagerFetchSettled = false;
	/** True if the cold-cache fallback started its own refresh while that fetch was still open. */
	let fallbackRacedEagerFetch = false;

	/**
	 * When set, holds the eager discovery fetch open until the resume reaches
	 * the cold-cache fallback, so what the fallback does next is observed while
	 * a pass over the same runtime manager is genuinely in flight. A real remote
	 * stays open that long on its own; an in-process fake settles long before
	 * the fallback is reached, which would hide the overlap rather than test it.
	 *
	 * The hold is released at `hasRefreshableProviders()` — the fallback's own
	 * guard, which every implementation reaches before it awaits anything — so
	 * a fallback that joins the in-flight pass always makes progress instead of
	 * deadlocking. Releasing only schedules the parked fetch's continuation; a
	 * fallback that instead starts its own refresh does so in the same
	 * synchronous step, and is caught with the eager fetch provably unsettled.
	 * Nothing here waits on wall-clock time.
	 */
	let overlapGate: { wait: Promise<void>; open: () => void } | undefined;

	function observeDiscoveryOverlap(modelRegistry: ModelRegistry): void {
		const gate = Promise.withResolvers<void>();
		overlapGate = { wait: gate.promise, open: () => gate.resolve() };

		const guard = modelRegistry.hasRefreshableProviders.bind(modelRegistry);
		modelRegistry.hasRefreshableProviders = () => {
			gate.resolve();
			return guard();
		};

		const refresh = modelRegistry.refresh.bind(modelRegistry);
		modelRegistry.refresh = strategy => {
			if (!eagerFetchSettled) fallbackRacedEagerFetch = true;
			return refresh(strategy);
		};
	}

	/**
	 * A dynamic-ONLY provider: it declares no static `models`, so nothing exists
	 * until a discovery pass calls `fetchDynamicModels`. Registered through the
	 * runtime's pending-registration queue, the same path a real extension uses.
	 */
	const registerRuntimeProvider: ExtensionFactory = pi => {
		pi.registerProvider(RUNTIME_PROVIDER, {
			baseUrl: "https://reapply-runtime.example.invalid/v1",
			apiKey: "literal-test-key",
			api: "openai-completions",
			fetchDynamicModels: async () => {
				const modelId = dynamicModelId;
				const isEagerFetch = dynamicFetches === 0;
				dynamicFetches += 1;
				// The eager fetch parks until the resume reaches its fallback guard,
				// so whatever the fallback does next is observed mid-flight.
				if (overlapGate && isEagerFetch) await overlapGate.wait;
				if (isEagerFetch) eagerFetchSettled = true;
				return [
					{
						id: modelId,
						name: "Reapply Runtime Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8192,
					},
				];
			},
		});
	};

	async function writeBakedSession(bakedModelValue: string): Promise<string> {
		const sessionFile = path.join(tempDir.path(), `baked-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[
				{ type: "session", version: 3, id: "baked-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: bakedModelValue,
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return sessionFile;
	}

	async function loadOverlay(defaultRole: string): Promise<Settings> {
		const overlayPath = path.join(tempDir.path(), `overlay-${Bun.nanoseconds()}.yml`);
		await Bun.write(
			overlayPath,
			`modelRoles:\n  default: "${defaultRole}"\ndisabledProviders:\n${IMPLICIT_DISCOVERY_PROVIDERS.map(
				provider => `  - "${provider}"\n`,
			).join("")}`,
		);
		return Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			inMemory: true,
			configFiles: [overlayPath],
		});
	}

	async function resume(
		sessionFile: string,
		settings: Settings,
		options?: { hasUI?: boolean; observeOverlap?: boolean; dynamicModelId?: string },
	): Promise<AgentSession> {
		dynamicModelId = options?.dynamicModelId ?? RUNTIME_MODEL;
		// A registry private to this resume, with a cache DB under the per-test
		// temp dir so the runtime catalog genuinely starts cold. `settings` is
		// passed so the disabled implicit providers actually take effect.
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		if (options?.observeOverlap) observeDiscoveryOverlap(modelRegistry);
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			extensions: [registerRuntimeProvider],
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			// `hasUI: true` keeps online runtime discovery deferred to the
			// post-paint starter, so nothing populates the runtime catalog before
			// the guard under test runs. Without it the background pass would mask
			// the bug. A non-UI resume instead starts that pass eagerly, which is
			// the case the single-fetch test below covers.
			hasUI: options?.hasUI ?? true,
			reapplyConfig: true,
		});
		session = result.session;
		return result.session;
	}

	it("discovers an extension-supplied configured default with no config discovery providers", async () => {
		dynamicFetches = 0;
		const bakedModel = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${RUNTIME_PROVIDER}/${RUNTIME_MODEL}`);
		// The premise of the finding: nothing config-declared is left to discover,
		// so a guard keyed off this list short-circuits.
		expect(countConfigDiscoverableProviders(settings)).toBe(0);

		const resumed = await resume(sessionFile, settings);

		expect(dynamicFetches).toBeGreaterThan(0);
		expect(resumed.model?.provider).toBe(RUNTIME_PROVIDER);
		expect(resumed.model?.id).toBe(RUNTIME_MODEL);
	});

	it("adopts an all-self-alias default a late provider registration resolves", async () => {
		// `"default,@default"` is every-pattern-a-self-alias, so before extensions
		// register it names no model and classifies as "no config default". An
		// extension can then register a provider whose bare id IS `default`, which
		// makes the same list resolve — so the classification has to be re-asked
		// after registration rather than captured at startup. Captured, the baked
		// model was restored and the retry skipped for having a model already.
		dynamicFetches = 0;
		const bakedModel = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`default,@default`);

		const resumed = await resume(sessionFile, settings, { dynamicModelId: LATE_DEFAULT_MODEL });

		expect(resumed.model?.provider).toBe(RUNTIME_PROVIDER);
		expect(resumed.model?.id).toBe(LATE_DEFAULT_MODEL);
	});

	it("keeps the baked session model when the configured default is unresolvable", async () => {
		// Guards the widened refresh against over-adopting: a refresh that
		// discovers nothing matching must still leave the resume on its own model
		// rather than an arbitrary pick.
		dynamicFetches = 0;
		const bakedModel = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${RUNTIME_PROVIDER}/no-such-runtime-model`);

		const resumed = await resume(sessionFile, settings);

		expect(resumed.model?.id).toBe(bakedModel.id);
	});

	// A non-UI resume starts online runtime discovery eagerly, so by the time the
	// cold-cache fallback runs, a pass over the very same runtime manager is
	// already in flight. The fallback must reuse that pass rather than launch a
	// second one: two concurrent discoveries fetch the extension's remote twice
	// and race each other's catalog and cache writes.
	it("reuses the in-flight non-UI discovery instead of launching a second pass", async () => {
		const bakedModel = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));
		const settings = await loadOverlay(`${RUNTIME_PROVIDER}/${RUNTIME_MODEL}`);

		const resumed = await resume(sessionFile, settings, { hasUI: false, observeOverlap: true });

		// Whether the SECOND pass re-fetches or lands on the cache the first one
		// wrote is a scheduling detail, so a fetch count cannot state this
		// contract. Launching it at all is the defect: it is concurrent with a
		// pass over the same manager, writing the same catalog and cache rows.
		expect(fallbackRacedEagerFetch).toBe(false);
		expect(dynamicFetches).toBe(1);
		expect(resumed.model?.provider).toBe(RUNTIME_PROVIDER);
		expect(resumed.model?.id).toBe(RUNTIME_MODEL);
	});
});
