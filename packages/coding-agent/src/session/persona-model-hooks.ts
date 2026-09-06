import type { Model } from "@oh-my-pi/pi-ai";

import type { AgentSession } from "./agent-session";
import type { DiscoveredAgent, PersonaExplicitOverrides } from "./tool-policy";

export type { PersonaExplicitOverrides };

import { resolveModelOverride } from "../config/model-resolver";
import type { ConfiguredThinkingLevel } from "../thinking";
import { parseConfiguredThinkingLevel } from "../thinking";

/**
 * Model/thinking apply seam between the persona runtime and the session's
 * model machinery (PR 9510 re-architecture): the runtime calls these hooks
 * instead of touching `AgentSession` model APIs directly, so each host surface
 * (TUI queues, ACP notices) can override the mid-turn channels.
 *
 * Baseline OWNERSHIP note: the runtime captures the pre-apply model/thinking
 * itself and restores it on exit/rollback — a hooks instance's internal
 * baseline does NOT survive exit (callers build fresh hooks objects), so there
 * is no per-instance restore channel.
 */
export interface PersonaModelApplyHooks {
	/**
	 * Apply the agent's model + thinking preference to the session. The runtime
	 * owns the lifecycle baseline.
	 */
	apply(agent: DiscoveredAgent, explicit?: PersonaExplicitOverrides): Promise<void>;

	/**
	 * Defer a mid-turn persona model switch (ACP semantics: notice + skip,
	 * tools/prompt still apply immediately). Absent on the default hooks.
	 */
	deferModelSwitchWhileStreaming?(agent: DiscoveredAgent): void;

	/**
	 * Defer a mid-turn persona model RESTORE (exit path): the persona teardown
	 * (policy/prompt/spawns/presentation) applies immediately, but reverting the
	 * session model/thinking to the pre-persona baseline must not mutate a live
	 * turn. The RUNTIME passes its own captured baseline (the hook instance that
	 * ran `apply` does not survive to exit); surfaces queue the baseline flush
	 * (TUI: `#pendingModelSwitch` on agent_end) or notice (ACP). Absent on the
	 * default hooks — without it a deferred mid-turn exit skips the model
	 * restore rather than mutating the streaming session.
	 */
	deferModelRestoreWhileStreaming?(baseline: ModelBaseline): void;
	/**
	 * The runtime rolled a persona switch/exits back after the surface's
	 * defer channels ran (queue mutation, notice). Surfaces that queued a
	 * pending model mutation on behalf of the failed transaction clear it
	 * here — otherwise the turn-end flush would apply a model switch
	 * belonging to a switch that no longer exists. Absent on the default
	 * hooks (no queue to clear).
	 */
	onPersonaSwitchFailed?(): void;
	/**
	 * Whether a persona model switch should be deferred right now (e.g. the
	 * session is streaming). Absent on the default hooks.
	 */
	shouldDeferModelSwitch?(): boolean;
}

/** Effective model + thinking level captured before a persona apply. */
export interface ModelBaseline {
	model: Model | undefined;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
}

/**
 * Default hooks bound to one session. Baseline capture reads `session.model`
 * and `session.configuredThinkingLevel()` immediately before any mutation; the
 * runtime owns the restore (it never calls back into this instance).
 */
export function createDefaultPersonaModelHooks(session: AgentSession): PersonaModelApplyHooks {
	return {
		async apply(agent: DiscoveredAgent, explicit?: PersonaExplicitOverrides): Promise<void> {
			// j2v: the resolved pattern can carry a THINKING level too (an
			// explicit `:level` suffix on the pattern, or a configured role whose
			// value ends in `:level`). Capture it and adopt it below when the
			// persona's own frontmatter declared none.
			const resolvedThinking: Array<ConfiguredThinkingLevel | undefined> = [];
			const explicitModelPattern = explicit?.model?.trim();
			if (explicitModelPattern) {
				const resolved = resolveModelOverride([explicitModelPattern], session.modelRegistry, session.settings);
				if (resolved.model) {
					await session.setModel(resolved.model);
					resolvedThinking.push(resolved.thinkingLevel);
				}
			} else if (agent.model && agent.model.length > 0) {
				const resolved = resolveModelOverride(agent.model, session.modelRegistry, session.settings);
				if (resolved.model) {
					await session.setModel(resolved.model);
					resolvedThinking.push(resolved.thinkingLevel);
				}
			}

			const explicitThinking =
				explicit?.thinking !== undefined ? parseConfiguredThinkingLevel(explicit.thinking) : undefined;
			// fw2QC: a thinking suffix on the EXPLICIT model selector
			// (`--model provider/model:high`) is itself an explicit CLI
			// override — it outranks the persona's frontmatter thinking, same
			// as `--thinking` does.
			const explicitModelThinking = explicitModelPattern ? resolvedThinking[0] : undefined;
			const thinking: ConfiguredThinkingLevel | undefined =
				explicitThinking ??
				explicitModelThinking ??
				(agent.thinkingLevel !== undefined
					? agent.thinkingLevel
					: explicitModelPattern
						? undefined // explicit path already considered above
						: resolvedThinking[0]);
			if (thinking !== undefined) {
				session.setThinkingLevel(thinking);
			}
		},
	};
}
