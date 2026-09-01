/**
 * Regression: a `/tan` background fork reuses the parent's live ModelRegistry
 * instance. The fix forwards the parent's `preparedExtensions` (and root policy)
 * so the child rebinds the extension and re-registers its provider before the
 * SDK's `syncExtensionSources` prune runs against that shared registry.
 *
 * This is the behavior contract behind the controller-level plumbing test:
 * after a tan-like child is created on the shared registry, the extension
 * provider's credential MUST still resolve (both for the child and the parent).
 * Without the forward the prune sees an empty active-source set and unregisters
 * the provider, so the pre-send API-key check fails with "No API key found".
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "tan-fixture-gw";
const MODEL_ID = "tan-fixture-model";
const SENTINEL = "tan-fixture-sentinel-key";
const INLINE_PROVIDER = "tan-inline-fixture-gw";
const INLINE_MODEL_ID = "tan-inline-fixture-model";
const INLINE_SENTINEL = "tan-inline-fixture-sentinel-key";

// No streamSimple / oauth: registration mutates only this ModelRegistry
// instance, never a process-global custom-API/OAuth table.
const EXTENSION_SOURCE = `export default function (pi) {
	pi.registerProvider(${JSON.stringify(PROVIDER)}, {
		baseUrl: "https://tan-fixture.example.invalid/v1",
		apiKey: ${JSON.stringify(SENTINEL)},
		api: "openai-completions",
		models: [{
			id: ${JSON.stringify(MODEL_ID)},
			name: "Tan Fixture Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		}],
	});
}
`;
const INLINE_EXTENSION: ExtensionFactory = pi => {
	pi.registerProvider(INLINE_PROVIDER, {
		baseUrl: "https://tan-inline-fixture.example.invalid/v1",
		apiKey: INLINE_SENTINEL,
		api: "openai-completions",
		models: [
			{
				id: INLINE_MODEL_ID,
				name: "Tan Inline Fixture Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	});
};

function baseOptions(cwd: string) {
	return {
		cwd,
		agentDir: cwd,
		settings: Settings.isolated({ "marketplace.autoUpdate": "off", "compaction.enabled": false }),
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true as const,
	};
}

describe("/tan extension auth over a shared registry", () => {
	it("keeps the extension provider's credential resolvable after a forwarded tan-like child is created", async () => {
		using tempDir = TempDir.createSync("omp-tan-ext-auth-");
		const cwd = path.resolve(tempDir.path());
		const extPath = path.join(cwd, "provider-ext.ts");
		await Bun.write(extPath, EXTENSION_SOURCE);

		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const base = baseOptions(cwd);

		try {
			const { session: parent } = await createAgentSession({
				...base,
				sessionManager: SessionManager.inMemory(cwd),
				authStorage,
				modelRegistry,
				additionalExtensionPaths: [extPath],
				extensions: [INLINE_EXTENSION],
				disableExtensionDiscovery: true,
			});

			const model = modelRegistry.find(PROVIDER, MODEL_ID);
			const inlineModel = modelRegistry.find(INLINE_PROVIDER, INLINE_MODEL_ID);
			expect(model).toBeDefined();
			expect(inlineModel).toBeDefined();
			expect(await modelRegistry.getApiKey(model!)).toBe(SENTINEL);
			expect(await modelRegistry.getApiKey(inlineModel!)).toBe(INLINE_SENTINEL);
			expect(parent.preparedExtensions?.length).toBeGreaterThan(0);

			// Tan child: forwards the parent's prepared extensions + root policy, so
			// bindPreparedExtensions re-registers the provider before the prune.
			const { session: tanChild } = await createAgentSession({
				...base,
				sessionManager: SessionManager.inMemory(cwd),
				authStorage,
				modelRegistry,
				disableExtensionDiscovery: true,
				preloadedPreparedExtensions: parent.preparedExtensions,
				extensionRoots: () => parent.effectiveExtensionRoots,
			});

			// Child request auth resolves AND the parent's registration survives on
			// the shared registry instance.
			expect(await tanChild.modelRegistry.getApiKey(model!)).toBe(SENTINEL);
			expect(await tanChild.modelRegistry.getApiKey(inlineModel!)).toBe(INLINE_SENTINEL);
			expect(await modelRegistry.getApiKey(model!)).toBe(SENTINEL);
			expect(await modelRegistry.getApiKey(inlineModel!)).toBe(INLINE_SENTINEL);

			await tanChild.dispose();
			await parent.dispose();
		} finally {
			authStorage.close();
		}
	}, 20_000);

	it("preserves auth via the extension-paths fallback when no prepared factories are forwarded", async () => {
		using tempDir = TempDir.createSync("omp-tan-ext-auth-fallback-");
		const cwd = path.resolve(tempDir.path());
		const extPath = path.join(cwd, "provider-ext.ts");
		await Bun.write(extPath, EXTENSION_SOURCE);

		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const base = baseOptions(cwd);

		try {
			const { session: parent } = await createAgentSession({
				...base,
				sessionManager: SessionManager.inMemory(cwd),
				authStorage,
				modelRegistry,
				additionalExtensionPaths: [extPath],
				disableExtensionDiscovery: true,
			});
			const model = modelRegistry.find(PROVIDER, MODEL_ID);
			expect(model).toBeDefined();
			expect(await modelRegistry.getApiKey(model!)).toBe(SENTINEL);

			// Simulate the rare parent build path that yields no prepared factories:
			// the child rebinds from source paths (SDK branch: preloadedExtensionPaths)
			// and must still re-register the provider before the prune.
			const { session: tanChild } = await createAgentSession({
				...base,
				sessionManager: SessionManager.inMemory(cwd),
				authStorage,
				modelRegistry,
				disableExtensionDiscovery: true,
				preloadedExtensionPaths: [extPath],
				extensionRoots: () => parent.effectiveExtensionRoots,
			});

			expect(await tanChild.modelRegistry.getApiKey(model!)).toBe(SENTINEL);
			expect(await modelRegistry.getApiKey(model!)).toBe(SENTINEL);

			await tanChild.dispose();
			await parent.dispose();
		} finally {
			authStorage.close();
		}
	}, 20_000);
});
