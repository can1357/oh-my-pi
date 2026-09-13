/**
 * `--reapply-config` must resume on the FIRST configured `modelRoles.default`
 * candidate, not on whichever candidate happened to be visible before extension
 * providers registered.
 *
 * The startup role resolution in `sdk.ts` runs before extension factories drain
 * their `pi.registerProvider(...)` queue into the registry. With an ordered
 * fallback list whose first candidate lives behind such a provider, that early
 * pass can only match a later candidate. `--reapply-config` adopts it, and the
 * post-registration retry is gated on `!model` — so without re-resolving, the
 * resume silently lands on the lower-priority configured fallback even though
 * the preferred model became available moments later.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
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

const EXTENSION_PROVIDER = "reapply-order-gw";
const EXTENSION_MODEL = "reapply-order-model";

describe("--reapply-config configured default fallback order", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@omp-reapply-order-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-reapply-order-");
	});

	afterEach(async () => {
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
	 * Registers a provider the same way a real extension does — through the
	 * runtime's pending-registration queue, which `sdk.ts` drains only AFTER its
	 * early role resolution.
	 */
	const registerLateProvider: ExtensionFactory = pi => {
		pi.registerProvider(EXTENSION_PROVIDER, {
			baseUrl: "https://reapply-order.example.invalid/v1",
			apiKey: "literal-test-key",
			api: "openai-completions",
			models: [
				{
					id: EXTENSION_MODEL,
					name: "Reapply Order Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8192,
				},
			],
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
		await Bun.write(overlayPath, `modelRoles:\n  default: "${defaultRole}"\n`);
		return Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			inMemory: true,
			configFiles: [overlayPath],
		});
	}

	async function resume(sessionFile: string, settings: Settings, reapplyConfig: boolean): Promise<AgentSession> {
		// A registry private to this resume: the extension provider registration
		// must not leak into any other test's catalog.
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			extensions: [registerLateProvider],
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			reapplyConfig,
		});
		session = result.session;
		return result.session;
	}

	it("resumes on the first configured candidate once its extension provider registers", async () => {
		const bakedModel = anthropicModel("claude-opus-4-1");
		const laterCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		// Ordered fallback list: the FIRST candidate is behind the extension
		// provider (invisible at early resolution), the second is bundled and
		// already available, so the early pass matches index 1.
		const settings = await loadOverlay(`${EXTENSION_PROVIDER}/${EXTENSION_MODEL},${modelValue(laterCandidate)}`);

		const resumed = await resume(sessionFile, settings, true);

		// The preferred candidate became available during extension registration,
		// so `--reapply-config` must land on it — never on the configured fallback.
		expect(resumed.model?.provider).toBe(EXTENSION_PROVIDER);
		expect(resumed.model?.id).toBe(EXTENSION_MODEL);
	});

	it("still resumes on the first configured candidate when it is already available", async () => {
		// Guards the re-resolution against regressing the ordinary case: when the
		// early pass already matched index 0 there is nothing to re-resolve, and
		// the adopted model must stay put.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const firstCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${modelValue(firstCandidate)},${EXTENSION_PROVIDER}/${EXTENSION_MODEL}`);

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.model?.provider).toBe(firstCandidate.provider);
		expect(resumed.model?.id).toBe(firstCandidate.id);
	});

	it("retains the session model when every fallback candidate is a self alias", async () => {
		// `Settings.getModelRole()` flattens a list into `"*,@default"`, which
		// matches no alias spelling — so the whole string read as a real
		// configured default even though every pattern resolves to no model.
		// Startup then skipped the session restore and reported a broken config
		// default instead of retaining the session's own model.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay("*,@default");

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.model?.provider).toBe(bakedModel.provider);
		expect(resumed.model?.id).toBe(bakedModel.id);
	});

	it("still adopts a list that mixes a self alias with a real candidate", async () => {
		// The other direction: one non-alias pattern makes it a genuine configured
		// default, so classifying per pattern must not turn every list into "no
		// config default". The alias sits LAST because a LEADING `*` is resolved
		// as a real candidate by the role resolver and stalls on its own
		// circularity — existing behaviour, independent of this classification.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const realCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${modelValue(realCandidate)},*`);

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.model?.provider).toBe(realCandidate.provider);
		expect(resumed.model?.id).toBe(realCandidate.id);
	});

	it("adopts a self-alias-only list that still resolved to a model", async () => {
		// The `default` sentinel is applied to the WHOLE unsplit role value, so a
		// `default` inside a list is matched like any other selector — and the
		// bundled `cursor/default` is a real model once Cursor credentials exist.
		// Measured: `"default,@default"` classifies as all-self-alias yet resolves
		// to `cursor/default`. Classifying by spelling alone restored the session
		// model over a model config genuinely resolved.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay("default,@default");

		// Cursor credentials make the BUNDLED `cursor/default` available, which is
		// the collision the sentinel exists for. Scoped to this test.
		authStorage.setRuntimeApiKey("cursor", "test-cursor-key");
		try {
			const resumed = await resume(sessionFile, settings, true);
			expect(resumed.model?.provider).toBe("cursor");
			expect(resumed.model?.id).toBe("default");
		} finally {
			authStorage.setRuntimeApiKey("cursor", "");
		}
	});

	it("stops at a bare self alias ahead of a later suffixed one", async () => {
		// `missing/model,*,*:low`: the concrete candidate does not resolve, so the
		// BARE `*` is the fallback reached — and it names no thinking knob, so the
		// session keeps its own level. Scanning for the first pattern that carries
		// a suffix skipped it and applied `low` from a fallback never reached.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay("missing/model,*,*:low");

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.configuredThinkingLevel()).not.toBe(ThinkingLevel.Low);
	});

	it("applies the suffix of a self alias reached past an unresolvable candidate", async () => {
		// `missing/model,*:low`: the concrete candidate is CONFIGURED but resolves
		// to nothing, so `*:low` is the fallback actually reached and its `low` is
		// the live knob. Gating on "was a concrete pattern configured" suppressed
		// it, leaving a fresh session on the arbitrary fallback model's default.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay("missing/model,*:low");

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
	});

	it("ignores a thinking suffix on a fallback that did not win", async () => {
		// `"anthropic/...,*:low"`: the concrete entry resolves, so the `low` belongs
		// to a fallback that was never selected. Scanning every pattern for a
		// suffix ran the CHOSEN model at the loser's level.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const winner = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${modelValue(winner)},*:low`);

		const resumed = await resume(sessionFile, settings, true);

		expect(resumed.model?.id).toBe(winner.id);
		expect(resumed.configuredThinkingLevel()).not.toBe(ThinkingLevel.Low);
	});

	it("keeps the baked session model on a bare resume even when a later candidate matched first", async () => {
		// Without the flag the session's own model wins regardless of how the
		// configured role resolved, so the re-resolution must not reach this path.
		const bakedModel = anthropicModel("claude-opus-4-1");
		const laterCandidate = anthropicModel("claude-sonnet-4-5");
		const sessionFile = await writeBakedSession(modelValue(bakedModel));

		const settings = await loadOverlay(`${EXTENSION_PROVIDER}/${EXTENSION_MODEL},${modelValue(laterCandidate)}`);

		const resumed = await resume(sessionFile, settings, false);

		expect(resumed.model?.id).toBe(bakedModel.id);
	});
});
