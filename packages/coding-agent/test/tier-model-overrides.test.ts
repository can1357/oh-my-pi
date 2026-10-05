import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { validateModelServiceTierOverrides } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTierModelOverrides } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const ASTRA = "openai-codex/gpt-6-astra";
const LUNA = "openai-codex/gpt-6-luna";

// `tier.modelOverrides` is a session tier selection, not a request-time hint:
// it materializes into the session's per-model map, `/fast` edits that map for
// a pinned model, and the transcript persists it so resume restores the
// selection instead of re-deriving it from settings.
describe("tier.modelOverrides", () => {
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		for (const authStorage of authStorages) authStorage.close();
		authStorages.length = 0;
	});

	function openAuthStorage(provider: string): AuthStorage {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(provider, "test-token");
		authStorages.push(authStorage);
		return authStorage;
	}

	async function openSession(
		tempDir: TempDir,
		settings: Settings,
		modelPattern: string,
		sessionManager: SessionManager = SessionManager.inMemory(),
		taskDepth = 0,
	) {
		const authStorage = openAuthStorage(modelPattern.slice(0, modelPattern.indexOf("/")));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings,
			sessionManager,
			taskDepth,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern,
		});
		return session;
	}

	it("pins one model over its family while siblings keep the family tier", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-pin-");
		const settings = Settings.isolated({
			"tier.openai": "priority",
			"tier.modelOverrides": { [ASTRA]: "ultrafast" },
		});

		const pinned = await openSession(tempDir, settings, ASTRA);
		try {
			expect(pinned.model?.id).toBe("gpt-6-astra");
			expect(pinned.isUltrafastModeEnabled()).toBe(true);
			expect(pinned.serviceTierByModel).toEqual({ [ASTRA]: "ultrafast" });
		} finally {
			await pinned.dispose();
		}

		const sibling = await openSession(tempDir, settings, LUNA);
		try {
			expect(sibling.model?.id).toBe("gpt-6-luna");
			expect(sibling.isFastModeEnabled()).toBe(true);
			expect(sibling.isUltrafastModeEnabled()).toBe(false);
		} finally {
			await sibling.dispose();
		}
	});

	it("lets an explicit none pin shadow the family tier", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-none-");
		const session = await openSession(
			tempDir,
			Settings.isolated({ "tier.openai": "priority", "tier.modelOverrides": { [ASTRA]: "none" } }),
			ASTRA,
		);
		try {
			expect(session.isFastModeEnabled()).toBe(false);
			expect(session.isUltrafastModeEnabled()).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	it("edits the pinned model's own entry on /fast off and on, leaving the family alone", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-fast-");
		const session = await openSession(
			tempDir,
			Settings.isolated({ "tier.openai": "priority", "tier.modelOverrides": { [ASTRA]: "ultrafast" } }),
			ASTRA,
		);
		try {
			expect(session.setFastMode(false)).toBe(true);
			expect(session.serviceTierByModel).toEqual({ [ASTRA]: "none" });
			expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
			expect(session.isFastModeEnabled()).toBe(false);

			expect(session.setFastMode(true)).toBe(true);
			expect(session.serviceTierByModel).toEqual({ [ASTRA]: "priority" });
			expect(session.isFastModeEnabled()).toBe(true);
		} finally {
			await session.dispose();
		}
	});

	it("keeps /fast family-scoped for a model without its own entry", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-unpinned-");
		const session = await openSession(
			tempDir,
			Settings.isolated({ "tier.openai": "priority", "tier.modelOverrides": { [ASTRA]: "ultrafast" } }),
			LUNA,
		);
		try {
			expect(session.setFastMode(false)).toBe(true);
			expect(session.serviceTierByFamily).toEqual({});
			expect(session.serviceTierByModel).toEqual({ [ASTRA]: "ultrafast" });
		} finally {
			await session.dispose();
		}
	});

	it("restores the session's model map on resume instead of re-deriving it from settings", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-resume-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const pinnedSettings = Settings.isolated({
			"tier.openai": "priority",
			"tier.modelOverrides": { [ASTRA]: "ultrafast" },
		});

		const first = await openSession(
			tempDir,
			pinnedSettings,
			ASTRA,
			await SessionManager.open(sessionFile, tempDir.path()),
		);
		try {
			expect(first.setFastMode(false)).toBe(true);
		} finally {
			await first.dispose();
		}

		// The resumed session's settings no longer pin the model; the transcript's
		// explicit `none` must still win over the family tier.
		const resumed = await openSession(
			tempDir,
			Settings.isolated({ "tier.openai": "priority" }),
			ASTRA,
			await SessionManager.open(sessionFile, tempDir.path()),
		);
		try {
			expect(resumed.serviceTierByModel).toEqual({ [ASTRA]: "none" });
			expect(resumed.isFastModeEnabled()).toBe(false);
		} finally {
			await resumed.dispose();
		}
	});

	it("keeps /fast ultra off the family when the active model has its own non-ultrafast entry", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-ultra-");
		const session = await openSession(
			tempDir,
			Settings.isolated({ "tier.openai": "ultrafast", "tier.modelOverrides": { [ASTRA]: "priority" } }),
			ASTRA,
		);
		try {
			expect(session.isUltrafastModeEnabled()).toBe(false);
			expect(session.setUltrafastMode(false)).toBe(true);
			// The pinned model's own entry is its most specific slot; the family
			// selection unpinned siblings read must survive.
			expect(session.serviceTierByModel).toEqual({ [ASTRA]: "priority" });
			expect(session.serviceTierByFamily).toEqual({ openai: "ultrafast" });
		} finally {
			await session.dispose();
		}
	});

	it("persists a model-only selection so resume restores it", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-model-only-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const first = await openSession(
			tempDir,
			Settings.isolated({ "tier.modelOverrides": { [ASTRA]: "ultrafast" } }),
			ASTRA,
			await SessionManager.open(sessionFile, tempDir.path()),
		);
		try {
			expect(first.serviceTierByModel).toEqual({ [ASTRA]: "ultrafast" });
		} finally {
			await first.dispose();
		}

		// No family tier and no launch flag: the model map alone must still be
		// recorded, so the resumed session keeps its selection instead of
		// re-deriving it from settings.
		const resumed = await openSession(
			tempDir,
			Settings.isolated(),
			ASTRA,
			await SessionManager.open(sessionFile, tempDir.path()),
		);
		try {
			expect(resumed.serviceTierByModel).toEqual({ [ASTRA]: "ultrafast" });
			expect(resumed.isUltrafastModeEnabled()).toBe(true);
		} finally {
			await resumed.dispose();
		}
	});

	it("leaves a non-fast pin alone on /fast off", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-flex-");
		const session = await openSession(
			tempDir,
			Settings.isolated({ "tier.openai": "priority", "tier.modelOverrides": { [ASTRA]: "flex" } }),
			ASTRA,
		);
		try {
			expect(session.setFastMode(false)).toBe(true);
			// `off` clears a fast selection; a `flex` pin is not one, so it survives.
			expect(session.serviceTierByModel).toEqual({ [ASTRA]: "flex" });
			expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
		} finally {
			await session.dispose();
		}
	});

	it("ignores a pin the model's family cannot realize", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-family-");
		const claude = "anthropic/claude-sonnet-4-5";
		const session = await openSession(
			tempDir,
			Settings.isolated({ "tier.anthropic": "priority", "tier.modelOverrides": { [claude]: "ultrafast" } }),
			claude,
		);
		try {
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			// Anthropic realizes only `priority`; the unrealizable pin must not hide
			// the family tier the model actually runs.
			expect(session.isFastModeEnabled()).toBe(true);
			expect(session.isUltrafastModeEnabled()).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	it("keeps a subagent's model map frozen across config reloads", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-sub-");
		const settings = Settings.isolated();
		cfgTierModelOverrides.set(settings, { [ASTRA]: "ultrafast" });
		const subagent = await openSession(tempDir, settings, ASTRA, SessionManager.inMemory(), 1);
		try {
			expect(subagent.serviceTierByModel).toEqual({ [ASTRA]: "ultrafast" });
			cfgTierModelOverrides.set(settings, { [ASTRA]: "priority" });
			await Promise.resolve();
			// The child's map is a spawn-time snapshot, like the family keys
			// `createSubagentSettings` pins; a parent config edit must not re-steer it.
			expect(subagent.serviceTierByModel).toEqual({ [ASTRA]: "ultrafast" });
		} finally {
			await subagent.dispose();
		}
	});

	it("applies config pin reloads to the main session", async () => {
		using tempDir = TempDir.createSync("@omp-tier-model-overrides-main-");
		const settings = Settings.isolated();
		cfgTierModelOverrides.set(settings, { [ASTRA]: "ultrafast" });
		const main = await openSession(tempDir, settings, ASTRA);
		try {
			cfgTierModelOverrides.set(settings, { [ASTRA]: "priority" });
			await Promise.resolve();
			expect(main.serviceTierByModel).toEqual({ [ASTRA]: "priority" });
		} finally {
			await main.dispose();
		}
	});

	it("rejects a malformed container or unknown value during settings load", async () => {
		await expect(
			Settings.loadIsolated({ inMemory: true, overrides: { "tier.modelOverrides": "ultrafast" } }),
		).rejects.toThrow("Invalid tier.modelOverrides: expected a map of model selector to service tier, got a string.");
		expect(() => validateModelServiceTierOverrides({ [ASTRA]: "fast" })).toThrow(
			`Invalid service tier for tier.modelOverrides.${ASTRA}: fast. Expected one of: none, auto, default, flex, scale, priority, ultrafast.`,
		);
	});
});
