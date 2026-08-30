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
}): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-refresh-model-swap-");
	const cwd = tempDir.path();
	const modelA = bundledAnthropic("claude-sonnet-4-5");
	const modelB = bundledAnthropic("claude-sonnet-4-6");

	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
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
});
