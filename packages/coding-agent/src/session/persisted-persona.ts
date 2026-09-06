import { logger } from "@oh-my-pi/pi-utils";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "../thinking";
import { parseConfiguredThinkingLevel } from "../thinking";
import type { AgentSession } from "./agent-session";
import type { PersonaModelApplyHooks } from "./persona-model-hooks";
import type { ModelOverrideState, PersonaRuntime } from "./persona-runtime";
import { discoverAgents, getAgent } from "../task/discovery";

import type { PersonaExplicitOverrides } from "./tool-policy";

/**
 * The persisted `mode_change` payload for an agent-persona session.
 * Kept as `Record<string, unknown>` on the journal entry (ModeChangeEntry.data
 * is untyped); these keys are the persona contract: `name` (required),
 * `explicit` (optional per-invocation overrides carried through resume), and
 * `baseline` (optional pre-persona model/thinking captured at enter time —
 * on resume it is the authoritative exit baseline, so exiting after a resume
 * restores the pre-persona model instead of the persona-produced one, which
 * the model_change journal entries make indistinguishable from a deliberate
 * user pick).
 */
export interface AgentPersonaBaseline {
	/** Model string at enter time ("provider/modelId"); `undefined` = no model. */
	model?: string;
	/** Configured thinking level at enter time; `undefined` = none configured. */
	thinkingLevel?: string;
}

export interface AgentPersonaModeData {
	name: string;
	explicit?: PersonaExplicitOverrides;
	baseline?: AgentPersonaBaseline;
}

/**
 * Serializes the runtime's captured pre-persona baseline for the journal
 * (j2g). The runtime stays pure — callers append the entry — so this helper
 * shapes the `baseline` key the resume reconcile reads back. Returns
 * `undefined` when nothing was captured (e.g. a deferred enter that never
 * applied a model), which the writer omits.
 */
export function serializePersonaBaseline(baseline: {
	model: unknown;
	thinkingLevel: unknown;
}): AgentPersonaBaseline | undefined {
	const model = baseline.model as { provider: string; id: string } | undefined;
	const out: AgentPersonaBaseline = {};
	if (model) out.model = `${model.provider}/${model.id}`;
	if (baseline.thinkingLevel !== undefined) out.thinkingLevel = String(baseline.thinkingLevel);
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolves a journal-persisted baseline against the session's model registry:
 * the "provider/modelId" string becomes the live `Model` object, the persisted
 * thinking string parses to a `ConfiguredThinkingLevel`. A model the registry
 * can no longer resolve drops to `undefined` (the persona model may have been
 * removed from the catalog between sessions; the thinking half still restores).
 */
export function deserializePersonaBaseline(session: AgentSession, baseline: AgentPersonaBaseline): ModelOverrideState {
	return {
		model: baseline.model
			? (session.modelRegistry
					.getAvailable()
					.find(candidate => `${candidate.provider}/${candidate.id}` === baseline.model) as Model | undefined)
			: undefined,
		thinkingLevel: baseline.thinkingLevel
			? (parseConfiguredThinkingLevel(baseline.thinkingLevel) as ConfiguredThinkingLevel | undefined)
			: undefined,
	};
}

/**
 * Mode entries that do not touch the persona. Plan/goal/vibe partition tools
 * temporarily while the persona stays active underneath, so their journal
 * entries (and their paused variants) are skipped when locating the persona
 * identity; only an explicit persona exit (`none`) or an unrecognized mode
 * clears it.
 */
const PERSONA_TRANSPARENT_MODES = new Set(["plan", "plan_paused", "goal", "goal_paused", "vibe"]);

/**
 * Extracts the desired persona from a session journal's LAST agent mode_change
 * entry that is not followed by an explicit persona exit (`none`) — plan/goal/
 * vibe entries in between are transparent (the persona stays active under the
 * mode's temporary partition). Session files are user-editable and survive
 * across versions, so anything that does not match the contract is treated as
 * absent rather than trusted.
 */
export function readPersistedAgentPersona(
	entries: ReadonlyArray<{ type: unknown; mode?: unknown; data?: unknown }>,
): AgentPersonaModeData | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "mode_change") continue;
		if (entry.mode === "agent") {
			const data: Record<string, unknown> =
				typeof entry.data === "object" && entry.data !== null ? (entry.data as Record<string, unknown>) : {};
			const name = data.name;
			if (typeof name !== "string" || name.length === 0) return undefined;
			const explicitRaw: unknown = data.explicit;
			let explicit: PersonaExplicitOverrides | undefined;
			if (typeof explicitRaw === "object" && explicitRaw !== null) {
				const explicitSource = explicitRaw as Record<string, unknown>;
				const model = explicitSource.model;
				const thinking = explicitSource.thinking;
				const toolsRaw = explicitSource.tools;
				const candidate: PersonaExplicitOverrides = {
					model: typeof model === "string" ? model : undefined,
					thinking: typeof thinking === "string" ? thinking : undefined,
					tools:
						Array.isArray(toolsRaw) && toolsRaw.every((tool): tool is string => typeof tool === "string")
							? toolsRaw
							: undefined,
				};
				if (Object.keys(candidate).some(key => candidate[key as keyof PersonaExplicitOverrides] !== undefined)) {
					explicit = candidate;
				}
			}
			const baselineRaw: unknown = data.baseline;
			let baseline: AgentPersonaBaseline | undefined;
			if (typeof baselineRaw === "object" && baselineRaw !== null) {
				const baselineSource = baselineRaw as Record<string, unknown>;
				const model = baselineSource.model;
				const thinkingLevel = baselineSource.thinkingLevel;
				const candidate: AgentPersonaBaseline = {
					model: typeof model === "string" ? model : undefined,
					thinkingLevel: typeof thinkingLevel === "string" ? thinkingLevel : undefined,
				};
				if (candidate.model !== undefined || candidate.thinkingLevel !== undefined) baseline = candidate;
			}
			if (explicit || baseline)
				return { name, ...(explicit ? { explicit } : {}), ...(baseline ? { baseline } : {}) };
			return { name };
		}
		if (PERSONA_TRANSPARENT_MODES.has(entry.mode as string)) continue;
		return undefined;
	}
	return undefined;
}

/**
 * Callbacks the reconcile helper delegates surface differences to. The
 * gone-persona channel fires before the journal clear marker; the failure
 * channel fires when reconcile itself throws (the session resumes without
 * the persona).
 */
export interface ReconcileSessionPersonaHooks {
	/** Persona model hooks passed to `runtime.reconcile` (TUI/ACP override the mid-turn channels). */
	buildHooks: (session: AgentSession) => PersonaModelApplyHooks;
	/** Surface a gone-persona degrade (TUI status line, ACP client notice). */
	onGone?: (session: AgentSession, name: string) => void | Promise<void>;
	/** Surface a reconcile failure; the default logs a warn with this context. */
	onError?: (session: AgentSession, name: string, error: unknown) => void | Promise<void>;
}

/**
 * j2g/j2n: session-level persona reconcile shared by the TUI resume, the
 * headless switch (ACP/RPC/SDK) and the ACP load/fork paths. Reads the
 * journal's LAST agent `mode_change` entry, re-resolves the agent against the
 * session's effective discovery roots, and drives `PersonaRuntime.reconcile`
 * with the journal's baseline as the authoritative pre-persona state.
 *
 * Journal rules: NO write on success (the entry already exists); a persona the
 * journal names but discovery no longer resolves degrades to unrestricted —
 * append a `mode_change none` clear marker (so every future resume does not
 * re-notice the degrade), warn, and route the surface notice through
 * `hooks.onGone`. An internal failure logs and resumes without the persona.
 */
export async function reconcileSessionPersona(
	session: AgentSession,
	hooks: ReconcileSessionPersonaHooks,
): Promise<{ entered: boolean }> {
	const runtime = (
		session as AgentSession & Partial<Record<"getPersonaRuntime", () => PersonaRuntime | undefined>>
	).getPersonaRuntime?.();
	const desired = readPersistedAgentPersona(session.sessionManager.getEntries());
	if (!runtime) {
		return { entered: false };
	}
	if (!desired) {
		// Branching (RPC/ACP/SDK #reconcileModeAfterBranch) can land on an
		// entry from BEFORE the persona's `mode_change agent` marker while the
		// live session still runs the persona — the live branch must match its
		// persisted mode state, so reconcile the runtime to NO persona.
		if (runtime.policy.isPersonaActive()) {
			await runtime.reconcile(undefined, hooks.buildHooks(session));
		}
		return { entered: false };
	}
	try {
		const { agents } = await discoverAgents(
			session.sessionManager.getCwd(),
			undefined,
			session.effectiveExtensionRoots,
		);
		const agent = getAgent(agents, desired.name);
		if (!agent) {
			// Surface the degrade BEFORE the journal clear marker (the ACP path
			// emitted its notice first; ordering is unobservable to the journal).
			await hooks.onGone?.(session, desired.name);
			// fwULz/fwkeP: the live persona must not survive a journal that no
			// longer records it. Teardown FIRST — a failure rolls back to the
			// active persona, in which case the journal must KEEP the persona
			// entry (the live session still runs it; the next resume restores
			// it). The clear marker lands only after teardown succeeds.
			if (runtime.policy.isPersonaActive()) {
				await runtime.reconcile(undefined, hooks.buildHooks(session));
			}
			session.sessionManager.appendModeChange("none");
			logger.warn(`Session persona "${desired.name}" is no longer available; resuming without it`, {
				sessionId: session.sessionId,
			});
			return { entered: false };
		}
		// j2g: the journal's baseline (captured at the ORIGINAL enter) is the
		// authoritative pre-persona state on resume — the live model/thinking
		// are persona-produced, so re-capturing them would make a later exit
		// restore the persona model.
		const baselineOverride = desired.baseline ? deserializePersonaBaseline(session, desired.baseline) : undefined;
		// fvInv double-enter guard: the CLI `--agent X --resume` launch seam
		// (sdk.ts) already entered the same persona during construction with the
		// same explicit overrides and the journal's baseline — a second
		// reconcile would exit (restoring the pre-persona state) and re-enter,
		// pointlessly replaying the switch and re-noticing nothing. Skip when
		// the live persona already IS the desired one — name AND explicit
		// overrides (fwULy: branching to an earlier same-name entry with
		// different persisted overrides must re-apply them, not skip).
		const active = runtime.policy.snapshot().persona;
		if (
			active &&
			active.agent.name === desired.name &&
			JSON.stringify(active.explicit) === JSON.stringify(desired.explicit ?? {})
		) {
			// fwdEX: identical name/overrides but a DIFFERENT persisted
			// pre-persona baseline (branching between two activations of the
			// same persona) must still adopt the target branch's baseline —
			// the later activation's `activeBaseline` would otherwise restore
			// the wrong model on exit.
			if (baselineOverride) {
				runtime.adoptBaselineOverride(baselineOverride);
			}
			return { entered: true };
		}
		await runtime.reconcile({ agent, explicit: desired.explicit, baselineOverride }, hooks.buildHooks(session));
		return { entered: true };
	} catch (error) {
		if (hooks.onError) {
			await hooks.onError(session, desired.name, error);
		} else {
			logger.warn("Failed to reconcile persisted persona", {
				sessionId: session.sessionId,
				persona: desired.name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return { entered: false };
	}
}

/**
 * Caller-owned persona journal persistence (the runtime stays pure; the
 * resume reconcile reads the entry back). Serializes the runtime's captured
 * pre-persona baseline once here, omitting the key when nothing was captured.
 */
export function appendPersonaJournalEntry(
	session: AgentSession,
	entry: { name: string; explicit?: PersonaExplicitOverrides; baseline?: unknown },
): void {
	const baseline =
		entry.baseline === undefined
			? undefined
			: serializePersonaBaseline(entry.baseline as { model: unknown; thinkingLevel: unknown });
	session.sessionManager.appendModeChange("agent", {
		name: entry.name,
		...(entry.explicit && Object.keys(entry.explicit).length > 0 ? { explicit: entry.explicit } : {}),
		...(baseline ? { baseline } : {}),
	});
}

/** Appends the persona clear marker (`mode_change none`) for an explicit persona exit. */
export function clearPersonaJournalEntry(session: AgentSession): void {
	session.sessionManager.appendModeChange("none");
}
