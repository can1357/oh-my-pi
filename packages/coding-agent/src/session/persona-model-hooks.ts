import type { Model } from "@oh-my-pi/pi-ai";

import type { AgentSession } from "./agent-session";
import type { DiscoveredAgent, PersonaExplicitOverrides } from "./tool-policy";

export type { PersonaExplicitOverrides };

import { resolveModelOverride } from "../config/model-resolver";
import type { ConfiguredThinkingLevel } from "../thinking";
import { parseConfiguredThinkingLevel } from "../thinking";

/**
 * Model/thinking apply + restore seam between the persona runtime and the
 * session's model machinery. Stage 1 of the PR 9510 re-architecture
 * (docs/plans/2026-09-05-persona-runtime-rearchitect.md §2): the runtime calls
 * these hooks instead of touching `AgentSession` model APIs directly, so each
 * host surface (TUI queues, ACP notices) can override the mid-turn channels.
 */
export interface PersonaModelApplyHooks {
	/**
	 * Apply the agent's model + thinking preference to the session.
	 * Implementations capture the pre-apply baseline (model + thinking) so a
	 * later {@link restore} can revert exactly what was applied.
	 */
	apply(agent: DiscoveredAgent, explicit?: PersonaExplicitOverrides): Promise<void>;

	/**
	 * Revert to the baseline captured by the last {@link apply}. A no-op when
	 * nothing has been applied yet.
	 */
	restore(): Promise<void>;

	/**
	 * Queue a mid-turn model switch for later flush (TUI semantics: flushed on
	 * agent_end). Absent on the default hooks; per-surface hosts override.
	 */
	queueModelSwitch?(modelPattern: string): void;

	/**
	 * Defer a mid-turn persona model switch (ACP semantics: notice + skip,
	 * tools/prompt still apply immediately). Absent on the default hooks.
	 */
	deferModelSwitchWhileStreaming?(agent: DiscoveredAgent): void;

	/**
	 * Defer a mid-turn persona model RESTORE (exit path): the persona teardown
	 * (policy/prompt/spawns/presentation) applies immediately, but reverting the
	 * session model/thinking to the pre-persona baseline must not mutate a live
	 * turn. Surfaces queue the baseline flush (TUI: `#pendingModelSwitch` on
	 * agent_end) or notice (ACP). Absent on the default hooks — without it a
	 * deferred mid-turn exit skips the model restore rather than mutating the
	 * streaming session.
	 */
	deferModelRestoreWhileStreaming?(): void;

	/**
	 * The pre-apply baseline captured by the last {@link apply} (model +
	 * thinking), for surfaces that need it outside the restore path (e.g. the
	 * TUI queues it through its own pending-model-switch channel). Undefined
	 * before the first apply.
	 */
	snapshotBaseline?(): ModelBaseline | undefined;

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
 * and `session.configuredThinkingLevel()` immediately before any mutation, so
 * `restore` always lands the session exactly where the persona found it.
 */
export function createDefaultPersonaModelHooks(session: AgentSession): PersonaModelApplyHooks {
	let baseline: ModelBaseline | undefined;

	return {
		async apply(agent: DiscoveredAgent, explicit?: PersonaExplicitOverrides): Promise<void> {
			baseline = {
				model: session.model,
				thinkingLevel: session.configuredThinkingLevel(),
			};

			const explicitModelPattern = explicit?.model?.trim();
			if (explicitModelPattern) {
				const resolved = resolveModelOverride([explicitModelPattern], session.modelRegistry, session.settings);
				if (resolved.model) {
					await session.setModel(resolved.model);
				}
			} else if (agent.model && agent.model.length > 0) {
				const resolved = resolveModelOverride(agent.model, session.modelRegistry, session.settings);
				if (resolved.model) {
					await session.setModel(resolved.model);
				}
			}

			const explicitThinking =
				explicit?.thinking !== undefined ? parseConfiguredThinkingLevel(explicit.thinking) : undefined;
			const thinking: ConfiguredThinkingLevel | undefined =
				explicitThinking ?? (agent.thinkingLevel !== undefined ? agent.thinkingLevel : undefined);
			if (thinking !== undefined) {
				session.setThinkingLevel(thinking);
			}
		},

		async restore(): Promise<void> {
			if (!baseline) return;
			const { model, thinkingLevel } = baseline;
			baseline = undefined;
			if (model && session.model && session.model !== model) {
				await session.setModel(model);
			} else if (model && !session.model) {
				await session.setModel(model);
			}
			if (session.configuredThinkingLevel() !== thinkingLevel) {
				session.setThinkingLevel(thinkingLevel);
			}
		},
		snapshotBaseline(): ModelBaseline | undefined {
			return baseline;
		},
	};
}

/**
 * Standalone apply helper matching plan §2's enter sequence: the runtime calls
 * this (not `hooks.apply` directly) so the deferral channels compose with the
 * apply path in one place. Hooks are session-bound at
 * {@link createDefaultPersonaModelHooks} construction time.
 */
export async function applyPersonaModelAndThinking(
	agent: DiscoveredAgent,
	explicit: PersonaExplicitOverrides,
	hooks: PersonaModelApplyHooks,
	deferModel: boolean,
): Promise<void> {
	if (deferModel) {
		hooks.deferModelSwitchWhileStreaming?.(agent);
		return;
	}
	await hooks.apply(agent, explicit);
}
