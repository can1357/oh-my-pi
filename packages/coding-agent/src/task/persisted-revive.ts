import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { MAIN_AGENT_RULE_NAME, SUB_AGENT_RULE_NAME } from "../capability/rule";
import { cfgOffline } from "../config/auxiliary-model-policy";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelStringWithRouting,
	getModelMatchPreferences,
	resolveAgentAdvisorRolePattern,
} from "../config/model-resolver";
import { formatModelRoleAlias } from "../config/model-roles";
import type { KeptOverlayLayers, Settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import unavailableCustomToolsPrompt from "../prompts/system/unavailable-custom-tools.md" with { type: "text" };
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import type { AuthStorage } from "../session/auth-storage";
import { installRetryFallbackRole } from "../session/retry-fallback-chains";
import { extractSessionInit, type PersistedSessionInit, SessionManager } from "../session/session-manager";
import { revivePersistedPlaced } from "../thread/executor-routing";
import { subagentWorkerPool } from "../thread/subagent-worker";
import type { EventBus } from "../utils/event-bus";
import { isCompletionProbeEnabled } from "./completion-probe";
import { discoverAgents, getAgent } from "./discovery";
import {
	captureSubagentSettings,
	compactionThresholdSettings,
	createSubagentSettings,
	type ExplicitBuildModel,
	type LegacyBuildModel,
	liveEffortCeiling,
	perCallModelAssertion,
	RevivedModels,
	reopenParkedSubagent,
	reviveSubagentSession,
	SUBAGENT_OVERLAY_SETTINGS,
	type SubagentCreateInput,
	type SubagentLiveInputs,
	type SubagentOverlayOverrides,
	softRequestBudgetFor,
	subagentDispatchAssertion,
	subagentLspWritethroughSettings,
	subagentRetryFallbackRole,
	switchedOrHeldModel,
	usesYield,
} from "./executor";
import {
	assertPerCallModelApproved,
	PerCallModelError,
	type PerCallModelGrants,
	PerCallModelUnavailableError,
	parentModelGrantPattern,
} from "./model-approval";
import { chooseColdReviveModel, choosePerCallModel } from "./revive-model";
import {
	type ColdReviveLiveInputs,
	coldReviveCustomTools,
	coldReviveLiveInputs,
	liveParent,
	liveParentSession,
	type ParentPolicy,
	parentPolicy,
} from "./revive-parent-inputs";
import { cfgTaskMaxEffort, cfgTaskMaxRuntimeMs } from "./settings";
import {
	jsonValue,
	mayReviveUseParentModel,
	readSpawnSpec,
	SPAWN_SPEC_VERSION,
	type SpawnSpecParts,
	type SpawnSpecSettings,
	type SubagentSpawnSpec,
	spawnSpecSettings,
} from "./spawn-spec";
import type { AgentDefinition } from "./types";

/** Custom type of the message that names a revived subagent's unavailable custom tools to its model. */
const UNAVAILABLE_CUSTOM_TOOLS_NOTICE = "unavailable-custom-tools";
/** Custom type of the message that says a revived subagent runs above its effort ceiling, the parent's model at its lowest. */
const EFFORT_CEILING_NOTICE = "effort-ceiling-not-honoured";

/**
 * Ambient context the reviver needs at revive time. The top-level session is kept LIVE and read at each
 * revive rather than snapshotted, so a later `/new` or cwd move is followed. A revived subagent builds in the
 * live root session's cwd, as the cold revive did before spawn specs; a stored cwd is not used. A revive
 * takes the artifact manager of its live parent session (the root's where the parent is not live) where its
 * spawn passed one (a spec names the live inputs its spawn passed; a record with no spawn spec always takes
 * it) and where that manager can reach the main thread. Auth/models/settings are process-stable and captured
 * by reference.
 */
export interface PersistedSubagentReviveContext {
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	/** LSP policy of the top-level session; revived subagents inherit it rather than defaulting on. */
	enableLsp: boolean;
	/**
	 * Shared event bus feeding RPC/collab subagent subscriptions. Passed through
	 * to the wake-turn monitor so an IRC send to a cold-revived subagent emits
	 * the same lifecycle/progress frames a live run does.
	 */
	eventBus?: EventBus;
	/** Root-scoped observability bus the revived run's frames also publish to. */
	subagentEventBus?: EventBus;
}

/** The model a cold revive builds on: never the patterns of a spawn's deferred model resolution. */
type ColdReviveBuildModel = ExplicitBuildModel | LegacyBuildModel;

/** A per-call worker's grants besides the live settings and the live parent's model, which each request reads. */
export type PerCallGrantInputs = Omit<PerCallModelGrants, "settings" | "parentModelPattern">;

/** What the main thread prepares for one cold revive before anything is reopened ({@link prepareColdRevive}). */
export interface PreparedColdRevive {
	/** The live parent session's inputs, or the root's when the parent is unavailable. */
	readonly live: ColdReviveLiveInputs;
	/** The model a spawn spec's model or a per-call worker starts on; absent, the record's patterns decide. */
	readonly model: ExplicitBuildModel | undefined;
	/**
	 * The model the spec's prewalk target names, where the registry knows it and its provider has a credential;
	 * else the prewalk is not armed.
	 */
	readonly prewalkTarget: Model | undefined;
	/** The registry's discovery ran while this step resolved a model; the build does not run it again. */
	readonly discoveryRan: boolean;
	/**
	 * The spec's settings overlay as it restores, checked once per revive here: only the settings a spawn writes
	 * ({@link SUBAGENT_OVERLAY_SETTINGS}). Undefined where the record holds none, or where it does not restore (the
	 * build then takes the settings of an older record).
	 */
	readonly settings: SpawnSpecSettings | undefined;
	/** A per-call worker's grants, which each of its requests is held to. */
	readonly grants: PerCallGrantInputs | undefined;
	/** Each custom tool the spec names, built over the live parent's kernel or kept as unavailable. */
	readonly customTools: readonly CustomTool[];
	/** Names of the custom tools no live kernel serves. */
	readonly unavailableTools: readonly string[];
	/**
	 * Where neither the stored model nor the parent's can run at or below the effort ceiling: the notice the revived
	 * session records, as it runs on the parent's model at its lowest effort. Undefined otherwise.
	 */
	readonly ceilingNotice: string | undefined;
	/**
	 * The provider offline mode holds every request to: the live parent's, read with the live `models.offline`
	 * setting (null where the parent has no model); undefined while offline mode is off.
	 */
	readonly allowedProvider: string | null | undefined;
	/**
	 * The policy fields a spawn takes from its spawner: the live parent's, else the root tool session's (the parent
	 * is not live, or its home cannot answer); undefined where neither holds a tool session (a host's root).
	 */
	readonly parentPolicy: ParentPolicy | undefined;
}

/**
 * Everything one cold revive of a persisted subagent needs, built on main per revive and
 * cloneable (live objects cross as their bridged proxies), so the session can be created
 * on main or inside a pooled worker alike.
 */
export interface PersistedReviveSpec {
	readonly id: string;
	readonly displayName: string;
	readonly parentId: string | undefined;
	readonly sessionFile: string;
	/** Depth derived from the persisted parent chain (drives capability gating). */
	readonly taskDepth: number;
	/** The live top-level session revived agents join (parent grants of its direct children). */
	readonly root: AgentSessionHandle;
	/** Registry id of {@link root}. */
	readonly rootAgentId: string;
	/** The root session's settings, which the subagent settings of a record with no spawn spec build on. */
	readonly settings: Settings;
	readonly prepared: PreparedColdRevive;
}

/** A cold revive before the main thread prepared it. */
type ColdReviveTarget = Omit<PersistedReviveSpec, "prepared">;

/**
 * Durable agent definition name (`scout`, `reviewer`, …) of a persisted subagent.
 * Cold-revived refs register with `displayName: id` (`registry/persisted-agents.ts`),
 * so a generated task id would silently drop agent-scoped rules and budgets.
 * `init.agent` carries the real name; only files predating that field fall back to
 * `displayName`. A parked transcript may also predate the `main`/`sub` definition-name
 * reservation (`discovery/helpers.ts`): a persisted `init.agent` of either sentinel
 * value from such a legacy custom agent must not masquerade as that sentinel, so it
 * falls back to `displayName` too, keeping it scoped as an ordinary subagent under its
 * generated id instead of `main` or the shared `sub` bucket.
 */
export function persistedAgentName(displayName: string, init: PersistedSessionInit): string {
	const normalized = init.agent?.trim().toLowerCase();
	return init.agent && normalized !== MAIN_AGENT_RULE_NAME && normalized !== SUB_AGENT_RULE_NAME
		? init.agent
		: displayName;
}

/**
 * The agent definition a cold-revived subagent's monitored turns report (IRC wakes,
 * `omp --restore`) when its record holds no spawn spec: such files predate an agent-source
 * field, so frames carry the runtime-neutral `user` source; the name is the registry ref's.
 */
export function persistedAgentDefinition(displayName: string, init: PersistedSessionInit): AgentDefinition {
	return {
		name: displayName,
		description: "",
		systemPrompt: init.systemPrompt.join("\n\n"),
		source: "user",
	};
}

/**
 * Build the factory the {@link AgentLifecycleManager} uses to cold-revive a
 * `parked` subagent ref restored from disk (Agent Hub scan, collab mirror, or a
 * resumed process). Such a ref carries a sessionFile but no in-memory adoption —
 * the executor's live reviver closure died with the process/turn that spawned
 * it — so `ensureLive` (IRC sends, hub focus) would otherwise refuse it.
 *
 * Each revive builds the subagent through {@link reviveSubagentSession} from the spawn spec
 * of the transcript's latest `session_init` and the live inputs of its live parent session;
 * a record an older omp wrote takes, part by part, what the cold revive built before spawn
 * specs existed.
 */
export function createPersistedSubagentReviverFactory(
	ctx: PersistedSubagentReviveContext,
): PersistedSubagentReviverFactory {
	const registry = AgentRegistry.global();
	return async ref => {
		const sessionFile = ref.sessionFile;
		if (!sessionFile) return undefined;
		const peek = await SessionManager.peekSessionInit(sessionFile);
		// No persisted contract (pre-session_init file) or the recorded workspace
		// is gone (isolated/merged worktree, moved dir): leave it transcript-only
		// (history://) rather than resurrect a wrong or broken session.
		if (!peek?.init) return undefined;
		const init = peek.init;
		// Isolated runs are never resumable: their worktree is merged + cleaned,
		// and the parent was told messaging is impossible. A retained workspace
		// (capture/persist failure) still exists on disk and would pass the cwd
		// probe below, so gate on the stamped contract instead — otherwise a
		// restart + peer message revives the agent outside isolation, in the
		// parent cwd, contradicting the delivery notice.
		if (init.isolated) return undefined;
		try {
			await fs.stat(peek.cwd);
		} catch {
			return undefined;
		}
		// taskDepth drives real capability gating (task-spawn allowance, memory
		// startup, …); derive it from the persisted parent chain rather than
		// assuming a fixed level.
		let taskDepth = 1;
		let parentId = ref.parentId;
		const seen = new Set<string>();
		while (parentId && parentId !== MAIN_AGENT_ID && !seen.has(parentId)) {
			seen.add(parentId);
			taskDepth++;
			parentId = registry.get(parentId)?.parentId;
		}
		return async expectedRef => {
			// Live state is read per revive, so a later `/new`, cwd move or registry change is followed.
			const target: ColdReviveTarget = {
				id: ref.id,
				displayName: ref.displayName,
				parentId: ref.parentId,
				sessionFile,
				taskDepth,
				root: ctx.session,
				rootAgentId: ctx.session.getAgentId?.() ?? MAIN_AGENT_ID,
				settings: ctx.settings,
			};
			const spec: PersistedReviveSpec = { ...target, prepared: await prepareColdRevive(ctx, target, init) };
			// Worker mode: a cold revival is placed like a fresh spawn.
			const pool = subagentWorkerPool(ctx.settings);
			return pool
				? revivePersistedPlaced(pool, spec, expectedRef, revivePersistedSubagent)
				: revivePersistedSubagent(spec, expectedRef);
		};
	};
}

/**
 * The main thread's part of one cold revive, at the start of each reviver call and before anything is
 * reopened: the spec's settings overlay as it restores (checked here, once per revive), the live parent
 * session's inputs (from its home where it is homed in a worker), the model the record's spawn spec starts on
 * as the registry holds it now (a per-call worker: its saved model, held to the grants as they are now), and
 * the spec's custom tools over the live parent's eval kernels. `init` is the `session_init` the factory read.
 */
export async function prepareColdRevive(
	ctx: PersistedSubagentReviveContext,
	target: ColdReviveTarget,
	init: PersistedSessionInit,
): Promise<PreparedColdRevive> {
	const root = ctx.session;
	const stored = readSpawnSpec(init);
	const settings = stored.settings && coldReviveSettings(target, stored.settings);
	const parts: SpawnSpecParts = { ...stored, settings };
	const parentSession = liveParentSession(target);
	const descriptors = parts.tools?.customTools ?? [];
	const parent = await liveParent(target.id, parentSession, descriptors);
	const agentName = persistedAgentName(target.displayName, init);
	const live = await coldReviveLiveInputs(
		ctx,
		parent,
		{
			id: target.id,
			name: parts.wake?.agent.name ?? agentName,
			description: parts.wake?.agent.description ?? "",
		},
		parts.liveInputs,
	);
	const settingsParent = coldReviveSettingsParent(target, parts, live);
	const modelRegistry = live.modelRegistry;
	const models = new RevivedModels(modelRegistry, settingsParent);
	// The model of the parent's live session, the root's where the parent ref holds none: the fallback of a stored
	// model that cannot start the revive, and the provider offline mode holds every request to.
	const parentModel = parentSession?.model ?? root.model;
	let model: ExplicitBuildModel | undefined;
	let grants: PerCallGrantInputs | undefined;
	let ceilingNotice: string | undefined;
	if (isPerCallRecord(parts, init)) {
		const identity = parts.model ? parts.model.model : init.perCallModelIdentity;
		const level = parts.thinking ? parts.thinking.thinkingLevel : init.perCallThinkingLevel;
		if (!identity || level === undefined) {
			throw new PerCallModelError(
				`Cannot revive subagent "${target.id}": its per-call model identity and thinking level were not recorded separately, so they cannot be restored exactly. The agent was not revived.`,
			);
		}
		grants = await perCallGrantInputs(target, init, parentSession, settingsParent);
		model = await choosePerCallModel({
			id: target.id,
			identity,
			level: level ?? undefined,
			models,
			modelRegistry,
			approve: perCallApproval(target, grants, settingsParent, modelRegistry),
			ceiling: liveEffortCeiling(
				parts.thinking ? parts.thinking.thinkingLevelCeiling : cfgTaskMaxEffort.get(settingsParent),
				settingsParent,
			),
			fallback: parentModel,
			mayUseParent: mayReviveUseParentModel(parts),
		});
	} else if (parts.model) {
		const choice = await chooseColdReviveModel({
			id: target.id,
			identity: parts.model.model,
			level: parts.thinking?.thinkingLevel ?? undefined,
			models,
			modelRegistry,
			ceiling: liveEffortCeiling(parts.thinking?.thinkingLevelCeiling, settingsParent),
			fallback: parentModel,
			mayUseParent: mayReviveUseParentModel(parts),
		});
		model = choice.model;
		ceilingNotice = choice.ceilingNotice;
	}
	let prewalkTarget: Model | undefined;
	if (parts.prewalk) {
		// Held to the spawn's own check: a target whose provider has no credential is not armed.
		const resolved = await models.resolve(parts.prewalk.target);
		prewalkTarget = resolved && modelRegistry.hasConfiguredAuth(resolved) ? resolved : undefined;
		if (!prewalkTarget) {
			logger.warn("Revived subagent prewalk target unavailable; skipping prewalk", {
				subagent: target.id,
				target: parts.prewalk.target,
			});
		}
	}
	const tools = coldReviveCustomTools(target.id, descriptors, parent?.customTools ?? []);
	// Offline mode holds every request to the live parent's provider, as the spawn held it to its parent's.
	const allowedProvider = cfgOffline.get(live.settingsParent) ? (parentModel?.provider ?? null) : undefined;
	// The policy alone falls back to the root's, as the live inputs do: the custom tools of a parent that is not
	// live are asked of no kernel, the root's included.
	const rootTools = root.evalToolSession;
	return {
		live,
		model,
		prewalkTarget,
		discoveryRan: models.discoveryRan,
		settings: parts.settings,
		grants,
		customTools: tools.customTools,
		unavailableTools: tools.unavailable,
		ceilingNotice,
		allowedProvider,
		parentPolicy: parent ? parent.policy : rootTools && parentPolicy(rootTools),
	};
}

/**
 * `stored`, a spec's settings overlay, as a cold revive restores it. It must restore as `overlay()` checks
 * overrides (each setting known, each value one its definition accepts); an overlay that does not is a malformed
 * part, which takes its legacy variant (undefined), with a warning. Of an overlay that restores, only the settings
 * a spawn writes ({@link SUBAGENT_OVERLAY_SETTINGS}) are kept, so a stored value never widens what the live parent
 * allows, with a warning where it held any other.
 */
function coldReviveSettings(target: ColdReviveTarget, stored: SpawnSpecSettings): SpawnSpecSettings | undefined {
	let kept: KeptOverlayLayers;
	try {
		kept = target.settings.keptOverlayLayers(stored.layers, SUBAGENT_OVERLAY_SETTINGS);
	} catch (error) {
		logger.warn("Revived subagent's stored settings do not restore; it takes the settings of an older record", {
			subagent: target.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	if (kept.dropped) {
		logger.warn("Revived subagent's stored settings hold values no spawn writes; they read through to the parent", {
			subagent: target.id,
		});
	}
	return spawnSpecSettings({ layers: kept.layers, rootThresholds: stored.rootThresholds });
}

/** What a cold revive restores the subagent's overlay over: the live parent's settings for a spec's, else the root's. */
function coldReviveSettingsParent(
	target: ColdReviveTarget,
	parts: SpawnSpecParts,
	live: ColdReviveLiveInputs,
): Settings {
	return parts.settings ? live.settingsParent : target.settings;
}

/** Whether the subagent's model came from a per-call `model`: the spec's flag, else the record's. */
function isPerCallRecord(parts: SpawnSpecParts, init: PersistedSessionInit): boolean {
	return parts.model ? parts.model.perCallModel : init.perCallModel === true;
}

/** The agent the spawn selected, as the live discovery scope finds it now: what its grants rest on. */
async function perCallGrantInputs(
	target: ColdReviveTarget,
	init: PersistedSessionInit,
	parentSession: AgentSessionHandle | undefined,
	settings: Settings,
): Promise<PerCallGrantInputs> {
	// File definitions follow the live parent's discovery scope; a missing parent
	// can use current root file discovery, never unrelated root-local pseudonyms.
	const discoverySession = parentSession ?? target.root;
	const configuredAgent = init.agent
		? getAgent(
				[
					...(
						await discoverAgents(
							discoverySession.sessionManager.getCwd(),
							undefined,
							discoverySession.effectiveExtensionRoots,
						)
					).agents,
					...(parentSession?.getSessionAgents() ?? []),
				],
				init.agent,
			)
		: undefined;
	return {
		agentName: init.agent ?? target.displayName,
		agentModel: configuredAgent?.model,
		agentSource: configuredAgent?.source,
		agentRemoved: configuredAgent === undefined,
		matchPreferences: structuredClone(getModelMatchPreferences(settings.grantAuthority())),
	};
}

/**
 * Holds a revived per-call worker's models to the operator's grants as they are at each call: the agent
 * the spawn selected, and the model of its real parent while that parent is live.
 */
function perCallApproval(
	target: ColdReviveTarget,
	grants: PerCallGrantInputs,
	settings: Settings,
	modelRegistry: ModelRegistry,
): (model: Model) => void {
	// One grants object per live parent model keeps approval decisions cached across requests.
	const grantsByParentModel = new Map<string | undefined, PerCallModelGrants>();
	return model => {
		// Parent models grant only while the real parent is live, including
		// after this revival; transcript metadata never substitutes for it.
		const parentSession = liveParentSession(target);
		const parentModel = parentSession?.model;
		const parentModelPattern = parentModel ? parentModelGrantPattern(parentModel) : undefined;
		let modelGrants = grantsByParentModel.get(parentModelPattern);
		if (!modelGrants) {
			modelGrants = { ...grants, settings, parentModelPattern };
			grantsByParentModel.set(parentModelPattern, modelGrants);
		}
		try {
			assertPerCallModelApproved(model, modelGrants, modelRegistry);
		} catch (error) {
			// Only an approval denial depends on the parent; an unavailable model is refused either way.
			if (parentSession || !(error instanceof PerCallModelError) || error instanceof PerCallModelUnavailableError) {
				throw error;
			}
			throw new PerCallModelError(
				`${error.message} Parent agent "${target.parentId ?? "unknown"}" of revived subagent "${target.id}" is not live; its model grants nothing and its parent-local agent grants are unavailable until the parent is revived.`,
			);
		}
	};
}

/**
 * Rebuild the persisted subagent of `spec` on the calling thread (main, or the pooled
 * worker that will home it) and claim `expectedRef` for it.
 */
export async function revivePersistedSubagent(spec: PersistedReviveSpec, expectedRef: AgentRef): Promise<AgentSession> {
	const { prepared } = spec;
	const reopened = await reopenParkedSubagent(spec.id, spec.sessionFile);
	const init = extractSessionInit(reopened.getEntries());
	if (!init) {
		await reopened.close();
		throw new Error(
			`Cannot revive subagent "${spec.id}": session file "${spec.sessionFile}" has no persisted session contract. The agent was not revived.`,
		);
	}
	// The session builds where its live root now works, as the cold revive did before spawn specs; the
	// stored policy's cwd is not used.
	const cwd = spec.root.sessionManager.getCwd();
	// The settings overlay as the main thread checked it, once per revive; the other parts as the record holds them.
	const parts: SpawnSpecParts = { ...readSpawnSpec(init), settings: prepared.settings };
	const settingsParent = coldReviveSettingsParent(spec, parts, prepared.live);
	const spawnSpec = coldReviveSpawnSpec(spec, parts, init, settingsParent, cwd, reopened.getAdditionalDirectories());
	const approve = prepared.grants
		? perCallApproval(spec, prepared.grants, settingsParent, prepared.live.modelRegistry)
		: undefined;
	const live: SubagentLiveInputs = {
		...prepared.live,
		settingsParent,
		customTools: [...prepared.customTools],
		// Offline mode holds every request to the live parent's provider; a per-call model is held to the
		// operator's grants as they are now, and to the effort ceiling.
		assertDispatchModel: subagentDispatchAssertion(
			prepared.allowedProvider,
			approve
				? perCallModelAssertion(approve, () => liveEffortCeiling(spawnSpec.thinkingLevelCeiling, settingsParent))
				: undefined,
		),
	};
	const model = await coldReviveModel(spec, init, { spec: spawnSpec, live, sessionManager: reopened });
	const session = await reviveSubagentSession({
		spec: spawnSpec,
		live,
		sessionManager: reopened,
		model,
		prewalkTarget: prepared.prewalkTarget,
		settings: spawnSpec.settings,
		expectedAgentRef: expectedRef,
		heldInit: init,
		// A record whose spec has no tools part keeps its own tool commands, and its tool list is its contract.
		mountedToolNames: parts.tools ? spawnSpec.tools.mountedToolNames : init.mountedTools,
		activeTools: parts.tools ? undefined : (spawnSpec.tools.toolNames ?? []),
		// A record whose spec has no prompt part holds no prompt inputs to render another prompt from.
		replayHeldPrompt: parts.prompt === undefined,
	});
	if (spawnSpec.perCallModel) {
		// A per-call worker runs only on the model its grants approved here, never a similarly named survivor.
		const expected = model.kind === "model" && model.model ? formatModelStringWithRouting(model.model) : undefined;
		const identity = session.model ? formatModelStringWithRouting(session.model) : undefined;
		if (identity !== expected) {
			await session.dispose();
			throw new PerCallModelError(
				`Cannot revive subagent "${spec.id}": its per-call model ${expected} is no longer available${identity ? ` (resolution found ${identity})` : ""}. The agent was not revived.`,
			);
		}
		// An explicit unset selector must not inherit a new default while reviving.
		if (!parts.thinking && init.perCallThinkingLevel === null) session.setThinkingLevel(undefined);
	}
	// The ceiling notice holds only while the session runs on the model it names: a switch since the spawn passed
	// the ceiling check.
	const notedModel = prepared.model?.model;
	if (
		prepared.ceilingNotice &&
		notedModel &&
		session.model &&
		formatModelStringWithRouting(session.model) === formatModelStringWithRouting(notedModel)
	) {
		// The same mechanism as the unavailable tools below, shown in the transcript.
		await session.sendCustomMessage(
			{ customType: EFFORT_CEILING_NOTICE, content: prepared.ceilingNotice, display: true },
			{ deliverAs: "nextTurn" },
		);
	}
	if (prepared.unavailableTools.length > 0) {
		// After the transcript, so the held prompt, the tool list and the conversation keep their bytes.
		await session.sendCustomMessage(
			{
				customType: UNAVAILABLE_CUSTOM_TOOLS_NOTICE,
				content: prompt.render(unavailableCustomToolsPrompt, { tools: prepared.unavailableTools }),
				display: false,
			},
			{ deliverAs: "nextTurn" },
		);
	}
	return session;
}

/**
 * The model of the build. A prepared model (a spec's, a per-call worker's) holds unless a session-local
 * switch since the spawn takes its place, as {@link switchedOrHeldModel} decides for both revives. A record
 * whose spec gives no model starts on the record's patterns, the switched model first.
 */
async function coldReviveModel(
	spec: PersistedReviveSpec,
	init: PersistedSessionInit,
	build: Pick<SubagentCreateInput, "spec" | "live" | "sessionManager">,
): Promise<ColdReviveBuildModel> {
	const { prepared } = spec;
	if (prepared.model) return switchedOrHeldModel(build, prepared.model, prepared.discoveryRan);
	const switched = build.sessionManager.getSessionLocalModelChange()?.model;
	const spawnModelPattern =
		init.modelRole && init.modelRole !== "default"
			? [formatModelRoleAlias(init.modelRole), ...(init.resolvedModel ? [init.resolvedModel] : [])]
			: init.resolvedModel;
	return {
		kind: "legacy",
		modelPattern:
			switched === undefined
				? spawnModelPattern
				: [switched, ...(spawnModelPattern === undefined ? [] : [spawnModelPattern].flat())],
		modelPatternParentFallback: init.resolvedModel,
	};
}

/**
 * The spawn spec the build starts from: each part of the record's spec, and
 * for each part it lacks (every part of a record an older omp wrote) the
 * values every spawn gives (`cacheWarming: "streaming"`). The cwd is the live
 * root's, never the stored policy's. A stored value never widens what the live
 * process allows. A record with no spec keeps the workspace roots its file
 * header holds (`headerRoots`); a malformed policy part keeps none.
 */
function coldReviveSpawnSpec(
	spec: PersistedReviveSpec,
	parts: SpawnSpecParts,
	init: PersistedSessionInit,
	settingsParent: Settings,
	cwd: string,
	headerRoots: string[],
): SubagentSpawnSpec {
	const { id, displayName } = spec;
	const agentName = persistedAgentName(displayName, init);
	const legacyAgent = persistedAgentDefinition(displayName, init);
	// A restricted persisted contract must not consult process-global MCP
	// state: same-name MCP tools are untrusted capability sources.
	const restricted = init.restrictToolNames === true;
	// The session has a `yield` tool exactly when its spawn gave it an output schema.
	const structured = usesYield(init.outputSchema);
	const tools = parts.tools ?? {
		toolNames: init.tools,
		mountedToolNames: init.mountedTools ?? [],
		restrictToolNames: restricted || undefined,
		requireYieldTool: structured,
		// The record's tool list already leaves out what its spawn stripped.
		keepTodo: true,
		outputSchema: jsonValue(init.outputSchema),
		outputSchemaMode: init.outputSchemaMode,
		customTools: [],
	};
	const perCall = isPerCallRecord(parts, init);
	const spawnSpec: SubagentSpawnSpec = {
		v: SPAWN_SPEC_VERSION,
		model: parts.model?.model ?? null,
		thinkingLevel: parts.thinking?.thinkingLevel ?? null,
		// A per-call model keeps the live task.maxEffort ceiling the spawn ran under.
		thinkingLevelCeiling: parts.thinking
			? parts.thinking.thinkingLevelCeiling
			: perCall
				? cfgTaskMaxEffort.get(settingsParent)
				: undefined,
		perCallModel: perCall,
		prewalk: parts.prewalk,
		settings: parts.settings ?? legacySubagentSettings(id, init, settingsParent),
		tools,
		policy: parts.policy
			? {
					...parts.policy,
					// The constant every spawn writes.
					cacheWarming: "streaming",
					// The live root's cwd, where a revive from the stored session builds; never the stored policy's.
					cwd,
					// Never shallower than the live parent chain, so `task.maxRecursionDepth` holds.
					taskDepth: Math.max(parts.policy.taskDepth ?? spec.taskDepth, spec.taskDepth),
					// Where the spawn passed them, the spawner's as the live parent holds them now (the root's where the
					// parent is not live), never the record's; none where the spawn passed none (a vibe worker's spawner).
					credentialSourceSessionId:
						parts.policy.credentialSourceSessionId === undefined
							? undefined
							: spec.prepared.parentPolicy?.credentialSourceSessionId,
					additionalDirectories:
						parts.policy.additionalDirectories === undefined
							? undefined
							: spec.prepared.parentPolicy?.additionalDirectories,
				}
			: {
					cwd,
					...(parts.stored ? undefined : { additionalDirectories: headerRoots }),
					enableLsp: spec.prepared.live.policy.enableLsp,
					// The constant every spawn writes, for a record with no spec and for a spec whose policy part is
					// missing or malformed alike.
					cacheWarming: "streaming",
					...(restricted ? { enableIrc: false, enableMCP: false } : undefined),
					// Old files predate persisted spawns: deny re-spawning rather than let
					// createAgentSession default to wildcard ("*").
					spawns: init.spawns ?? "",
					taskDepth: spec.taskDepth,
				},
		identity: {
			// The names the record stores (`agents` rule scoping keys on the durable definition name, see
			// `persistedAgentName`); the ids are the live registry ref's, never the record's.
			agentName: parts.identity ? parts.identity.agentName : agentName,
			agentDisplayName: parts.identity ? parts.identity.agentDisplayName : displayName,
			agentId: id,
			parentAgentId: spec.parentId,
			parentTaskPrefix: id,
		},
		// The session drives the registry status and the wake frames of this id: the ref's, never the record's.
		prompt: parts.prompt
			? { ...parts.prompt, id }
			: {
					id,
					agentSystemPrompt: legacyAgent.systemPrompt,
					context: "",
					planReference: "",
					planReferencePath: "",
					worktree: "",
					structured,
					outputSchemaOverridesAgent: false,
					ircEnabled: false,
				},
		wake: parts.wake
			? {
					...parts.wake,
					// The run's artifacts go to the revived ref's own dir, and its limits are never looser than the
					// live settings'.
					artifactsDir: path.dirname(spec.sessionFile),
					maxRuntimeMs: tighterLimit(parts.wake.maxRuntimeMs, cfgTaskMaxRuntimeMs.get(settingsParent)),
					softRequestBudget: tighterLimit(
						parts.wake.softRequestBudget,
						softRequestBudgetFor(parts.wake.agent.name, settingsParent).softRequestBudget,
					),
				}
			: {
					agent: { name: legacyAgent.name, description: legacyAgent.description, source: legacyAgent.source },
					completionProbe: isCompletionProbeEnabled(spec.settings, spec.taskDepth - 1),
					maxRuntimeMs: cfgTaskMaxRuntimeMs.get(settingsParent),
					...softRequestBudgetFor(agentName, spec.settings),
					outputSchema: jsonValue(init.outputSchema),
					outputSchemaMode: init.outputSchemaMode,
					// Anchor artifacts to the revived ref's own dir (its parent's children
					// dir), not the live root session's, matching the spawn callers (#11563).
					artifactsDir: path.dirname(spec.sessionFile),
				},
	};
	return spawnSpec;
}

/**
 * The tighter of a stored limit and the live one, where 0 (or no stored value) sets none: a stored limit never
 * loosens what the live settings allow.
 */
export function tighterLimit(stored: number | undefined, live: number): number {
	const limits = [stored ?? 0, live].filter(limit => limit > 0);
	return limits.length > 0 ? Math.min(...limits) : 0;
}

/**
 * The subagent settings of a record with no spawn spec, over `parent`: the same advisor opt-in, summarize
 * switch and compaction threshold the spawn resolved, and the `subagent:<id>` fallback chain it installed,
 * which the transcript alone cannot rebuild (multi-model agent patterns and inherited role chains are
 * resolved only at spawn).
 */
function legacySubagentSettings(id: string, init: PersistedSessionInit, parent: Settings): SpawnSpecSettings {
	const overrides: SubagentOverlayOverrides = { ...subagentLspWritethroughSettings(parent) };
	if (init.readSummarize === false) overrides["read.summarize.enabled"] = false;
	if (init.advisor) {
		overrides["advisor.enabled"] = true;
		// `"on"` = advisor-role model, anything else = the pattern stamped onto this session's
		// `modelRoles.advisor`, which spawn persists already expanded against the spawning owner's roles;
		// expanding again is a no-op for those and only resolves aliases in files written before that.
		if (init.advisor !== "on") {
			overrides.modelRoles = {
				...parent.getModelRoles(),
				advisor: resolveAgentAdvisorRolePattern(init.advisor, parent),
			};
		}
	}
	const settings = createSubagentSettings(parent, {
		...overrides,
		...compactionThresholdSettings(init.compactionThreshold),
	});
	if (init.retryFallback) installRetryFallbackRole(settings, subagentRetryFallbackRole(id), init.retryFallback);
	return spawnSpecSettings(captureSubagentSettings(settings));
}
