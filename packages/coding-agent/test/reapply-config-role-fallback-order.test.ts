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
