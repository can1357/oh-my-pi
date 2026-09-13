/**
 * `/refresh settings` model-swap precedence, exercised through the real
 * `createAgentSession` SDK path against on-disk config, so it defends the
 * user-visible contract:
 *
 *   - An EXPLICIT in-session `/model` pick (role `default`) survives a later
 *     `refresh('settings')` that changed the configured default. The auto-swap
 *     must not clobber a user pin. (Pre-fix, the swap predicate treated role
 *     `default` as still-tracking and replaced the pick.)
 *   - A session with NO explicit pick (startup role undefined, or a prior
 *     settings-tracking auto-swap) STILL follows the reloaded default. The
 *     tracking marker keeps the session swappable across refreshes.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
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
	modelB: Model<Api>;
	dispose: () => Promise<void>;
}

async function makeHarness(options?: {
	explicitStartupModel?: boolean;
	defaultSelector?: string;
	/**
	 * Full config.yml body, replacing the default `modelRoles.default` seed. Used
	 * to exercise a config that configures NO default role (so startup falls
	 * through to the available-model pick) while some auxiliary role IS set.
	 */
	rawConfig?: string;
	/**
	 * An EXPLICIT startup thinking selection, as CLI `--thinking <level>` /
	 * SDK `options.thinkingLevel` supplies. Distinct from a level the config
	 * merely happens to resolve to.
	 */
	thinkingLevel?: ConfiguredThinkingLevel;
	/**
	 * Extra providers to hold a runtime key, so `setModel` passes its
	 * `hasConfiguredAuth` gate for a model outside the anthropic default.
	 */
	extraProviders?: readonly string[];
}): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-model-swap-");
	const cwd = tempDir.path();
	const modelA = bundledAnthropic("claude-sonnet-4-5");
	const modelB = bundledAnthropic("claude-sonnet-4-6");

	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	for (const provider of options?.extraProviders ?? []) {
		authStorage.setRuntimeApiKey(provider, "test-key");
	}
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const settingsPath = path.join(cwd, "config.yml");
	const defaultSelector = options?.defaultSelector ?? "anthropic/claude-sonnet-4-5";
	await fs.writeFile(settingsPath, options?.rawConfig ?? `modelRoles:\n  default: ${defaultSelector}\n`);

	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: await Settings.loadIsolated({
			cwd,
			agentDir: cwd,
			overrides: { "compaction.enabled": false },
		}),
		// Default: settings-derived startup (role-less init model_change, swappable).
		// Opt into an EXPLICIT startup model (as CLI `--model`/`options.model` does)
		// to exercise the explicit-startup-is-a-pin path.
		...(options?.explicitStartupModel ? { model: modelA } : {}),
		...(options?.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
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
		cwd,
		settingsPath,
		modelA,
		modelB,
		dispose: async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		},
	};
}

describe("AgentSession refresh('settings'): model-swap precedence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves an explicit in-session model pick across a settings refresh", async () => {
		const h = await makeHarness();
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// The user explicitly pins model-b this session. `setModel` with no role
			// writes role "default", exactly as an ACP/RPC/selector pick does.
			await h.session.setModel(h.modelB);
			expect(h.session.model?.id).toBe(h.modelB.id);

			// The configured default changes on disk to a THIRD model, then refresh.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${modelC.provider}/${modelC.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: role "default" read as still-tracking, so the swap clobbered
			// the pin. Post-fix: an explicit "default" is a pin — no swap.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("follows the reloaded default when the session has no explicit pick", async () => {
		const h = await makeHarness();
		try {
			// Startup wrote the initial model_change with role UNDEFINED (no pin).
			expect(h.session.model?.id).toBe(h.modelA.id);

			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelB.provider}/${h.modelB.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("keeps following the default after a prior settings-tracking swap", async () => {
		const h = await makeHarness();
		try {
			// First refresh performs a tracking auto-swap (role sentinel, not a pin).
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelB.provider}/${h.modelB.id}\n`);
			const first = await h.session.refresh("settings");
			expect(first.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelB.id);

			// A second on-disk change must still swap: the tracking marker left the
			// session swappable, unlike an explicit pin.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}\n`);
			const second = await h.session.refresh("settings");
			expect(second.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelA.id);
		} finally {
			await h.dispose();
		}
	});

	it("treats a user role literally named 'settings' as a PINNED explicit pick", async () => {
		const h = await makeHarness();
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// The user configures a CUSTOM model role NAMED "settings" and picks it.
			// This must read as an explicit pin, never as the internal auto-swap
			// marker (which is now a dedicated entry flag, not the role string).
			await h.session.setModel(h.modelB, "settings");
			expect(h.session.model?.id).toBe(h.modelB.id);

			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${modelC.provider}/${modelC.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix (role string "settings" overloaded as the marker), the swap
			// predicate read this as still-tracking and clobbered the pick.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("still swaps a flag-marked settings-tracking entry (auto-swap stays swappable)", async () => {
		const h = await makeHarness();
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// First refresh auto-swaps: the model_change is marked with the
			// settingsTracking flag (role "default"), not a role sentinel.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelB.provider}/${h.modelB.id}\n`);
			expect((await h.session.refresh("settings")).modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelB.id);
			// The flag left the session swappable, so a later change swaps again —
			// even though the marker entry carries role "default".
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${modelC.provider}/${modelC.id}\n`);
			const second = await h.session.refresh("settings");
			expect(second.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(modelC.id);
		} finally {
			await h.dispose();
		}
	});

	it("preserves an explicitly cycled model across a settings refresh", async () => {
		const h = await makeHarness();
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// The user cycles the active model (alt+m style). A cycle is an
			// explicit user pick, exactly like `setModel`, so it must survive a
			// later refresh that changed the configured default.
			const cycled = await h.session.cycleModel();
			if (!cycled) throw new Error("Expected cycleModel to switch models");
			const cycledId = cycled.model.id;
			expect(h.session.model?.id).toBe(cycledId);

			// Change the on-disk default to a model that is NOT the cycled one (and
			// differs from the current on-disk default modelA), so an unwanted
			// auto-swap would visibly replace the cycled model.
			const newDefault = [h.modelB, modelC].find(m => m.id !== cycledId);
			if (!newDefault) throw new Error("Expected a distinct model for the new default");
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${newDefault.provider}/${newDefault.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the cycle recorded a role-less, non-tracking model_change,
			// so the swap predicate read it as still-tracking and clobbered it.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(cycledId);
		} finally {
			await h.dispose();
		}
	});

	it("preserves a user pin buried beneath an ephemeral retry-fallback entry", async () => {
		const h = await makeHarness();
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// The user explicitly pins model-b this session.
			await h.session.setModel(h.modelB);
			expect(h.session.model?.id).toBe(h.modelB.id);

			// Retry recovery later appends an ephemeral fallback transition on top
			// of the pin, exactly as the retry-fallback path records it: role
			// "fallback", resolvedModelIsFallback true. It masks the pin as the
			// newest model_change but is not itself a user choice.
			h.session.sessionManager.appendModelChange(
				`${modelC.provider}/${modelC.id}`,
				EPHEMERAL_MODEL_CHANGE_ROLE,
				true,
			);

			// The configured default changes on disk, then refresh runs while the
			// fallback entry is the latest transition.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${modelC.provider}/${modelC.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the classifier stopped at the ephemeral entry and read it as
			// "no pin", so the swap clobbered model-b. Post-fix: it walks past the
			// fallback to the underlying pin and preserves it.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelB.id);
		} finally {
			await h.dispose();
		}
	});

	it("preserves an explicit startup model (--model) across a settings refresh", async () => {
		const h = await makeHarness({ explicitStartupModel: true });
		const modelC = bundledAnthropic("claude-haiku-4-5");
		try {
			// The session started with an EXPLICIT `options.model` (as CLI `--model`
			// does). That is a user pin, even though the user made no in-session
			// pick: SDK init records the startup model_change, and an explicit
			// startup must survive a later default change.
			expect(h.session.model?.id).toBe(h.modelA.id);

			// The configured default changes on disk to a THIRD model, then refresh.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${modelC.provider}/${modelC.id}\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the init model_change was role-less, so the classifier read it
			// as still-tracking and the swap clobbered the explicit startup model.
			// Post-fix: an explicit startup model is a pin — no swap.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelA.id);
		} finally {
			await h.dispose();
		}
	});

	it("applies a default-role thinking-level change on the same model across a refresh", async () => {
		const h = await makeHarness({ defaultSelector: "anthropic/claude-sonnet-4-5:low" });
		try {
			// Startup resolved the default role's explicit `:low` suffix.
			expect(h.session.model?.id).toBe(h.modelA.id);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			// The default selector moves to `:high` on the SAME model id.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}:high\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// The model id is unchanged, so no swap — but the thinking level must
			// follow the new selector. Pre-fix: the equality short-circuit exited
			// before applying the level, leaving the session at `low`.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await h.dispose();
		}
	});

	it("resets thinking to the model/default configuration when the default-role suffix is removed", async () => {
		// Config also pins a distinct global `defaultThinkingLevel` so the fallback
		// target (used when the model exposes no metadata default) is observably
		// different from the prior explicit `:high` — proving the reset happened.
		const h = await makeHarness({ defaultSelector: "anthropic/claude-sonnet-4-5:high" });
		try {
			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: low\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}:high\n`,
			);
			await h.session.refresh("settings");
			expect(h.session.model?.id).toBe(h.modelA.id);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);

			// The default selector drops the `:high` suffix on the SAME model id.
			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: low\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(false);
			// Pre-fix: the re-apply was gated on a defined resolved level, so the
			// removed suffix left the session stuck at `high`. Post-fix: it falls
			// back to the model/default thinking configuration (here the global
			// `defaultThinkingLevel`).
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		} finally {
			await h.dispose();
		}
	});

	it("does not demote the primary model onto an auxiliary role when no default role is configured", async () => {
		// Config configures NO `modelRoles.default`, but DOES configure the
		// auxiliary `smol` role — a common shape for someone who only wants to
		// pin the cheap subagent model. Startup therefore resolved the primary
		// through the available-model pick, NOT through `smol`.
		const smolModel = bundledAnthropic("claude-haiku-4-5");
		const h = await makeHarness({
			rawConfig: `modelRoles:\n  smol: ${smolModel.provider}/${smolModel.id}\n`,
		});
		try {
			const startupModel = h.session.model;
			if (!startupModel) throw new Error("Expected a startup model");
			// Guard the premise: startup did not pick the smol model, so a later
			// swap onto it is observably a demotion rather than a no-op.
			expect(startupModel.id).not.toBe(smolModel.id);

			// An UNRELATED settings edit (nothing about models) makes the reload
			// report `changed`, which is what triggers the model re-resolution.
			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: low\nmodelRoles:\n  smol: ${smolModel.provider}/${smolModel.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: resolution walked every MODEL_ROLE_IDS entry, so with
			// `default` absent the configured `smol` role won and an unrelated
			// config edit silently replaced the primary model with the cheap task
			// model. Post-fix: only the `default` role is resolved, and its absence
			// falls back to startup's available-model pick — the same model
			// startup chose, so nothing swaps.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(startupModel.id);
			expect(h.session.model?.id).not.toBe(smolModel.id);
		} finally {
			await h.dispose();
		}
	});
});

// A session-level thinking selection is the highest-precedence thinking choice,
// exactly as a `/model` pin is for the model: `#applyReloadedModel` re-derives
// the configured/model-default level on every settings refresh, so without a
// pin check an unrelated settings edit silently overwrites what the user (or an
// RPC/ACP client) explicitly asked for. The mirror case is a REMOVED `:level`
// suffix whose fallback chain resolves to nothing — that IS startup's answer and
// must be applied, not skipped.
describe("AgentSession refresh('settings'): thinking-level precedence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves an explicit session thinking selection across an unrelated settings refresh", async () => {
		const h = await makeHarness({ defaultSelector: "anthropic/claude-sonnet-4-5:low" });
		try {
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			// The user (or an RPC/ACP client) explicitly picks a different level.
			h.session.setThinkingLevel(ThinkingLevel.Minimal);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);

			// An UNRELATED settings edit — the model selector, INCLUDING its `:low`
			// suffix, is byte-identical — makes the reload report `changed`, which is
			// what re-runs model/thinking resolution.
			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}:low\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(false);
			// Pre-fix: the model-unchanged branch recomputed the configured `:low`
			// and called setThinkingLevel, silently discarding the explicit pick.
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);
		} finally {
			await h.dispose();
		}
	});

	it("still follows a changed configured level when thinking was never explicitly picked", async () => {
		// Guards the pin check from over-reaching: a session whose level came from
		// settings must keep tracking settings across refreshes.
		const h = await makeHarness({ defaultSelector: "anthropic/claude-sonnet-4-5:low" });
		try {
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}:high\n`);
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);

			// And AGAIN: the tracking re-apply must itself stay tracking, or the
			// second refresh would read the first one's receipt as a user pin.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}:medium\n`);
			expect((await h.session.refresh("settings")).settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);
		} finally {
			await h.dispose();
		}
	});

	it("clears thinking when a removed suffix has no model or global fallback", async () => {
		// `defaultThinkingLevel` is explicitly null and sonnet-4-5 exposes no
		// `thinking.defaultLevel`, so the post-removal fallback chain resolves to
		// `undefined` — startup's own answer for this config.
		const h = await makeHarness({ defaultSelector: "anthropic/claude-sonnet-4-5:high" });
		try {
			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel:\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}:high\n`,
			);
			await h.session.refresh("settings");
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);

			// Drop the `:high` suffix on the SAME model id.
			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel:\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(false);
			// Pre-fix: the re-apply was gated on a DEFINED target, so an undefined
			// fallback performed no update and `high` stayed active forever.
			expect(h.session.configuredThinkingLevel()).toBeUndefined();
		} finally {
			await h.dispose();
		}
	});

	it("does not clear an explicit selection when the removed suffix has no fallback", async () => {
		// The two fixes compose: suffix removal resolves to `undefined`, but an
		// explicit session pick still outranks it.
		const h = await makeHarness({ defaultSelector: "anthropic/claude-sonnet-4-5:high" });
		try {
			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel:\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}:high\n`,
			);
			await h.session.refresh("settings");

			h.session.setThinkingLevel(ThinkingLevel.Medium);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);

			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel:\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);
		} finally {
			await h.dispose();
		}
	});

	it("keeps an explicit thinking pin when a settings-driven swap lands on a different model default", async () => {
		// The target must expose a `thinking.defaultLevel` that DIFFERS from the
		// pin, or `setModel`'s re-apply has nothing to move and the test passes
		// vacuously: `cline-pass/glm-5.2` carries `high`, and no bundled anthropic
		// model exposes one at all.
		//
		// The pin is `low`, not `minimal`: glm-5.2's effort ladder is
		// `low|high|max`, so a `minimal` pin is CLAMPED to `low` on the swap and
		// the assertion would pass without the fix — the clamp, not the restore,
		// would be doing the work.
		//
		// Pre-fix, the swap's own `#reapplyThinkingLevel(target.thinking
		// .defaultLevel)` overwrote the pinned level with `high` before the
		// follows-settings guard ran — and that guard only ever sees the
		// post-swap value, so it could not restore it.
		const target = getBundledModel("cline-pass", "glm-5.2");
		if (!target) throw new Error("Expected bundled cline-pass model glm-5.2");
		const h = await makeHarness({
			extraProviders: ["cline-pass"],
			rawConfig: `compaction:\n  enabled: false\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			// An explicit user pin, not a settings-derived level.
			h.session.setThinkingLevel(ThinkingLevel.Low);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			// The operator repoints the default role at the model whose own
			// thinking default is `high`.
			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\nmodelRoles:\n  default: ${target.provider}/${target.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// The swap itself is still allowed — only the thinking pin is protected.
			expect(result.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(target.id);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		} finally {
			await h.dispose();
		}
	});

	it("applies the global fallback after swapping onto a suffix-less model", async () => {
		// The reviewer's scenario: a `:high` default selector, then the default
		// moves to a DIFFERENT, suffix-less model while `defaultThinkingLevel` is
		// `low`. Neither sonnet-4-5 nor sonnet-4-6 exposes a `thinking.defaultLevel`,
		// so startup's chain (no suffix -> no model default -> global) resolves `low`.
		const h = await makeHarness({ defaultSelector: "anthropic/claude-sonnet-4-5:high" });
		try {
			expect(h.session.model?.id).toBe(h.modelA.id);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);

			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: low\nmodelRoles:\n  default: ${h.modelB.provider}/${h.modelB.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelB.id);
			// Pre-fix: the post-swap re-apply ran only for an EXPLICIT suffix, and
			// `setModel` preserves the prior level when the new model exposes no
			// metadata default — so the session stayed at the predecessor's `high`.
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		} finally {
			await h.dispose();
		}
	});

	it("does not clobber an explicit session selection when the swap applies a fallback", async () => {
		// Guard on the fix above: the fallback is settings-tracking resolution, so
		// it must yield to a real user/RPC/ACP thinking pick across the swap.
		const h = await makeHarness({ defaultSelector: "anthropic/claude-sonnet-4-5:high" });
		try {
			h.session.setThinkingLevel(ThinkingLevel.Medium);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);

			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: low\nmodelRoles:\n  default: ${h.modelB.provider}/${h.modelB.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelB.id);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);
		} finally {
			await h.dispose();
		}
	});

	it("keeps auto thinking across a settings-driven model swap", async () => {
		// The post-swap fallback now runs unconditionally, so it must not resolve
		// `auto` into the concrete level it provisionally shows: `auto` is a live
		// per-turn mode, and `configuredThinkingLevel()` reports it as `auto`, so
		// the inequality check keeps the re-apply a no-op.
		const h = await makeHarness({
			rawConfig: `defaultThinkingLevel: auto\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			expect(h.session.isAutoThinking).toBe(true);

			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: auto\nmodelRoles:\n  default: ${h.modelB.provider}/${h.modelB.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.modelSwapped).toBe(true);
			expect(h.session.model?.id).toBe(h.modelB.id);
			expect(h.session.isAutoThinking).toBe(true);
		} finally {
			await h.dispose();
		}
	});

	it("preserves an explicit startup --thinking auto across an unrelated settings refresh", async () => {
		// An explicit `auto` selection is a session pin, exactly like an explicit
		// concrete level. Startup skips the receipt for `auto` (the per-turn
		// classifier writes its own), and every classifier receipt is
		// `autoResolved` — which the tracking scan walks PAST — so with no
		// selection receipt at all the branch holds nothing and
		// `#thinkingFollowsSettings()` falls through to its `true` default. An
		// unrelated settings edit then re-derives the configured level over the
		// user's explicit `auto`.
		const h = await makeHarness({
			thinkingLevel: AUTO_THINKING,
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			expect(h.session.isAutoThinking).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(AUTO_THINKING);

			// An UNRELATED settings edit: the model selector is byte-identical and
			// `defaultThinkingLevel` is unchanged, but the reload reports `changed`,
			// which is what re-runs thinking resolution.
			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\nincludeModelInPrompt: false\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(false);
			// Pre-fix: with no selection receipt, the session read as
			// settings-tracking and the configured `low` replaced the explicit auto.
			expect(h.session.isAutoThinking).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		} finally {
			await h.dispose();
		}
	});

	it("reconciles settings-derived thinking when only the MODEL is pinned", async () => {
		// A `/model` pick pins the model but says nothing about thinking: the
		// re-apply it performs is a no-op when the level does not move, so no new
		// receipt is written and the session's thinking still FOLLOWS settings.
		// Editing the configured default must therefore still reach it.
		const h = await makeHarness();
		try {
			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: low\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}\n`,
			);
			await h.session.refresh("settings");
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			// Pin the MODEL only — no thinking suffix, no explicit level.
			await h.session.setModel(h.modelB);
			expect(h.session.model?.id).toBe(h.modelB.id);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			// Move the configured thinking default. The pinned model must stay
			// pinned, but thinking never had a session-level override.
			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: high\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// The pin still holds.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelB.id);
			// Pre-fix: the model-pin early return short-circuited the whole
			// method, so the independent thinking-tracking reconcile below it
			// never ran and the old level stayed active solely because the model
			// was pinned.
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await h.dispose();
		}
	});

	it("does not touch thinking on a pinned model when thinking is ALSO pinned", async () => {
		// Guard on the fix above: reconciling under a model pin must still yield
		// to a real session-level thinking selection.
		const h = await makeHarness();
		try {
			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: low\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}\n`,
			);
			await h.session.refresh("settings");

			await h.session.setModel(h.modelB);
			// `medium` — not `minimal`, which these models clamp to `low`, making
			// the assertion untestable rather than wrong.
			h.session.setThinkingLevel(ThinkingLevel.Medium);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);

			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: high\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelB.id);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);
		} finally {
			await h.dispose();
		}
	});

	it("keeps auto thinking on a pinned model across a settings refresh", async () => {
		// The pinned-model reconcile must not resolve `auto` into the concrete
		// level it provisionally shows — same invariant the swap path holds.
		const h = await makeHarness({
			rawConfig: `defaultThinkingLevel: auto\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			expect(h.session.isAutoThinking).toBe(true);

			await h.session.setModel(h.modelB);
			expect(h.session.isAutoThinking).toBe(true);

			await fs.writeFile(
				h.settingsPath,
				`defaultThinkingLevel: auto\nmodelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelB.id);
			expect(h.session.isAutoThinking).toBe(true);
		} finally {
			await h.dispose();
		}
	});

	it("keeps a settings-derived auto following the configured level", async () => {
		// Guards the receipt from over-reaching: `auto` reached only through
		// `defaultThinkingLevel: auto` (no explicit request) must stay swappable,
		// so flipping the configured level to a concrete one still applies.
		const h = await makeHarness({
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: auto\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			expect(h.session.isAutoThinking).toBe(true);

			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: medium\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.isAutoThinking).toBe(false);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);
		} finally {
			await h.dispose();
		}
	});

	// An explicit selection that happens to MATCH the current level is still a
	// selection. `setThinkingLevel` skips its receipt when the effective effort
	// does not move, so the latest entry stayed the settings-derived one and the
	// session kept reading as still-following-settings — letting a later
	// `/refresh settings` overwrite a pin the user really did make.
	it("preserves an explicit selection that matched the then-current settings level", async () => {
		const h = await makeHarness({ defaultSelector: "anthropic/claude-sonnet-4-5:low" });
		try {
			// The level came from settings, not from a user action.
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			// The user explicitly selects `low` — the level already active. This is
			// the ACP/RPC and selector path, and it is a pin even though nothing
			// about the effective effort changes.
			h.session.setThinkingLevel(ThinkingLevel.Low);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			// The configured default then MOVES on disk.
			await fs.writeFile(h.settingsPath, `modelRoles:\n  default: ${h.modelA.provider}/${h.modelA.id}:high\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(result.modelSwapped).toBe(false);
			// Pre-fix: the no-change selection wrote no receipt, so the latest
			// entry was still `settingsTracking: true` and the refresh replaced
			// the user's explicit `low` with the newly configured `high`.
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);
		} finally {
			await h.dispose();
		}
	});

	// The same shape for an explicit `auto` re-selection: re-selecting the auto
	// mode already active must still pin it against a later configured move.
	it("preserves an explicit auto re-selection when auto was already active from settings", async () => {
		const h = await makeHarness({
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: auto\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			// `auto` came from settings, so it is currently swappable.
			expect(h.session.isAutoThinking).toBe(true);

			// The user explicitly re-selects auto — already active, so no effective
			// change, but a real selection.
			h.session.setThinkingLevel(AUTO_THINKING);
			expect(h.session.isAutoThinking).toBe(true);

			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: medium\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: no receipt was written for the unchanged auto re-selection,
			// so the configured `medium` replaced the user's explicit auto.
			expect(h.session.isAutoThinking).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		} finally {
			await h.dispose();
		}
	});
});

// `--resume ... --model X` is just as explicit a pin as `--model X` on a fresh
// session, but the resumed path took no marker at all: with the persisted
// branch's latest model_change role-less, the session classified the explicitly
// requested model as settings-tracking and the next settings refresh replaced it.
describe("createAgentSession resume: explicit model is a pin", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves an explicit --model across a settings refresh on a resumed session", async () => {
		const tempDir = TempDir.createSync("@pi-refresh-resume-model-");
		const cwd = tempDir.path();
		const modelA = bundledAnthropic("claude-sonnet-4-5");
		const modelB = bundledAnthropic("claude-sonnet-4-6");
		const modelC = bundledAnthropic("claude-haiku-4-5");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settingsPath = path.join(cwd, "config.yml");
		await fs.writeFile(settingsPath, `modelRoles:\n  default: ${modelA.provider}/${modelA.id}\n`);

		// A prior session persisted a ROLE-LESS model_change (the settings-derived
		// startup shape) plus a real exchange, so the branch is non-empty and the
		// next launch takes the `hasExistingSession` resume path. Persistence is
		// lazy: the JSONL only materializes once the history holds an assistant
		// message, so the transcript needs a full turn, not just a user message.
		const prior = SessionManager.create(cwd, path.join(cwd, "prior"));
		prior.appendModelChange(`${modelA.provider}/${modelA.id}`);
		prior.appendMessage({ role: "user", content: "earlier turn", timestamp: Date.now() });
		prior.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: modelA.id,
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
			// The resume carries an EXPLICIT model, as `--resume ... --model` does.
			model: modelB,
			disableExtensionDiscovery: true,
			contextFiles: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.model?.id).toBe(modelB.id);

			// The configured default moves to a THIRD model, then refresh.
			await fs.writeFile(settingsPath, `modelRoles:\n  default: ${modelC.provider}/${modelC.id}\n`);
			const result = await session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the `appendModelChange(..., "default")` pin marker was
			// confined to the new-session branch, so the resumed session's newest
			// non-ephemeral model_change stayed role-less, read as settings-tracking,
			// and the swap clobbered the explicitly requested model.
			expect(result.modelSwapped).toBe(false);
			expect(session.model?.id).toBe(modelB.id);
		} finally {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		}
	});

	it("preserves an explicit --thinking across a settings refresh on a resumed session", async () => {
		const tempDir = TempDir.createSync("@pi-refresh-resume-thinking-");
		const cwd = tempDir.path();
		const modelA = bundledAnthropic("claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settingsPath = path.join(cwd, "config.yml");
		// No suffix on the selector and no `defaultThinkingLevel`, so nothing in
		// the config resolves a level: the session's `high` can only have come
		// from the explicit option.
		await fs.writeFile(
			settingsPath,
			`defaultThinkingLevel:\nmodelRoles:\n  default: ${modelA.provider}/${modelA.id}\n`,
		);

		// A prior session with a real exchange and NO thinking_level_change, so
		// the resumed branch holds no thinking receipt at all — the shape
		// `#thinkingFollowsSettings()` reads as still-following-settings.
		const prior = SessionManager.create(cwd, path.join(cwd, "prior"));
		prior.appendModelChange(`${modelA.provider}/${modelA.id}`);
		prior.appendMessage({ role: "user", content: "earlier turn", timestamp: Date.now() });
		prior.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: modelA.id,
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
			// The resume carries an EXPLICIT thinking level, as
			// `--resume ... --thinking high` does.
			thinkingLevel: ThinkingLevel.High,
			disableExtensionDiscovery: true,
			contextFiles: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.High);

			// An unrelated settings edit that moves the CONFIGURED default level.
			await fs.writeFile(
				settingsPath,
				`defaultThinkingLevel: low\nmodelRoles:\n  default: ${modelA.provider}/${modelA.id}\n`,
			);
			const result = await session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the non-settings-tracking thinking receipt was confined to
			// the new-session branch, so the resumed branch held NO thinking entry,
			// `#thinkingFollowsSettings()` fell through to its follows-settings
			// default, and the refresh overwrote the explicitly requested level.
			expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		}
	});

	it("still follows the configured level on a resume with NO explicit thinking", async () => {
		// Guards the receipt from over-reaching: a resume that requested nothing
		// must keep tracking settings, so the marker cannot be unconditional.
		const tempDir = TempDir.createSync("@pi-refresh-resume-thinking-tracking-");
		const cwd = tempDir.path();
		const modelA = bundledAnthropic("claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settingsPath = path.join(cwd, "config.yml");
		await fs.writeFile(
			settingsPath,
			`defaultThinkingLevel: minimal\nmodelRoles:\n  default: ${modelA.provider}/${modelA.id}\n`,
		);

		const prior = SessionManager.create(cwd, path.join(cwd, "prior"));
		prior.appendModelChange(`${modelA.provider}/${modelA.id}`);
		prior.appendMessage({ role: "user", content: "earlier turn", timestamp: Date.now() });
		prior.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: modelA.id,
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

		try {
			expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);

			await fs.writeFile(
				settingsPath,
				`defaultThinkingLevel: high\nmodelRoles:\n  default: ${modelA.provider}/${modelA.id}\n`,
			);
			const result = await session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		}
	});
});

// A startup model is a pin on the MODEL. It says nothing about thinking: with
// no `--thinking` and no `:level` suffix, the level came from the model's own
// `thinking.defaultLevel` or the global `defaultThinkingLevel`. Classifying
// that as an explicit thinking pin wrote an unflagged `thinking_level_change`,
// so `thinkingFollowsSettings()` read `false` for the session's whole life and
// editing `defaultThinkingLevel` could never take effect again.
describe("createAgentSession: a model-only startup does not pin thinking", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("still follows a changed defaultThinkingLevel after a model-only startup", async () => {
		// `--model X` with NO `--thinking`. sonnet-4-5 exposes no
		// `thinking.defaultLevel`, so `low` can only have come from settings.
		const h = await makeHarness({
			explicitStartupModel: true,
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: high\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// The MODEL pin still holds — that half was never wrong.
			expect(result.modelSwapped).toBe(false);
			expect(h.session.model?.id).toBe(h.modelA.id);
			// Pre-fix: `explicitStartupThinking` was true merely because a model was
			// supplied, so startup wrote an unflagged receipt and the settings-derived
			// level read as a user pin the refresh had to preserve.
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await h.dispose();
		}
	});

	it("still pins thinking when the startup supplied BOTH a model and a level", async () => {
		// Guards the narrowing from over-reaching: `--model X --thinking medium`
		// (which is also the shape `main.ts` produces for an explicit `X:medium`
		// selector) is a real thinking selection and must survive a refresh.
		const h = await makeHarness({
			explicitStartupModel: true,
			thinkingLevel: ThinkingLevel.Medium,
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);

			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: high\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);
		} finally {
			await h.dispose();
		}
	});
});

// The RUNTIME counterpart of the startup-only pin above. Selecting a model with
// no thinking suffix says nothing about thinking, but when the picked model's
// own `thinking.defaultLevel` differs from the current level, `setModel`'s
// re-apply MOVES the level — and it did so with `settingsTracking` unset, so
// `setThinkingLevel()` wrote an unflagged receipt and `thinkingFollowsSettings()`
// read a level the user never chose as an explicit thinking pin.
describe("AgentSession setModel: a model-only switch does not pin thinking", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies the newly selected model's own thinking default", async () => {
		// The MOVEMENT half, split out from the provenance case below so the two
		// contracts fail independently: this one is about `preferredDefault`
		// reaching `setThinkingLevel`, not about what the receipt records.
		const target = getBundledModel("cline-pass", "glm-5.2");
		if (!target) throw new Error("Expected bundled cline-pass model glm-5.2");
		const h = await makeHarness({
			extraProviders: ["cline-pass"],
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			// `cline-pass/glm-5.2` carries `thinking.defaultLevel: high`; no
			// bundled anthropic model exposes one, so this pair is what makes a
			// model-only switch actually move the level at all.
			await h.session.setModel(target, "default");

			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
		} finally {
			await h.dispose();
		}
	});

	it("still follows a changed defaultThinkingLevel after a model-only runtime switch", async () => {
		// The PROVENANCE half. Deliberately asserts nothing about which level the
		// switch lands on — only that whatever it applied still tracks settings —
		// so an ablation that breaks the model-default application reds the test
		// above instead of this one.
		const target = getBundledModel("cline-pass", "glm-5.2");
		if (!target) throw new Error("Expected bundled cline-pass model glm-5.2");
		const h = await makeHarness({
			extraProviders: ["cline-pass"],
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			// Two model-only selections, no thinking suffix and no explicit level
			// anywhere. The second lands back on a model with NO
			// `thinking.defaultLevel`, so the refresh's fallback chain below
			// actually reaches `defaultThinkingLevel` rather than stopping at a
			// model default.
			await h.session.setModel(target, "default");
			await h.session.setModel(h.modelA, "default");

			// Now the operator edits the configured default and refreshes.
			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: minimal\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// Pre-fix: the model-derived re-apply wrote an unflagged receipt, so
			// `thinkingFollowsSettings()` read false and thinking stayed pinned
			// for the session's whole life even though the user picked only a
			// model.
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);
		} finally {
			await h.dispose();
		}
	});

	it("keeps an explicit thinking pin across a later model-only switch", async () => {
		// The guard against over-reaching: an explicit selection must stay pinned
		// even though the model switch after it re-applies a model-derived level.
		const target = getBundledModel("cline-pass", "glm-5.2");
		if (!target) throw new Error("Expected bundled cline-pass model glm-5.2");
		const h = await makeHarness({
			extraProviders: ["cline-pass"],
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			// A REAL user thinking selection, which records its pin.
			h.session.setThinkingLevel(ThinkingLevel.Medium, false);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);

			await h.session.setModel(target, "default");

			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: minimal\nmodelRoles:\n  default: cline-pass/glm-5.2\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// The pin survives: the refresh must not re-derive over it.
			expect(h.session.configuredThinkingLevel()).not.toBe(ThinkingLevel.Minimal);
		} finally {
			await h.dispose();
		}
	});
});

describe("AgentSession: thinking provenance survives a role pick and a new session", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("still follows a changed defaultThinkingLevel after /new carried a settings-derived level", async () => {
		// `/new` appends a thinking receipt for the level it carries across. That
		// receipt is the new transcript's ONLY record of where the level came
		// from, so writing it unflagged converts a level the old session merely
		// inherited from `defaultThinkingLevel` into an explicit pin — and the
		// user never selected anything.
		const h = await makeHarness({
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			// No thinking selection anywhere: the level is purely settings-derived.
			expect(await h.session.newSession()).toBe(true);

			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: minimal\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);
		} finally {
			await h.dispose();
		}
	});

	it("pins a role's explicit thinking suffix even when it matches the active level", async () => {
		// `applyRoleModel` only records a pin when the effective effort MOVES, so
		// a role whose suffix equals the level already active recorded nothing —
		// and a later `defaultThinkingLevel` edit plus a refresh overwrote the
		// role's explicit suffix. Starting the session settings-tracking is what
		// makes the omission reachable.
		const h = await makeHarness({
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			// The suffix deliberately equals the level the settings already give.
			await h.session.applyRoleModel({
				role: "default",
				model: h.modelA,
				thinkingLevel: h.session.configuredThinkingLevel(),
				explicitThinkingLevel: true,
			});

			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: minimal\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			// The role's explicit choice is a pin, so the refresh must not
			// re-derive over it.
			expect(h.session.configuredThinkingLevel()).not.toBe(ThinkingLevel.Minimal);
		} finally {
			await h.dispose();
		}
	});

	it("pins a temporary switch's thinking suffix even when it matches the active level", async () => {
		// Same omission on the `/switch provider/model:<level>` path: the suffix
		// reached `setThinkingLevel()` without explicit provenance, so a selection
		// matching the active level wrote no receipt and the earlier
		// settings-tracking one survived — a later `defaultThinkingLevel` edit plus
		// a refresh then overwrote the user's suffix.
		const h = await makeHarness({
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\n`,
		});
		try {
			await h.session.setModelTemporary(h.modelA, h.session.configuredThinkingLevel());

			await fs.writeFile(h.settingsPath, `compaction:\n  enabled: false\ndefaultThinkingLevel: minimal\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).not.toBe(ThinkingLevel.Minimal);
		} finally {
			await h.dispose();
		}
	});

	it("still follows a changed defaultThinkingLevel after an ephemeral switch moved the level", async () => {
		// A prewalk / plan-yolo handoff is automatic, so it must leave the session
		// settings-tracking. Clearing `explicit` was not enough: the handoff level
		// (`high`) DIFFERS from the configured one (`low`), so the receipt is
		// written anyway because the level moved — and with no `settingsTracking`
		// flag `thinkingFollowsSettings()` read that automatic handoff as a user
		// pin, so this refresh was ignored.
		//
		// `claude-sonnet-4-5` carries the full minimal..xhigh ladder and no
		// `thinking.defaultLevel`, so neither level is clamped and the move is real.
		const h = await makeHarness({
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\n`,
		});
		try {
			await h.session.setModelTemporary(h.modelA, ThinkingLevel.High, { ephemeral: true });
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.High);

			await fs.writeFile(h.settingsPath, `compaction:\n  enabled: false\ndefaultThinkingLevel: medium\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);
		} finally {
			await h.dispose();
		}
	});

	it("keeps an explicit pin across a later ephemeral switch", async () => {
		// The other direction: inheriting the pre-handoff answer must leave a real
		// user pin pinned, not launder it into settings-tracking.
		const h = await makeHarness({
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\n`,
		});
		try {
			// The public session setter IS the user-selection surface: it always
			// records an explicit pin, which is what this test needs.
			h.session.setThinkingLevel(ThinkingLevel.XHigh);
			await h.session.setModelTemporary(h.modelA, ThinkingLevel.High, { ephemeral: true });

			await fs.writeFile(h.settingsPath, `compaction:\n  enabled: false\ndefaultThinkingLevel: medium\n`);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).not.toBe(ThinkingLevel.Medium);
		} finally {
			await h.dispose();
		}
	});
});

// A retry fallback swaps the model and the thinking level automatically, with
// no user involvement — but recovery bound its thinking setter to the PUBLIC
// selection wrapper, which always records an explicit pin. Entering or leaving
// a fallback therefore converted a settings-tracking session into a pinned one,
// and a later `defaultThinkingLevel` edit plus `/refresh settings` was ignored.
describe("AgentSession: an automatic fallback thinking swap does not pin thinking", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("still follows a changed defaultThinkingLevel after a recovery thinking swap", async () => {
		const h = await makeHarness({
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			// No user thinking selection: the level is purely settings-derived.
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Low);

			// The swap recovery performs on fallback entry/restoration.
			h.session.setThinkingLevelForRecovery(ThinkingLevel.High);

			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: minimal\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Minimal);
		} finally {
			await h.dispose();
		}
	});

	it("keeps an explicit thinking pin across a later recovery swap", async () => {
		// The guard against over-reaching: inheriting provenance must not
		// *unpin* a level the user really did choose.
		const h = await makeHarness({
			rawConfig: `compaction:\n  enabled: false\ndefaultThinkingLevel: low\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
		});
		try {
			h.session.setThinkingLevel(ThinkingLevel.Medium, false);
			expect(h.session.configuredThinkingLevel()).toBe(ThinkingLevel.Medium);

			h.session.setThinkingLevelForRecovery(ThinkingLevel.High);

			await fs.writeFile(
				h.settingsPath,
				`compaction:\n  enabled: false\ndefaultThinkingLevel: minimal\nmodelRoles:\n  default: anthropic/claude-sonnet-4-5\n`,
			);
			const result = await h.session.refresh("settings");

			expect(result.settingsChanged).toBe(true);
			expect(h.session.configuredThinkingLevel()).not.toBe(ThinkingLevel.Minimal);
		} finally {
			await h.dispose();
		}
	});
});
