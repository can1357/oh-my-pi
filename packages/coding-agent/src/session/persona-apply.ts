/**
 * Shared mechanics for applying a discovered agent persona to the MAIN session:
 * availability gating, model/thinking application, the resume-reconcile apply
 * pipeline, and atomic live-switch snapshot/rollback.
 *
 * Consumers: `main.ts` (thin wrapper, ACP factory), `modes/interactive-mode.ts`
 * (`switchAgentPersona`, resume reconcile), and `slash-commands/builtin-modes.ts`
 * (ACP/text `/agent`). The interactive live-switch owns the `#pendingModelSwitch` class
 * state and threads it through the hooks below; everything else lives here so
 * every path applies (and rolls back) persona state in exactly one order.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type ResolvedModelOverride, resolveModelOverride } from "../config/model-resolver";
import { discoverAgents, getAgent } from "../task/discovery";
import { mainSessionTools, spawnsDisabled, spawnsToString } from "../task/agent-tools";
import type { AgentDefinition } from "../task/types";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { AgentSession } from "./agent-session";
import { type SessionManager } from "./session-manager";

/**
 * Which persona-relevant inputs the user set explicitly on the CLI; a persona's
 * frontmatter yields to them. `--model` sets `modelSet`, `--thinking` (or a
 * `--model` pattern's thinking suffix) sets `thinkingSet`, and
 * `--tools`/`--no-tools` sets `toolsSet`. A settings-seeded default
 * (enabledModels scoped thinking, default role) must NOT count as explicit — it
 * would suppress the persona's frontmatter.
 */
export interface PersonaExplicitOverrides {
	modelSet: boolean;
	thinkingSet: boolean;
	toolsSet: boolean;
}

/** Explicit-override value for live paths with no CLI flags in play: nothing is explicit. */
export const EMPTY_PERSONA_OVERRIDES: PersonaExplicitOverrides = {
	modelSet: false,
	thinkingSet: false,
	toolsSet: false,
};

/**
 * True when `agent` may act as the main-session persona: it resolved, is not
 * subagent-only/unavailable, and is not disabled via `task.disabledAgents`.
 * Discovered agents carry their availability already resolved.
 */
export function isMainSessionPersonaUsable(
	agent: AgentDefinition | undefined | null,
	disabledAgents: readonly string[],
): agent is AgentDefinition {
	return (
		!!agent &&
		agent.availability !== "subagent" &&
		agent.availability !== "unavailable" &&
		!disabledAgents.includes(agent.name)
	);
}

/** Per-site divergences of the persona model/thinking apply; all optional. */
export interface PersonaModelApplyHooks {
	/**
	 * Interactive live-switch only: called INSTEAD of `setModelTemporary` when
	 * the session is mid-turn. Receives the EFFECTIVE level — the suffix-derived
	 * level when the selected pattern carries `:level`, else the frontmatter
	 * `thinkingLevel` (applied by this helper right after) so the deferred
	 * switch lands where the non-streaming path would.
	 */
	queueModelSwitch?: (model: Model, thinkingLevel: ConfiguredThinkingLevel | undefined) => void;
	/**
	 * Text/ACP live-switch only: mid-turn with no queue available — the model
	 * switch is SKIPPED and the caller surfaces the deferral itself.
	 */
	deferModelSwitchWhileStreaming?: () => void | Promise<void>;
	/** The persona's model pattern matched no model; caller owns the user notice. */
	onModelPatternUnresolved?: () => void | Promise<void>;
}

/**
 * Apply a persona's `model:`/`thinkingLevel:` frontmatter to the session.
 *
 * Model resolution is skipped when the CLI set the model explicitly
 * (`explicit.modelSet`) — re-applying would clobber the user's flag. A
 * `:level` suffix on the SELECTED model pattern is the more specific selector
 * and wins over frontmatter `thinkingLevel`: `setModelTemporary` already
 * landed the suffix-derived level, and the frontmatter level below is
 * suppressed when `resolved.explicitThinkingLevel`. A suffix on a NON-selected
 * fallback pattern must NOT suppress it (e.g.
 * `model: [missing/model:low, anthropic/claude-haiku-4-5]` with
 * `thinkingLevel: high` — haiku has no suffix, so `high` applies).
 *
 * The frontmatter level is applied AFTER `setModelTemporary` so a model
 * `defaultLevel` cannot clobber it: `setModelTemporary` with no explicit level
 * re-applies the model's default, which would overwrite the frontmatter level.
 */
export async function applyPersonaModelAndThinking(
	session: AgentSession,
	agent: AgentDefinition,
	explicit: PersonaExplicitOverrides,
	hooks?: PersonaModelApplyHooks,
): Promise<void> {
	let resolved: ResolvedModelOverride | undefined;
	if (!explicit.modelSet && agent.model) {
		resolved = resolveModelOverride(agent.model, session.modelRegistry, session.settings);
		if (resolved.model) {
			const streamingAware = Boolean(hooks?.queueModelSwitch || hooks?.deferModelSwitchWhileStreaming);
			if (streamingAware && session.isStreaming) {
				if (hooks?.queueModelSwitch) {
					const queuedThinkingLevel = resolved.explicitThinkingLevel
						? resolved.thinkingLevel
						: (agent.thinkingLevel ?? resolved.thinkingLevel);
					hooks.queueModelSwitch(resolved.model, queuedThinkingLevel);
				} else {
					await hooks?.deferModelSwitchWhileStreaming?.();
				}
			} else {
				await session.setModelTemporary(resolved.model, resolved.thinkingLevel);
			}
		} else if (hooks?.onModelPatternUnresolved) {
			await hooks.onModelPatternUnresolved();
		}
	}
	if (!explicit.thinkingSet && agent.thinkingLevel && !resolved?.explicitThinkingLevel) {
		session.setThinkingLevel(agent.thinkingLevel);
	}
}

/**
 * Full persona apply for the resume reconcile: capture the pre-persona tool
 * baseline when not already present (resume path: no launch `--agent`, so the
 * SDK never seeded one) so leaving agent mode restores the original tools
 * rather than the persona's restricted list, clear any previous persona's
 * restricted tools, then apply the current definition — tools (unless
 * CLI-explicit), spawns, prompt append, model/thinking — and rebuild the base
 * system prompt. Availability is the CALLER's job
 * (`isMainSessionPersonaUsable`); the gone/disabled branch stays with the
 * caller too (the notice text differs, and only interactive mode can guard on
 * live persona presence). Spawns/prompt deliberately precede model/thinking
 * here, matching the reconciles verbatim; the live switches keep their own
 * order (model first) and compose the smaller helpers instead.
 */
export async function applyPersonaToSession(
	session: AgentSession,
	agent: AgentDefinition,
	explicit: PersonaExplicitOverrides,
	hooks?: PersonaModelApplyHooks,
): Promise<void> {
	// Guarded setters: first-write capture, no-op once a baseline exists.
	session.setBaselineToolNames(session.getEnabledToolNames());
	session.setBaselineMountedToolNames(session.getMountedXdevToolNames());
	// Clear the previous persona's restricted tools before applying the new
	// persona's (no-op when the baseline is the current set).
	await session.restoreBaselineTools();
	if (!explicit.toolsSet && agent.tools) {
		// `applyPersonaTools` registers built-ins the launch registry omitted
		// (a `--tools`/`--no-tools` session holds only the requested set)
		// before activating the persona's list.
		await session.applyPersonaTools(mainSessionTools(agent.tools, agent.spawns));
	}
	if (!explicit.toolsSet && agent.tools === undefined && spawnsDisabled(agent.spawns)) {
		// A `spawns: []`-only persona (no `tools:`) keeps the normal top-level
		// baseline active — which includes `task` — while the disabled spawn
		// policy makes every invocation fail preflight. Re-apply the current
		// set minus `task` for the persona's lifetime (mirrors
		// `mainSessionTools`'s tools-case suppression and the launch `--agent`
		// path). `setActiveToolsByName` (not `applyPersonaTools`) so no persona
		// tool restriction is recorded — the persona grants everything else.
		// Leaving the persona restores the unrestricted baseline via
		// `restoreBaselineTools`, which re-includes `task`.
		const enabledToolNames = session.getEnabledToolNames();
		const withoutTask = enabledToolNames.filter(name => name !== "task");
		if (withoutTask.length < enabledToolNames.length) {
			await session.setActiveToolsByName(withoutTask);
		}
	}
	session.setSessionSpawns(spawnsToString(agent.spawns));
	session.setPersonaAppendPrompt(agent.systemPrompt);
	await applyPersonaModelAndThinking(session, agent, explicit, hooks);
	await session.refreshBaseSystemPrompt();
}

/**
 * Pre-switch session state captured by `snapshotPersonaSwitch` and restored by
 * `rollbackPersonaSwitch`.
 */
export interface PersonaSwitchSnapshot {
	/** Active top-level tools before the switch. */
	tools: string[];
	/** `xd://`-mounted subset before the switch (restored exactly — see rollback). */
	mountedToolNames: string[];
	personaDroppedMutation: boolean | undefined;
	personaDroppedEdit: boolean | undefined;
	personaToolRestriction: Set<string> | undefined;
	baselineToolNames: string[] | undefined;
	baselineMountedToolNames: string[] | undefined;
	model: Model | undefined;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
	spawns: string | null;
	personaAppendPrompt: string | undefined;
}

/**
 * Capture every piece of state a failed live persona switch must restore, then
 * seed the first-write baseline for this attempt (guarded setters leave a
 * pre-existing baseline untouched). Why each field is snapshotted:
 *
 * - `mountedToolNames`: restoring via `setActiveToolsByName` would classify the
 *   pre-switch set against the persona-apply's CHANGED mount set, pinning
 *   previously-mounted tools top-level (codex #3818954045); the rollback
 *   restores the exact top-level versus `xd://` partition instead.
 * - `personaDroppedMutation`/`personaDroppedEdit`: a failed switch must restore
 *   the exact pre-switch SDK signals — the rollback passes them through
 *   `setActiveToolPresentation`, otherwise the mutation flag stays `true` and
 *   the Cursor `editWasGranted` floor stays revoked on the rolled-back session.
 * - `personaToolRestriction`: `applyPersonaTools` sets it to the failed
 *   persona's list; without restoration that stale restriction blocks MCP
 *   refresh / suppresses prompt affordances (codex #3819553918 / #3763426057).
 * - `baselineToolNames`/`baselineMountedToolNames`: a failed FIRST switch must
 *   not leave the first-write-only baseline populated (the setter no-ops on the
 *   next attempt, so leaving agent mode would restore the failed attempt's
 *   stale tools instead of the real pre-persona set). The rollback clears the
 *   pair only when BOTH were unset before the attempt — a pre-existing
 *   asymmetric baseline (launch `--agent` with a `tools:` persona seeds only
 *   `baselineToolNames`; xdev is disabled under the restriction so the mounted
 *   snapshot is skipped) still describes real pre-persona state and is left
 *   untouched, hence no `||`.
 */
export function snapshotPersonaSwitch(session: AgentSession): PersonaSwitchSnapshot {
	const tools = session.getEnabledToolNames();
	const mountedToolNames = session.getMountedXdevToolNames();
	const snapshot: PersonaSwitchSnapshot = {
		tools,
		mountedToolNames,
		personaDroppedMutation: session.getLastPersonaDroppedMutation(),
		personaDroppedEdit: session.getLastPersonaDroppedEdit(),
		personaToolRestriction: session.getPersonaToolRestriction(),
		baselineToolNames: session.getBaselineToolNames(),
		baselineMountedToolNames: session.getBaselineMountedToolNames(),
		model: session.model,
		thinkingLevel: session.configuredThinkingLevel(),
		spawns: session.getSessionSpawns(),
		personaAppendPrompt: session.getPersonaAppendPrompt(),
	};
	// First persona application captures the pre-persona tool set so leaving
	// agent mode restores the original tools (not the previous persona's).
	session.setBaselineToolNames(tools);
	session.setBaselineMountedToolNames(session.getMountedXdevToolNames());
	return snapshot;
}

/**
 * Restore exactly what `snapshotPersonaSwitch` captured after a failed live
 * persona switch: the `xd://` tool partition (with the persona-drop signals),
 * the persona restriction, model/thinking, spawns, prompt append, this
 * attempt's first-write baseline (cleared only when both fields were unset
 * before the attempt), and finally the base system prompt. When the session is
 * mid-turn and `hooks.queueModelSwitch` is supplied, the previous model is
 * queued through it instead of applied directly (the interactive
 * `#pendingModelSwitch` flush on agent_end); without the hook the model
 * restore is skipped mid-turn (text/ACP has no queue).
 */
export async function rollbackPersonaSwitch(
	session: AgentSession,
	snapshot: PersonaSwitchSnapshot,
	hooks?: { queueModelSwitch?: (model: Model, thinkingLevel: ConfiguredThinkingLevel | undefined) => void },
): Promise<void> {
	await session.setActiveToolPresentation(
		snapshot.tools,
		snapshot.mountedToolNames,
		undefined,
		undefined,
		snapshot.personaDroppedMutation,
		snapshot.personaDroppedEdit,
	);
	session.setPersonaToolRestriction(snapshot.personaToolRestriction);
	if (snapshot.model) {
		if (session.isStreaming) {
			hooks?.queueModelSwitch?.(snapshot.model, snapshot.thinkingLevel);
		} else {
			await session.setModelTemporary(snapshot.model, snapshot.thinkingLevel);
		}
	}
	session.setThinkingLevel(snapshot.thinkingLevel);
	session.setSessionSpawns(snapshot.spawns);
	session.setPersonaAppendPrompt(snapshot.personaAppendPrompt);
	if (snapshot.baselineToolNames === undefined && snapshot.baselineMountedToolNames === undefined) {
		session.clearBaselineTools();
	}
	await session.refreshBaseSystemPrompt();
}

/**
 * Reconcile a persisted persona (`mode_change: agent`) into a session at
 * startup. Shared by the RPC and print branches (`main.ts`) and the TUI resume
 * path (`InteractiveMode.#reconcileModeFromSession`). The agent is
 * re-discovered fresh against the session manager's cwd and its CURRENT
 * definition is applied (tools, spawns, prompt; model/thinking only when the
 * CLI did not explicitly set them). When the agent is missing, subagent-only,
 * or disabled the persona-owned state (spawns, prompt, baseline) is cleared so
 * it does not leak into the resumed transcript, exactly like the interactive
 * else-branch. The `mode_change` entry is already persisted; nothing is
 * appended here.
 */
export async function reconcilePersistedPersona(
	session: AgentSession,
	sessionManager: SessionManager,
	explicit: PersonaExplicitOverrides,
): Promise<void> {
	const context = sessionManager.buildSessionContext();
	if (context.mode !== "agent") return;
	const name = context.modeData?.name as string | undefined;
	if (!name) return;
	let agent: AgentDefinition | undefined;
	try {
		const { agents } = await discoverAgents(sessionManager.getCwd());
		agent = getAgent(agents, name);
	} catch (error) {
		// Discovery failure must not leave the target transcript under the
		// source session's persona state: switchSession catches reconciler
		// errors and still commits the target, so clear the persona-owned
		// state for a coherent non-persona baseline (codex #3821198710).
		logger.warn("Failed to discover agents during persona restore", { error: String(error) });
		await session.clearPersonaOwnedState();
		// Discovery failure is not proof the agent is gone: stop here instead
		// of falling through to the gone/disabled branch, which would emit a
		// spurious "no longer available" warning (TUI reconcile semantics).
		return;
	}
	const disabledAgents = (session.settings.get("task.disabledAgents") as string[] | undefined) ?? [];
	if (isMainSessionPersonaUsable(agent, disabledAgents)) {
		// Snapshot/rollback mirrors the live-switch path, with one
		// reconcile-specific difference: switchSession catches reconciler
		// errors and still commits the target, so restoring the SOURCE
		// persona's snapshot wholesale would leave the committed target
		// running the source persona's tools, spawns, and prompt. Restore
		// the snapshot's model/thinking (the target transcript's restored
		// values) and then clear the persona-owned state to a coherent
		// non-persona baseline instead (codex #3821198710).
		const snapshot = snapshotPersonaSwitch(session);
		try {
			await applyPersonaToSession(session, agent, explicit);
		} catch (error) {
			try {
				await rollbackPersonaSwitch(session, snapshot);
				// Finish with clearPersonaOwnedState: it restores the baseline
				// tools, clears the spawns/prompt fields, and — unlike the bare
				// clears it replaces — refreshes the base system prompt after the
				// clears, so the committed target cannot keep the persona's
				// system prompt (codex #3845551582 / P2 prompt-after-clear).
				await session.clearPersonaOwnedState();
			} catch (rollbackError) {
				logger.warn("Failed to clear persona state after reconcile failure", {
					error: String(rollbackError),
				});
			}
			throw error;
		}
	} else {
		// The persisted persona is gone/disabled: clear the previous session's
		// persona-owned state so it does not leak into this transcript.
		// clearPersonaOwnedState keeps the restore-before-clear ordering: if
		// the restoration fails, the persona state stays intact instead of
		// leaving a half-cleared persona (the next reconcile can retry).
		await session.clearPersonaOwnedState();
		session.emitNotice("warning", `Agent "${name}" is no longer available. Restored model and thinking level.`);
	}
}
