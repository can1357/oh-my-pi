/**
 * Three more surfaces `refresh('settings')` reloads but historically failed to
 * reconcile into LIVE state, all of the same shape as the queue modes and
 * generation settings: the value is copied out of `Settings` once at
 * construction, and the thing that consumes it reads the copy — never
 * `settings.get(...)` — so a reload alone left the running session on its
 * launch-time behavior while the refresh reported success.
 *
 *   - The per-family SERVICE TIER. Startup copies `tier.openai`/`tier.anthropic`/
 *     `tier.google` into `ModelControls`'s private map, and
 *     `agent.serviceTierResolver` consults that map on every request.
 *   - The tool sets whose EXISTENCE is gated on a setting
 *     (`generate_image.enabled`, `speechgen.enabled`). sdk.ts pushes both into
 *     `customTools` at construction with no later registration or removal path,
 *     so an enable left the tools unavailable and a disable left them callable.
 *   - The model-pin classifier's reading of a ROLE-LESS `model_change`, which is
 *     ambiguous on a transcript written before the cycle paths recorded a role:
 *     it is either startup's settings-derived receipt (swappable) or an older
 *     Ctrl+P cycle pin (must be preserved).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isSharedLspEnabled } from "@oh-my-pi/pi-coding-agent/lsp/client";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function bundledAnthropic(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled anthropic model ${id}`);
	return model as Model<Api>;
}

interface Harness {
	session: AgentSession;
	cwd: string;
	settingsPath: string;
	modelA: Model<Api>;
	dispose: () => Promise<void>;
}

/**
 * `persistSession` swaps the in-memory transcript for a FILE-backed one, which
 * a round-trip case needs: `switchSession` reloads from the session file, and
 * that reload is where the persisted `service_tier_change` snapshot is replayed
 * over the live map.
 */

/**
 * A bundled ANTHROPIC model, not a synthetic one: `serviceTierFamily` maps a
 * model to its tier family from real provider/api metadata, so a made-up
 * provider has no family at all and every tier assertion would pass vacuously.
 *
 * `overrides` is a CONFIG OVERLAY on the isolated `Settings`, which is how the
 * harness keeps `compaction.enabled` off without competing with the on-disk
 * `config.yml` each test rewrites — `#readProjectSettings` serves the project
 * layers through a process-lifetime capability cache, so an override is the
 * layer a test can set once and rely on across the reload.
 */
async function makeHarness(
	initialConfig: string,
	options?: {
		persistSession?: boolean;
		customTools?: CustomTool[];
		enableLsp?: boolean;
		toolNames?: string[];
		/** Spawn depth, for the depth-dependent halves of the compound gates. */
		taskDepth?: number;
		enableMCP?: boolean;
	},
): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-live-tiers-tools-");
	const cwd = tempDir.path();
	await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
	const settingsPath = path.join(cwd, "config.yml");
	const modelA = bundledAnthropic("claude-sonnet-4-5");
	// Staged BEFORE construction so the session starts from these values and
	// each test observes a real transition, not a first-time application.
	await fs.writeFile(settingsPath, initialConfig);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: options?.persistSession
			? SessionManager.create(cwd, path.join(cwd, "transcript"))
			: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({
			cwd,
			agentDir: cwd,
			overrides: { "compaction.enabled": false },
		}),
		model: modelA,
		disableExtensionDiscovery: true,
		contextFiles: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: options?.enableMCP ?? false,
		enableLsp: options?.enableLsp ?? false,
		skipPythonPreflight: true,
		customTools: options?.customTools,
		toolNames: options?.toolNames,
		taskDepth: options?.taskDepth,
	});

	return {
		session,
		cwd,
		settingsPath,
		modelA,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

describe("AgentSession refresh('settings'): live service tiers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies a reloaded per-family service tier to the live request resolver", async () => {
		const h = await makeHarness("tier:\n  anthropic: none\n");
		try {
			expect(h.session.serviceTierByFamily.anthropic).toBeUndefined();

			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: priority\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: startup copied `tier.*` into `ModelControls`'s private map
			// and the reload never touched it, so the refresh reported success
			// while requests kept the launch-time tier.
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");
			// The resolver is what actually reaches the wire, and it reads the map
			// per request rather than the settings.
			expect(h.session.agent.serviceTierResolver?.(h.modelA)).toBe("priority");
		} finally {
			await h.dispose();
		}
	});

	it("clears a per-family tier when the setting goes back to none", async () => {
		// The serious direction: leaving `priority` live after it was turned off
		// keeps billing every request at the priority tier.
		const h = await makeHarness("tier:\n  anthropic: priority\n");
		try {
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");

			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: none\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.serviceTierByFamily.anthropic).toBeUndefined();
			expect(h.session.agent.serviceTierResolver?.(h.modelA)).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});

	it("leaves a session-local /fast selection alone when the config tier did not move", async () => {
		// Guard against a blind re-apply: `/fast`, the settings selector, and an
		// RPC/ACP client all write the live map directly, and such a selection is
		// invisible to the config file — exactly the shape the queue modes and
		// provider globals are also protected against.
		const h = await makeHarness("tier:\n  anthropic: none\n");
		try {
			h.session.setServiceTierFamily("anthropic", "priority");
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");

			// An UNRELATED settings edit. `tier.anthropic` is still `none`, so the
			// reconcile must not pull the session back off its own selection.
			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: none\nincludeModelInPrompt: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");
		} finally {
			await h.dispose();
		}
	});

	it("keeps a session-local selection even when the configured tier itself moves", async () => {
		// The stronger half, and the one the unrelated-edit case above cannot
		// reach: when `tier.anthropic` genuinely CHANGES, the family is no longer
		// skipped for being unmoved, so only the live-vs-previous comparison stops
		// the config from overwriting a selection the operator made at runtime.
		const h = await makeHarness("tier:\n  anthropic: none\n");
		try {
			h.session.setServiceTierFamily("anthropic", "priority");
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");

			// `none` -> `standard`: a real config move on the very family the
			// session has its own selection for.
			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: standard\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// The runtime selection outranks a config value the session never followed.
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");
		} finally {
			await h.dispose();
		}
	});

	it("keeps a refreshed family's tier across a switch away and back", async () => {
		// The initial write was never the failure: a `service_tier_change` is a
		// WHOLE-MAP snapshot, so an earlier `/fast` on ONE family froze every
		// other family's pre-refresh value into it. Restoration replays the last
		// snapshot wholesale, so switching away and back reverted exactly the
		// families the refresh had just moved.
		const h = await makeHarness("tier:\n  anthropic: none\n  openai: none\n", { persistSession: true });
		try {
			// A session-local selection on ANOTHER family writes the whole-map
			// receipt — `{ anthropic: "priority" }`, with openai still absent.
			h.session.setServiceTierFamily("anthropic", "priority");

			// The refresh moves the openai family, which is still config-tracking.
			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: none\n  openai: flex\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(h.session.serviceTierByFamily.openai).toBe("flex");
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");

			// The round trip: a real reload through the persisted transcript.
			// Persistence is lazy — the JSONL only materializes once the history
			// holds an assistant message — so without a real reply `switchSession`
			// reloads nothing and every tier falls back to the configured map,
			// which would let the assertion below pass vacuously.
			h.session.sessionManager.appendMessage({
				role: "assistant",
				provider: "anthropic",
				model: h.modelA.id,
				content: [{ type: "text", text: "reply" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				api: "anthropic-messages",
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const sessionFile = h.session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await h.session.sessionManager.flush();
			expect(await h.session.switchSession(sessionFile)).toBe(true);

			// Pre-fix: the newest snapshot was the pre-refresh `/fast` one, whose
			// openai entry was absent, so the reconciled `flex` vanished.
			expect(h.session.serviceTierByFamily.openai).toBe("flex");
			// And the earlier session-local selection must still survive it.
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");
		} finally {
			await h.dispose();
		}
	}, 20_000);
});

describe("AgentSession refresh('settings'): setting-gated tool sets", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("installs the image and speech tools when their settings are enabled on disk", async () => {
		const h = await makeHarness("generate_image:\n  enabled: false\nspeechgen:\n  enabled: false\n");
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("generate_image");
			expect(h.session.getEnabledToolNames()).not.toContain("tts");

			await fs.writeFile(h.settingsPath, "generate_image:\n  enabled: true\nspeechgen:\n  enabled: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: both sets were added only at startup, with no later
			// registration path, so enabling them left the tools unavailable while
			// the refresh reported the settings updated.
			expect(h.session.getEnabledToolNames()).toContain("generate_image");
			expect(h.session.getEnabledToolNames()).toContain("tts");
			// Registered, not merely named: the model has to be able to call them.
			expect(h.session.getToolByName("generate_image")).toBeDefined();
			expect(h.session.getToolByName("tts")).toBeDefined();
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("removes the image and speech tools when their settings are disabled on disk", async () => {
		// The serious direction: a disabled tool that stays active is still
		// advertised to the model and still callable.
		const h = await makeHarness("generate_image:\n  enabled: true\nspeechgen:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("generate_image");
			expect(h.session.getEnabledToolNames()).toContain("tts");

			await fs.writeFile(h.settingsPath, "generate_image:\n  enabled: false\nspeechgen:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.getEnabledToolNames()).not.toContain("generate_image");
			expect(h.session.getEnabledToolNames()).not.toContain("tts");
		} finally {
			await h.dispose();
		}
	});

	it("re-selects a settings-tracking model after a default edit made while stopped", async () => {
		// The failure is invisible to the reload: the file has not moved since
		// startup read it, so `changed` is false while `Settings` already holds
		// the new default and the transcript holds the retired one.
		const h = await makeHarness("", { persistSession: true });
		try {
			const startingModel = h.session.model;
			expect(startingModel).toBeDefined();
			const other = h.session.getAvailableModels().find(model => model.id !== startingModel?.id);
			expect(other).toBeDefined();
			if (!other || !startingModel) return;

			const sessionFile = h.session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await h.session.sessionManager.flush();

			// The edit lands while the session is not running, so nothing
			// reconciles it. As above, `reload()` puts the in-process session in the
			// state a new process would start in: config already new, transcript
			// about to restore the old model.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${other.provider}/${other.id}\n`);
			await h.session.settings.reload();
			expect(await h.session.switchSession(sessionFile)).toBe(true);
			expect(h.session.model?.id).toBe(startingModel.id);

			const result = await h.session.refresh("settings");

			// Nothing reloaded, yet the model still has to converge on the config.
			expect(result.settingsChanged).toBe(false);
			expect(h.session.model?.id).toBe(other.id);
		} finally {
			await h.dispose();
		}
	}, 30_000);

	it("re-derives a config-following family after a tier edit made while stopped", async () => {
		// The boundary a refresh cannot cover. Anthropic is PINNED by `/fast`, which
		// writes a whole-map receipt carrying google's current value too. The
		// process then stops, `tier.google` is edited on disk, and the session is
		// resumed: restoration replayed the receipt wholesale, so the stale google
		// tier came back. No later refresh can notice, because `Settings` has
		// already loaded the new value — `previousConfigured` equals
		// `nextConfigured`, so the reconcile sees no movement.
		const h = await makeHarness("tier:\n  anthropic: none\n  google: flex\n", { persistSession: true });
		try {
			expect(h.session.serviceTierByFamily.google).toBe("flex");

			// The pin on ANOTHER family, which is what writes the receipt.
			h.session.setServiceTierFamily("anthropic", "priority");

			h.session.sessionManager.appendMessage({
				role: "assistant",
				provider: "anthropic",
				model: h.modelA.id,
				content: [{ type: "text", text: "reply" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				api: "anthropic-messages",
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const sessionFile = h.session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await h.session.sessionManager.flush();

			// The edit happens while the session is NOT running, so nothing
			// reconciles it — this is the case the refresh path cannot reach.
			await fs.writeFile(h.settingsPath, "tier:\n  anthropic: none\n  google: priority\n");
			// A real resume is a NEW process that loads the edited config before
			// restoring the transcript. In-process, `reload()` is what puts the
			// session in that state; without it the restore would read the launch-time
			// value and the assertion below could not distinguish the fix.
			await h.session.settings.reload();

			expect(await h.session.switchSession(sessionFile)).toBe(true);

			// Pre-fix this was the stale `flex` from the receipt.
			expect(h.session.serviceTierByFamily.google).toBe("priority");
			// The real pin is untouched: provenance distinguishes them.
			expect(h.session.serviceTierByFamily.anthropic).toBe("priority");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("carries service-tier provenance into a /new receipt", async () => {
		// `/new` starts a fresh transcript and writes a service-tier receipt. With
		// no tracking list that receipt reads as a LEGACY fully-pinned snapshot, so
		// the value `/new` captured froze every family and a later `tier.*` edit
		// could never reach it.
		const h = await makeHarness("tier:\n  openai: priority\n", { persistSession: true });
		try {
			expect(h.session.serviceTierByFamily.openai).toBe("priority");

			await h.session.newSession();
			const sessionFile = h.session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session file");
			h.session.sessionManager.appendMessage({
				role: "assistant",
				provider: "anthropic",
				model: h.modelA.id,
				content: [{ type: "text", text: "reply" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				api: "anthropic-messages",
				stopReason: "stop",
				timestamp: Date.now(),
			});
			await h.session.sessionManager.flush();

			// Edited while stopped, exactly as in the resume case above.
			await fs.writeFile(h.settingsPath, "tier:\n  openai: flex\n");
			await h.session.settings.reload();

			expect(await h.session.switchSession(sessionFile)).toBe(true);

			// Pre-fix this was the frozen `priority` from the /new receipt.
			expect(h.session.serviceTierByFamily.openai).toBe("flex");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("keeps a pin a legacy service-tier receipt recorded", async () => {
		// A legacy `service_tier_change` omits the tracking list, and restoration
		// reads that as FULLY PINNED. The pinned-family reader disagreed, treating
		// the same receipt as fully config-following — so writing a receipt about
		// another family re-marked OpenAI as tracking, and a later `tier.openai`
		// edit overwrote the pin the legacy receipt recorded.
		const h = await makeHarness("tier:\n  openai: priority\n  google: none\n", { persistSession: true });
		try {
			// A legacy receipt: whole map, no tracking list — the pre-provenance
			// shape, pinning openai at the currently configured value.
			h.session.sessionManager.appendServiceTierChange({ openai: "priority" });

			// An operation about a DIFFERENT family, which writes the next receipt.
			h.session.setServiceTierFamily("google", "flex");

			const sessionFile = h.session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session file");
			h.session.sessionManager.appendMessage({
				role: "assistant",
				provider: "anthropic",
				model: h.modelA.id,
				content: [{ type: "text", text: "reply" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				api: "anthropic-messages",
				stopReason: "stop",
				timestamp: Date.now(),
			});
			await h.session.sessionManager.flush();

			await fs.writeFile(h.settingsPath, "tier:\n  openai: flex\n  google: none\n");
			await h.session.settings.reload();

			expect(await h.session.switchSession(sessionFile)).toBe(true);

			// The legacy pin outranks the config edit; pre-fix this read `flex`.
			expect(h.session.serviceTierByFamily.openai).toBe("priority");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("pins a family when the explicit selection matches the configured tier", async () => {
		// `/fast on` while `tier.openai: priority` selects the value already held.
		// The equality early-return wrote no receipt, so the family still read as
		// config-following and a later `tier.openai` edit overwrote the choice.
		const h = await makeHarness("tier:\n  openai: priority\n", { persistSession: true });
		try {
			// The value does not move; only the provenance does.
			h.session.setServiceTierFamily("openai", "priority");
			expect(h.session.serviceTierByFamily.openai).toBe("priority");

			const sessionFile = h.session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session file");
			h.session.sessionManager.appendMessage({
				role: "assistant",
				provider: "anthropic",
				model: h.modelA.id,
				content: [{ type: "text", text: "reply" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				api: "anthropic-messages",
				stopReason: "stop",
				timestamp: Date.now(),
			});
			await h.session.sessionManager.flush();

			await fs.writeFile(h.settingsPath, "tier:\n  openai: flex\n");
			await h.session.settings.reload();

			expect(await h.session.switchSession(sessionFile)).toBe(true);

			// The explicit selection outranks the config edit; pre-fix this read `flex`.
			expect(h.session.serviceTierByFamily.openai).toBe("priority");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("reapplies the shared-LSP flag when lsp.shared moves on disk", async () => {
		// `lsp.shared` is copied into module state in `lsp/client.ts` that
		// `getOrCreateClient` consults when it COLD-STARTS a server, never re-read
		// from settings — so a server started after `/refresh settings` stayed
		// shared (or private) against the refreshed value.
		const h = await makeHarness("lsp:\n  enabled: true\n  shared: false\n", { enableLsp: true });
		try {
			expect(isSharedLspEnabled()).toBe(false);

			await fs.writeFile(h.settingsPath, "lsp:\n  enabled: true\n  shared: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix this stayed false: `setSharedLspEnabled` ran only at SDK
			// construction, so the reload moved the merged view and nothing else.
			expect(isSharedLspEnabled()).toBe(true);

			// And back, since the false direction is what stops a session from
			// attaching to a broker it should no longer share.
			await fs.writeFile(h.settingsPath, "lsp:\n  enabled: true\n  shared: false\n");
			await h.session.refresh("settings");
			expect(isSharedLspEnabled()).toBe(false);
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("removes a core built-in when its boolean gate is disabled on disk", async () => {
		// The severe direction: `createTools` reads `bash.enabled` once at
		// construction and `BashTool.execute()` never re-checks it, so a
		// true->false edit left shell execution both advertised and CALLABLE.
		const h = await makeHarness("bash:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("bash");

			await fs.writeFile(h.settingsPath, "bash:\n  enabled: false\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.getEnabledToolNames()).not.toContain("bash");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("builds a core built-in whose startup gate was off when it is re-enabled", async () => {
		// No registry entry exists in this case — `createTools` never built the
		// tool — so re-activation is not enough and the tool has to be constructed.
		const h = await makeHarness("bash:\n  enabled: false\n");
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("bash");
			expect(h.session.getToolByName("bash")).toBeUndefined();

			await fs.writeFile(h.settingsPath, "bash:\n  enabled: true\n");
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Advertised AND registered: the model has to be able to call it.
			expect(h.session.getEnabledToolNames()).toContain("bash");
			expect(h.session.getToolByName("bash")).toBeDefined();
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("does not add a gated built-in the session's tool list excluded", async () => {
		// The distinction the permission set exists for: `bash` is missing here
		// because this session was constructed WITHOUT it, not because the setting
		// was off. Enabling the setting must not widen that grant.
		const h = await makeHarness("bash:\n  enabled: false\n", { toolNames: ["read", "glob"] });
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("bash");

			await fs.writeFile(h.settingsPath, "bash:\n  enabled: true\n");
			await h.session.refresh("settings");

			expect(h.session.getEnabledToolNames()).not.toContain("bash");
			expect(h.session.getToolByName("bash")).toBeUndefined();
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("keeps a custom tool registered over a core built-in when its gate is disabled", async () => {
		// Provenance, not just the name: a custom `bash` replaces the registry
		// entry and is marked non-built-in, and a freshly started session with
		// `bash.enabled: false` omits only the NATIVE tool while still offering
		// the custom one.
		const h = await makeHarness("bash:\n  enabled: true\n", {
			customTools: [
				{
					name: "bash",
					label: "Custom Bash",
					description: "custom bash replacement",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "custom" }] }),
				},
			],
		});
		try {
			expect(h.session.getEnabledToolNames()).toContain("bash");

			await fs.writeFile(h.settingsPath, "bash:\n  enabled: false\n");
			await h.session.refresh("settings");

			// Pre-fix the reconcile dropped the name regardless of who owns it.
			expect(h.session.getEnabledToolNames()).toContain("bash");
			expect(h.session.getToolByName("bash")?.description).toBe("custom bash replacement");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("reconciles the lsp.enabled gate on a session built with LSP", async () => {
		// `lsp`'s gate is compound, so it is not in the plain table; it still has
		// to reconcile, because `LspTool.execute()` never re-checks the setting.
		const h = await makeHarness("lsp:\n  enabled: true\n", { enableLsp: true });
		try {
			expect(h.session.getEnabledToolNames()).toContain("lsp");

			await fs.writeFile(h.settingsPath, "lsp:\n  enabled: false\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).not.toContain("lsp");

			await fs.writeFile(h.settingsPath, "lsp:\n  enabled: true\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).toContain("lsp");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("does not add lsp from a settings edit when the session was built without it", async () => {
		// `enableLsp` is a construction-time capability (`--no-tools`, a
		// restricted list), so no settings edit may grant it.
		const h = await makeHarness("lsp:\n  enabled: false\n", { enableLsp: false });
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("lsp");

			await fs.writeFile(h.settingsPath, "lsp:\n  enabled: true\n");
			await h.session.refresh("settings");

			expect(h.session.getEnabledToolNames()).not.toContain("lsp");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("reconciles the checkpoint pair when checkpoint.enabled moves", async () => {
		// Compound gate: `checkpoint.enabled` plus a task-depth condition. The
		// extra condition is invocation-scoped, so it must not freeze the setting.
		const h = await makeHarness("checkpoint:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("checkpoint");
			expect(h.session.getEnabledToolNames()).toContain("rewind");

			await fs.writeFile(h.settingsPath, "checkpoint:\n  enabled: false\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).not.toContain("checkpoint");
			expect(h.session.getEnabledToolNames()).not.toContain("rewind");

			await fs.writeFile(h.settingsPath, "checkpoint:\n  enabled: true\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).toContain("checkpoint");
			expect(h.session.getEnabledToolNames()).toContain("rewind");
		} finally {
			await h.dispose();
		}
	}, 25_000);

	it("applies a reloaded inlineToolDescriptors to the live agent", async () => {
		// `pruneToolDescriptions` was captured at construction, so request
		// assembly stayed on the launch-time catalog policy after a refresh.
		const h = await makeHarness("inlineToolDescriptors: false\n");
		try {
			expect(h.session.agent.pruneToolDescriptions).toBe(false);

			await fs.writeFile(h.settingsPath, "inlineToolDescriptors: true\n");
			await h.session.refresh("settings");

			expect(h.session.agent.pruneToolDescriptions).toBe(true);
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("waits for a pending prompt rebuild before an agent turn reads the prompt", async () => {
		// The child side of the parent's fan-out: the parent swaps a descendant's
		// roster synchronously and rebuilds its prompt on the mutation tail, so a
		// turn starting in that window must join the tail rather than read the
		// pre-rebuild prompt.
		const h = await makeHarness("");
		try {
			// Hold the tail with a mutation that records when it finishes, then ask
			// for the agent-start prompt. Resolution ORDER is the observable: the
			// read must not complete before the pending rebuild does.
			const gate = Promise.withResolvers<void>();
			const order: string[] = [];
			const mutation = h.session.runToolRegistryMutation(async () => {
				await gate.promise;
				order.push("rebuild");
			});

			const started = h.session.buildSystemPromptForAgentStart("probe").then(prompt => {
				order.push("agent-start");
				return prompt;
			});

			// Pre-fix this resolved here, ahead of the gate, because a backend with
			// no `beforeAgentStartPrompt` returned `#baseSystemPrompt` immediately.
			await Bun.sleep(50);
			expect(order).toEqual([]);

			gate.resolve();
			await mutation;
			await started;
			expect(order).toEqual(["rebuild", "agent-start"]);
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("reconciles the todo.enabled gate", async () => {
		const h = await makeHarness("todo:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("todo");

			await fs.writeFile(h.settingsPath, "todo:\n  enabled: false\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).not.toContain("todo");

			await fs.writeFile(h.settingsPath, "todo:\n  enabled: true\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).toContain("todo");
		} finally {
			await h.dispose();
		}
	}, 25_000);

	it("reconciles the task.maxRecursionDepth gate for task and hub", async () => {
		// Depth 0 cannot spawn when the max is 0, so both tools are gated off.
		const h = await makeHarness("task:\n  maxRecursionDepth: 0\n");
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("task");

			await fs.writeFile(h.settingsPath, "task:\n  maxRecursionDepth: 2\n");
			await h.session.refresh("settings");

			expect(h.session.getEnabledToolNames()).toContain("task");
		} finally {
			await h.dispose();
		}
	}, 25_000);

	it("evaluates the depth-dependent gates at the session's real depth", async () => {
		// Reconciliation assumed depth 0, so a running subagent got the top-level
		// answer for both compound gates. A depth-1 child whose max drops to 1
		// can no longer spawn, but `task` stayed advertised and the rejection only
		// surfaced at execution.
		const h = await makeHarness("task:\n  maxRecursionDepth: 2\n", { taskDepth: 1 });
		try {
			expect(h.session.getEnabledToolNames()).toContain("task");

			await fs.writeFile(h.settingsPath, "task:\n  maxRecursionDepth: 1\n");
			await h.session.refresh("settings");

			expect(h.session.getEnabledToolNames()).not.toContain("task");
			// `hub` must SURVIVE: `isIrcEnabled` deliberately returns true for every
			// subagent (it always has a parent to message), so the fix cannot be
			// "pass the real depth to task and 0 to hub" — nor 0 to both, which is
			// what dropped messaging here.
			expect(h.session.getEnabledToolNames()).toContain("hub");
		} finally {
			await h.dispose();
		}
	}, 25_000);

	it("re-filters browser MCP when an eval gate transition moves the prelude", async () => {
		// The browser filter asks whether a callable browser prelude replaces
		// those servers, which reads `eval`'s registered/active state — and this
		// reconcile is what moves it. Without a re-filter, enabling a backend
		// activates the prelude while the browser servers stay connected, and
		// disabling the last one leaves them filtered out with nothing serving
		// browser automation.
		// Owned, not inherited: the SDK creates the manager (and its disconnect
		// hook) when `enableMCP` is on, which is the ownership the reconcile
		// requires. The prototype spy captures the call whichever instance it is.
		const filterCalls: boolean[] = [];
		const reconcileSpy = vi
			.spyOn(MCPManager.prototype, "reconcileBrowserFilter")
			.mockImplementation(async filtered => {
				filterCalls.push(filtered);
			});
		const h = await makeHarness("browser:\n  enabled: true\neval:\n  py: false\n  js: false\n", {
			enableMCP: true,
		});
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("eval");

			filterCalls.length = 0;
			await fs.writeFile(h.settingsPath, "browser:\n  enabled: true\neval:\n  py: false\n  js: true\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).toContain("eval");
			expect(filterCalls).toEqual([true]);

			filterCalls.length = 0;
			await fs.writeFile(h.settingsPath, "browser:\n  enabled: true\neval:\n  py: false\n  js: false\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).not.toContain("eval");
			expect(filterCalls).toEqual([false]);
		} finally {
			reconcileSpy.mockRestore();
			await h.dispose();
		}
	}, 25_000);

	it("reconciles the eval backend gates", async () => {
		// `createTools` omits `eval` entirely when both backends are off, so the
		// Code Mode repartition had nothing to re-activate: enabling a backend
		// left JavaScript eval unavailable until restart, and disabling both left
		// the tool advertised while every invocation failed.
		const h = await makeHarness("eval:\n  py: false\n  js: false\n");
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("eval");

			await fs.writeFile(h.settingsPath, "eval:\n  py: false\n  js: true\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).toContain("eval");

			await fs.writeFile(h.settingsPath, "eval:\n  py: false\n  js: false\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).not.toContain("eval");
		} finally {
			await h.dispose();
		}
	}, 25_000);

	it("reconciles the experimental context-management tools", async () => {
		// Both `createIf`s return null while the setting is false, so the live
		// session could not gain `context_notes`/`new_context` until restart —
		// and disabling left them advertised though execution rejects.
		const h = await makeHarness("compaction:\n  experimentalContextManagement: false\n");
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("context_notes");
			expect(h.session.getEnabledToolNames()).not.toContain("new_context");

			await fs.writeFile(h.settingsPath, "compaction:\n  experimentalContextManagement: true\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).toContain("context_notes");
			expect(h.session.getEnabledToolNames()).toContain("new_context");

			await fs.writeFile(h.settingsPath, "compaction:\n  experimentalContextManagement: false\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).not.toContain("context_notes");
			expect(h.session.getEnabledToolNames()).not.toContain("new_context");
		} finally {
			await h.dispose();
		}
	}, 25_000);

	it("builds manage_skill and starts the controller when autolearn is enabled", async () => {
		const h = await makeHarness("autolearn:\n  enabled: false\n");
		try {
			expect(h.session.getEnabledToolNames()).not.toContain("manage_skill");

			await fs.writeFile(h.settingsPath, "autolearn:\n  enabled: true\n");
			await h.session.refresh("settings");

			// Pre-fix neither the tool nor the controller could appear until restart.
			expect(h.session.getEnabledToolNames()).toContain("manage_skill");
			expect(h.session.getToolByName("manage_skill")).toBeDefined();
		} finally {
			await h.dispose();
		}
	}, 25_000);

	it("moves the auto-learn guidance with the tool it describes", async () => {
		// The tool reconcile above only built/removed the TOOL. The prompt's
		// standing guidance came from the construction-time built-in list, which
		// the reconcile cannot reach — so an off→on edit activated `manage_skill`
		// with no guidance, and an on→off edit kept directing the model to a tool
		// that no longer existed.
		const h = await makeHarness("autolearn:\n  enabled: false\n");
		try {
			await h.session.refreshBaseSystemPrompt();
			expect(h.session.systemPrompt.join("\n")).not.toContain("## Auto-Learn");

			await fs.writeFile(h.settingsPath, "autolearn:\n  enabled: true\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).toContain("manage_skill");
			expect(h.session.systemPrompt.join("\n")).toContain("## Auto-Learn");

			// And back off: the guidance must leave with the tool.
			await fs.writeFile(h.settingsPath, "autolearn:\n  enabled: false\n");
			await h.session.refresh("settings");
			expect(h.session.getEnabledToolNames()).not.toContain("manage_skill");
			expect(h.session.systemPrompt.join("\n")).not.toContain("## Auto-Learn");
		} finally {
			await h.dispose();
		}
	}, 25_000);

	it("reapplies model-derived tool policy when a swap happens on an unchanged reload", async () => {
		// The resume path from the offline-model fix: `#applyReloadedModel` swaps
		// with `changed === false`, which skipped the generation-settings and
		// prompt reconciles — leaving a new model paired with the old policy.
		//
		// Observed through `pruneToolDescriptions`, whose reconcile re-resolves
		// `inlineToolDescriptors` against the LIVE model. The fixture's models all
		// resolve `auto` the same way (measured), so the live value is staged to
		// differ from the agent's field: only a reconcile that actually ran can
		// close that gap, and it is the same code path a genuinely
		// policy-divergent model pair would take.
		const h = await makeHarness("inlineToolDescriptors: true\n", { persistSession: true });
		try {
			const startingModel = h.session.model;
			const other = h.session.getAvailableModels().find(model => model.id !== startingModel?.id);
			expect(other).toBeDefined();
			if (!other || !startingModel) return;
			expect(h.session.agent.pruneToolDescriptions).toBe(true);

			const sessionFile = h.session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await h.session.sessionManager.flush();

			// The offline edit moves the default model AND the descriptor policy.
			// Reloading before the restore is what puts this in-process session in
			// the state a new process starts in.
			await fs.writeFile(
				h.settingsPath,
				`inlineToolDescriptors: false\nmodelRoles:\n  default: ${other.provider}/${other.id}\n`,
			);
			await h.session.settings.reload();
			expect(await h.session.switchSession(sessionFile)).toBe(true);
			expect(h.session.model?.id).toBe(startingModel.id);
			// The restore left the agent on the OLD policy while settings hold the new.
			expect(h.session.agent.pruneToolDescriptions).toBe(true);

			const result = await h.session.refresh("settings");

			// Nothing reloaded — the file has not moved since `reload()` above.
			expect(result.settingsChanged).toBe(false);
			expect(result.modelSwapped).toBe(true);
			// Pre-fix both of these were gated on `changed` and never ran.
			expect(h.session.model?.id).toBe(other.id);
			expect(h.session.agent.pruneToolDescriptions).toBe(false);
		} finally {
			await h.dispose();
		}
	}, 30_000);

	it("leaves other core built-ins alone when one boolean gate moves", async () => {
		// Each gate is its own lever: disabling `bash` must not disturb `glob`.
		const h = await makeHarness("bash:\n  enabled: true\nglob:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("bash");
			expect(h.session.getEnabledToolNames()).toContain("glob");

			await fs.writeFile(h.settingsPath, "bash:\n  enabled: false\nglob:\n  enabled: true\n");
			await h.session.refresh("settings");

			expect(h.session.getEnabledToolNames()).not.toContain("bash");
			expect(h.session.getEnabledToolNames()).toContain("glob");
		} finally {
			await h.dispose();
		}
	}, 20_000);

	it("reconciles each gated set independently", async () => {
		// The two settings are separate levers, so moving one must not disturb
		// the other's live state.
		const h = await makeHarness("generate_image:\n  enabled: true\nspeechgen:\n  enabled: false\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("generate_image");
			expect(h.session.getEnabledToolNames()).not.toContain("tts");

			await fs.writeFile(h.settingsPath, "generate_image:\n  enabled: true\nspeechgen:\n  enabled: true\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.getEnabledToolNames()).toContain("generate_image");
			expect(h.session.getEnabledToolNames()).toContain("tts");
		} finally {
			await h.dispose();
		}
	});

	it("restores a re-enabled set after a disable round trip", async () => {
		// A disable preserves the registry entry, so the re-enable must
		// re-activate the existing tool rather than silently finding nothing to
		// install.
		const h = await makeHarness("speechgen:\n  enabled: true\n");
		try {
			expect(h.session.getEnabledToolNames()).toContain("tts");

			await fs.writeFile(h.settingsPath, "speechgen:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(h.session.getEnabledToolNames()).not.toContain("tts");

			await fs.writeFile(h.settingsPath, "speechgen:\n  enabled: true\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(h.session.getEnabledToolNames()).toContain("tts");
		} finally {
			await h.dispose();
		}
	});
});

// A role-less, unflagged `model_change` is genuinely ambiguous: both startup's
// settings-derived receipt and an older Ctrl+P cycle pin wrote that exact shape,
// and the field that would separate them is the one neither writer set. Their
// POSITION separates them — startup's receipt is written before the session has
// any message — so the classifier reads position rather than trusting the
// missing role.
describe("createAgentSession resume: a historical role-less cycle pin survives a settings refresh", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Persist a prior transcript, then resume it through the real SDK path.
	 * `seed` writes the branch; persistence is lazy, so the caller must append a
	 * full user+assistant exchange or the JSONL never materializes.
	 */
	async function resumeWithBranch(
		seed: (manager: SessionManager, models: { modelA: Model<Api>; modelB: Model<Api> }) => void,
		configuredDefault: Model<Api>,
	): Promise<{ session: AgentSession; dispose: () => Promise<void>; settingsPath: string }> {
		const tempDir = TempDir.createSync("@pi-refresh-roleless-pin-");
		const cwd = tempDir.path();
		const modelA = bundledAnthropic("claude-sonnet-4-5");
		const modelB = bundledAnthropic("claude-sonnet-4-6");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settingsPath = path.join(cwd, "config.yml");
		await fs.writeFile(
			settingsPath,
			`modelRoles:\n  default: ${configuredDefault.provider}/${configuredDefault.id}\n`,
		);

		const prior = SessionManager.create(cwd, path.join(cwd, "prior"));
		seed(prior, { modelA, modelB });
		const sessionFile = prior.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		await prior.close();

		const sessionManager = await SessionManager.open(sessionFile, path.join(cwd, "prior"));
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: await Settings.loadIsolated({
				cwd,
				agentDir: cwd,
				overrides: { "compaction.enabled": false },
			}),
			disableExtensionDiscovery: true,
			contextFiles: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		return {
			session,
			settingsPath,
			dispose: async () => {
				await session.dispose();
				authStorage.close();
				await tempDir.remove();
			},
		};
	}

	function appendExchange(manager: SessionManager, model: Model<Api>): void {
		manager.appendMessage({ role: "user", content: "earlier turn", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: model.id,
			content: [{ type: "text", text: "earlier reply" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}

	it("preserves a role-less model_change written mid-session (the older cycle shape)", async () => {
		const modelC = bundledAnthropic("claude-haiku-4-5");
		// The prior transcript: startup's role-less receipt, a real exchange, then
		// a SECOND role-less entry — exactly what Ctrl+P recorded before the cycle
		// paths started writing role "default".
		const h = await resumeWithBranch((manager, { modelA, modelB }) => {
			manager.appendModelChange(`${modelA.provider}/${modelA.id}`);
			appendExchange(manager, modelA);
			manager.appendModelChange(`${modelB.provider}/${modelB.id}`);
		}, modelC);
		try {
			const modelB = bundledAnthropic("claude-sonnet-4-6");
			expect(h.session.model?.id).toBe(modelB.id);

			// The configured default is a THIRD model, so an unwanted auto-swap
			// would visibly replace the cycled one.
			await fs.writeFile(
				h.settingsPath,
				`modelRoles:\n  default: ${modelC.provider}/${modelC.id}\nincludeModelInPrompt: false\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the classifier read every role-less entry as
			// settings-tracking, so the refresh discarded the user's cycle pin.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("still swaps a role-less startup receipt that precedes every message", async () => {
		// The other half of the discriminator, and the reason it cannot simply
		// treat every role-less entry as a pin: a settings-derived startup keeps
		// following the configured default.
		const modelA = bundledAnthropic("claude-sonnet-4-5");
		const modelB = bundledAnthropic("claude-sonnet-4-6");
		const h = await resumeWithBranch(manager => {
			manager.appendModelChange(`${modelA.provider}/${modelA.id}`);
			appendExchange(manager, modelA);
		}, modelB);
		try {
			// Resume restores the model the TRANSCRIPT was running, not the
			// configured default, so the swap below is a real transition.
			expect(h.session.model?.id).toBe(modelA.id);

			await fs.writeFile(
				h.settingsPath,
				`modelRoles:\n  default: ${modelB.provider}/${modelB.id}\nincludeModelInPrompt: false\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("keeps a same-named custom tool active when the built-in feature is disabled", async () => {
		// An extension or SDK tool may re-register `tts`, replacing the registry
		// entry while keeping the name. Disabling `speechgen` must drop only the
		// built-in it gates: the override is somebody else's tool, and a freshly
		// started session under the new setting would still offer it. Pre-fix the
		// disable removed the ACTIVE NAME, taking the override down with it.
		const override: CustomTool = {
			name: "tts",
			label: "Custom TTS",
			description: "An extension-provided tool that happens to share the built-in's name.",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "custom tts" }] }),
		} as unknown as CustomTool;
		const h = await makeHarness("speechgen:\n  enabled: true\n", { customTools: [override] });
		try {
			expect(h.session.getEnabledToolNames()).toContain("tts");

			await fs.writeFile(h.settingsPath, "speechgen:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			// The name survives because the entry behind it is the override, not
			// the setting-gated built-in.
			expect(h.session.getEnabledToolNames()).toContain("tts");
			expect(h.session.getToolByName("tts")?.description).toContain("An extension-provided tool");
		} finally {
			await h.dispose();
		}
	});

	it("clears the registry entry when a setting-gated built-in is disabled", async () => {
		// Dropping only the ACTIVE NAME leaves an inactive registry entry behind,
		// and the late-registration path in `sdk.ts` reads any existing entry as
		// an incumbent to defer to — so an extension registering `tts` after the
		// disable would be declined, while a session freshly started under the
		// same setting exposes it. The gated group therefore removes the entries
		// it owns, leaving the name genuinely free.
		const h = await makeHarness("speechgen:\n  enabled: true\n");
		try {
			expect(h.session.getToolByName("tts")).toBeDefined();

			await fs.writeFile(h.settingsPath, "speechgen:\n  enabled: false\n");
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);

			expect(h.session.getEnabledToolNames()).not.toContain("tts");
			expect(h.session.getToolByName("tts")).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});
});
