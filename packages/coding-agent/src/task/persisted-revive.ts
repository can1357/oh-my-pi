import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { MAIN_AGENT_RULE_NAME, SUB_AGENT_RULE_NAME } from "../capability/rule";
import { validateAgentAccountPools } from "../config/account-pools";
import type { Model } from "@oh-my-pi/pi-ai";
import { assertModelSupportsEffortCeiling } from "@oh-my-pi/pi-tui/thinking";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelStringWithRouting,
	getModelMatchPreferences,
	resolveAgentAdvisorRolePattern,
	resolveExactModelIdentity,
} from "../config/model-resolver";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { MCPManager } from "../mcp/manager";
import { initializeExtensions } from "../modes/runtime-init";
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { installRetryFallbackRole } from "../session/retry-fallback-chains";
import type { AuthStorage } from "../session/auth-storage";
import {
	extractSessionInit,
	hasConversationalHistory,
	type PersistedSessionInit,
	SessionManager,
} from "../session/session-manager";
import type { EventBus } from "../utils/event-bus";
import {
	attachIrcWakeTurnMonitor,
	compactionThresholdSettings,
	createMCPProxyTools,
	createSubagentSettings,
	followMCPTools,
	replayRevivedAgentStart,
	subagentRetryFallbackRole,
} from "./executor";
import { isCompletionProbeEnabled } from "./completion-probe";
import { discoverAgents, getAgent } from "./discovery";
import {
	assertPerCallModelApproved,
	parentModelGrantPattern,
	PerCallModelError,
	PerCallModelUnavailableError,
	type PerCallModelGrants,
} from "./model-approval";
import { cfgTaskAgentAccountPools, cfgTaskMaxEffort } from "./settings";
import { type RestoredSeanceSession, restoreSeanceSession } from "./seance";
import { seanceIsolationOptions } from "./seance-policy";
import type { AgentDefinition } from "./types";

/**
 * Ambient context the reviver needs at revive time. The top-level session is
 * kept LIVE (cwd / artifact manager read on demand) so a later `/new` or cwd
 * move is followed rather than snapshotted; auth/models/settings are
 * process-stable and captured by reference.
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

/**
 * The agent definition a cold-revived subagent's monitored turns report (IRC wakes,
 * `omp --restore`): persisted files predate an agent-source field, so frames carry
 * the runtime-neutral `user` source; the name is the registry ref's.
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
 * This rebuilds the subagent the same way `--resume` rebuilds a session: reopen
 * the JSONL and replay it through {@link createAgentSession}. The catch is that
 * resume restores only conversation/model from the file — the runtime contract
 * (tools / system prompt / output schema / kind) is built from options, so a
 * bare reopen would resurrect a wrong (top-level) session. We source that
 * contract from the persisted `session_init` entry instead, and mirror the
 * executor's subagent wiring (MCP proxy tools, depth-derived gating,
 * yield-required, active-tool clamp, registry status sync).
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
		let restoredSeance: RestoredSeanceSession | undefined;
		if (peek.seanceSource !== undefined) {
			try {
				restoredSeance = await restoreSeanceSession({
					init: peek.init,
					cwd: peek.cwd,
					modelRegistry: ctx.modelRegistry,
				});
			} catch (error) {
				logger.warn("Unable to restore persisted seance session", {
					sessionFile,
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			}
			if (!restoredSeance) return undefined;
		}
		const seanceOptions = restoredSeance ? seanceIsolationOptions(restoredSeance.cwd) : {};
		// Isolated runs are never resumable: their worktree is merged + cleaned,
		// and the parent was told messaging is impossible. A retained workspace
		// (capture/persist failure) still exists on disk and would pass the cwd
		// probe below, so gate on the stamped contract instead — otherwise a
		// restart + peer message revives the agent outside isolation, in the
		// parent cwd, contradicting the delivery notice.
		if (peek.init.isolated) return undefined;
		try {
			await fs.stat(restoredSeance?.cwd ?? peek.cwd);
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
			// Re-open fresh on every revive: park closes the writer, so this takes
			// the single-writer lock cleanly and restores the full message history.
			const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			const entries = reopened.getEntries();
			const init = extractSessionInit(entries);
			if (!init) {
				await reopened.close();
				throw new Error(
					`Cannot revive subagent "${ref.id}": session file "${sessionFile}" has no persisted session contract. The agent was not revived.`,
				);
			}
			if (!hasConversationalHistory(entries)) {
				await reopened.close();
				throw new Error(
					`Cannot revive subagent "${ref.id}": session file "${sessionFile}" has no message history (truncated to header/session_init). The agent was not revived.`,
				);
			}
			const resolveParentSession = () =>
				ref.parentId === (ctx.session.getAgentId?.() ?? MAIN_AGENT_ID)
					? ctx.session
					: registry.get(ref.parentId ?? "")?.session;
			const parentSession = resolveParentSession();
			let perCallModel: Model | undefined;
			let assertApprovedModel: ((model: Model) => void) | undefined;
			if (init.perCallModel) {
				try {
					if (!init.perCallModelIdentity || init.perCallThinkingLevel === undefined) {
						throw new PerCallModelError(
							`Cannot revive subagent "${ref.id}": its per-call model identity and thinking level were not recorded separately, so they cannot be restored exactly. The agent was not revived.`,
						);
					}
					await ctx.modelRegistry.awaitBackgroundRefresh();
					perCallModel = resolveExactModelIdentity(init.perCallModelIdentity, ctx.modelRegistry);
					if (!perCallModel) {
						throw new PerCallModelError(
							`Cannot revive subagent "${ref.id}": its per-call model ${init.perCallModelIdentity} is no longer available. A per-call worker revives only on its exact saved model.`,
						);
					}
					// File definitions follow the live parent's discovery scope; a missing parent
					// can use current root file discovery, never unrelated root-local pseudonyms.
					const discoverySession = parentSession ?? ctx.session;
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
					const matchPreferences = structuredClone(getModelMatchPreferences(ctx.settings.grantAuthority()));
					// One grants object per live parent model keeps approval decisions cached across requests.
					const grantsByParentModel = new Map<string | undefined, PerCallModelGrants>();
					const grantsFor = (parentModelPattern: string | undefined): PerCallModelGrants => {
						let grants = grantsByParentModel.get(parentModelPattern);
						if (!grants) {
							grants = {
								settings: ctx.settings,
								agentName: init.agent ?? ref.displayName,
								agentModel: configuredAgent?.model,
								agentSource: configuredAgent?.source,
								agentRemoved: configuredAgent === undefined,
								parentModelPattern,
								matchPreferences,
							};
							grantsByParentModel.set(parentModelPattern, grants);
						}
						return grants;
					};
					assertApprovedModel = model => {
						// Parent models grant only while the real parent is live, including
						// after this revival; transcript metadata never substitutes for it.
						const liveParentSession = resolveParentSession();
						const parentModel = liveParentSession?.model;
						try {
							assertPerCallModelApproved(
								model,
								grantsFor(parentModel ? parentModelGrantPattern(parentModel) : undefined),
								ctx.modelRegistry,
							);
						} catch (error) {
							// Only an approval denial depends on the parent; an unavailable model is refused either way.
							if (
								liveParentSession ||
								!(error instanceof PerCallModelError) ||
								error instanceof PerCallModelUnavailableError
							)
								throw error;
							throw new PerCallModelError(
								`${error.message} Parent agent "${ref.parentId ?? "unknown"}" of revived subagent "${ref.id}" is not live; its model grants nothing and its parent-local agent grants are unavailable until the parent is revived.`,
							);
						}
					};
					assertApprovedModel(perCallModel);
					assertModelSupportsEffortCeiling(perCallModel, cfgTaskMaxEffort.get(ctx.settings));
				} catch (error) {
					await reopened.close();
					throw error;
				}
			}
			// Rebuild the same advisor opt-in the original spawn resolved: `"on"` =
			// advisor-role model, anything else = the pattern stamped onto this
			// session's `modelRoles.advisor`. Spawn persists it already expanded
			// against the spawning owner's roles (a parent subagent may override
			// them); expanding again is a no-op for those and only resolves aliases
			// in files written before that. Absent = unadvised (the
			// createSubagentSettings default).
			const subagentSettings = createSubagentSettings(ctx.settings, {
				...(init.readSummarize === false ? { "read.summarize.enabled": false } : undefined),
				...(init.advisor
					? {
							"advisor.enabled": true,
							...(init.advisor !== "on"
								? {
										modelRoles: {
											...ctx.settings.getModelRoles(),
											advisor: resolveAgentAdvisorRolePattern(init.advisor, ctx.settings),
										},
									}
								: undefined),
						}
					: undefined),
				...compactionThresholdSettings(init.compactionThreshold),
			});
			// Restore the `subagent:<id>` fallback chain the spawn installed; the
			// transcript alone cannot rebuild it (multi-model agent patterns and
			// inherited role chains are resolved only at spawn).
			if (init.retryFallback) {
				installRetryFallbackRole(subagentSettings, subagentRetryFallbackRole(ref.id), init.retryFallback);
			}
			// Account pools are owner policy, like the extension roots below: take the
			// live exact-name `task.agentAccountPools` entry, never a transcript copy.
			const agentAccountPools = validateAgentAccountPools(cfgTaskAgentAccountPools.get(ctx.settings));
			const oauthAccountPools =
				init.agent && Object.hasOwn(agentAccountPools, init.agent) ? agentAccountPools[init.agent] : undefined;
			const spawnModelPattern = restoredSeance
				? restoredSeance.modelPattern
				: init.modelRole && init.modelRole !== "default"
					? [formatModelRoleAlias(init.modelRole), ...(init.resolvedModel ? [init.resolvedModel] : [])]
					: init.resolvedModel;
			// A session-local switch since spawn (a prewalk handoff) is the model the agent
			// was working on; the spawn selection only backs it up when it is unavailable. A
			// seance fork's selections belong to its source run, never to the consult.
			const sessionLocalModel = restoredSeance ? undefined : reopened.getSessionLocalModelChange()?.model;
			// A per-call worker revives only onto its exact saved model: no role alias, no auth fallback.
			const persistedModelPattern = init.perCallModel
				? undefined
				: sessionLocalModel
					? [sessionLocalModel, ...(spawnModelPattern === undefined ? [] : [spawnModelPattern].flat())]
					: spawnModelPattern;
			// Older session files persisted the synthetic xd:// write transport in the
			// enabled set. A read-only agent definition could never grant full write,
			// so remove that transport name before replaying tools as explicit grants.
			const revivedToolNames = restoredSeance
				? restoredSeance.toolNames
				: init.readOnly === true && init.tools.includes("write")
					? init.tools.filter(name => name !== "write")
					: init.tools;
			const artifactManager = ctx.session.sessionManager.getArtifactManager();
			if (artifactManager && !restoredSeance) reopened.adoptArtifactManager(artifactManager);
			// A restricted persisted contract must not consult process-global MCP
			// state: same-name MCP tools are untrusted capability sources.
			const restrictToolNames = restoredSeance !== undefined || init.restrictToolNames === true;
			// The spawn's result contract: a session persisted without `yield` returned its final message.
			const structured = revivedToolNames.includes("yield");
			const mcpManager = restrictToolNames ? undefined : MCPManager.instance();
			// Subscribe before minting proxies so a manager change during startup is replayed on bind.
			const mcpFollower = mcpManager ? followMCPTools(mcpManager) : undefined;
			const mcpProxyTools = mcpManager ? createMCPProxyTools(mcpManager) : [];

			let session: AgentSession;
			try {
				({ session } = await createAgentSession({
					cwd: restoredSeance?.cwd ?? ctx.session.sessionManager.getCwd(),
					costGate: ctx.session.costGate,
					authStorage: ctx.authStorage,
					// Copy live direct-parent policy; SDK preserves the child's recorded
					// automatic affinity unless the parent explicitly pinned an account.
					credentialSourceSessionId:
						(ref.parentId ? registry.get(ref.parentId)?.session?.sessionId : undefined) ??
						(ref.parentId === MAIN_AGENT_ID ? ctx.session.sessionId : undefined),
					// Revived agents join the root session tree, so their observability
					// frames ride the same bus the RPC/collab surfaces subscribed to.
					subagentEventBus: ctx.subagentEventBus,
					modelRegistry: ctx.modelRegistry,
					...(perCallModel ? { model: perCallModel, thinkingLevel: init.perCallThinkingLevel ?? undefined } : {}),
					...(persistedModelPattern ? { modelPattern: persistedModelPattern } : {}),
					modelPatternAuthFallback: restoredSeance || init.perCallModel ? undefined : init.resolvedModel,
					settings: subagentSettings,
					sessionManager: reopened,
					agentId: ref.id,
					agentDisplayName: ref.displayName,
					// `agents` rule scoping keys on the durable definition name (`scout`,
					// `reviewer`, …), not the registry display label — cold-revived refs
					// register with `displayName: id` (registry/persisted-agents.ts), so a
					// generated task id would silently drop every agent-scoped rule.
					// `init.agent` carries the real name; only files predating that field
					// fall back to the display label. A parked transcript may also predate
					// the `main`/`sub` definition-name reservation (discovery/helpers.ts): a
					// persisted `init.agent` of either sentinel value from such a legacy
					// custom agent must not masquerade as that sentinel here, so it falls
					// back to the display label too, keeping it scoped as an ordinary
					// subagent under its generated id instead of `main` or the shared `sub`
					// bucket.
					agentName:
						init.agent &&
						init.agent.trim().toLowerCase() !== MAIN_AGENT_RULE_NAME &&
						init.agent.trim().toLowerCase() !== SUB_AGENT_RULE_NAME
							? init.agent
							: ref.displayName,
					parentTaskPrefix: ref.id,
					asyncJobManager: ctx.session.asyncJobManager,
					parentAgentId: ref.parentId,
					oauthAccountPools,
					// A per-call model is held to the operator's current grants, not the transcript's,
					// never switches models, and keeps the live task.maxEffort ceiling the spawn ran under.
					...(assertApprovedModel
						? {
								thinkingLevelCeiling: cfgTaskMaxEffort.get(ctx.settings),
								disableModelFallback: true,
								disableServerSideFallback: true,
								assertDispatchModel: (model: Model) => {
									assertApprovedModel(model);
									assertModelSupportsEffortCeiling(model, cfgTaskMaxEffort.get(ctx.settings));
								},
							}
						: {}),
					expectedAgentRef: expectedRef,
					taskDepth,
					toolNames: revivedToolNames,
					outputSchema: init.outputSchema,
					outputSchemaMode: init.outputSchemaMode,
					restrictToolNames: restrictToolNames || undefined,
					requireYieldTool: structured,
					systemPrompt: () => [...init.systemPrompt],
					// Inherit current owner policy, never extension authority from a transcript.
					extensionRoots: () => ctx.session.effectiveExtensionRoots,
					preloadedPreparedExtensions: ctx.session.preparedExtensions,
					// Old files predate persisted spawns: deny re-spawning rather than let
					// createAgentSession default to wildcard ("*").
					spawns: init.spawns ?? "",
					hasUI: false,
					enableLsp: restrictToolNames ? false : ctx.enableLsp,
					...(restrictToolNames
						? {
								enableIrc: false,
								enableMCP: false,
								preloadedExtensionPaths: [],
								preloadedCustomToolPaths: [],
							}
						: {
								enableMCP: !mcpManager,
								mcpManager,
								mcpTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
							}),
					...seanceOptions,
				}));
			} catch (error) {
				mcpFollower?.dispose();
				throw error;
			}
			// A per-call worker runs only on its exact saved model, never a similarly named survivor.
			if (init.perCallModel) {
				try {
					const saved = init.perCallModelIdentity!;
					const identity = session.model ? formatModelStringWithRouting(session.model) : undefined;
					if (identity !== saved) {
						throw new PerCallModelError(
							`Cannot revive subagent "${ref.id}": its per-call model ${saved} is no longer available${identity ? ` (resolution found ${identity})` : ""}. A per-call worker revives only on its exact saved model.`,
						);
					}
					// An explicit unset selector must not inherit a new default while reviving.
					if (init.perCallThinkingLevel === null) session.setThinkingLevel(undefined);
				} catch (error) {
					mcpFollower?.dispose();
					await session.dispose();
					throw error;
				}
			}
			mcpFollower?.bind(session);
			// Clamp the active set to the persisted list: createAgentSession's
			// `alwaysInclude` can re-add non-defaultInactive extension/custom tools
			// the original run didn't carry. Unknown/missing names are ignored.
			await session.setActiveToolsByName(
				restoredSeance ? revivedToolNames : [...revivedToolNames, ...session.getMountedXdevToolNames()],
			);
			// The yield tool's schema carries the last batch's items; the replayed prefix must match it.
			if (init.workPoolYieldItems) await session.setWorkPoolYieldItems(init.workPoolYieldItems);
			// Wire the extension runtime exactly as the live executor does. Without
			// this the runner stays pre-init, every action method throws
			// `ExtensionRuntimeNotInitializedError`, and a `tool_call` handler that
			// touches a runtime action trips the fail-closed gate in `emitToolCall`,
			// blocking every tool — including the hidden `yield` — in the revived
			// agent. `session_start` also re-runs so extensions restore per-session
			// state (issue #8824).
			await initializeExtensions(session, {
				reportSendError: (action, err) => logger.error("Extension send failed", { action, error: err.message }),
				reportRuntimeError: err => logger.error("Extension error", { path: err.extensionPath, error: err.error }),
			});
			await replayRevivedAgentStart(session);
			// Cold revives must drive registry status themselves — createAgentSession
			// doesn't wire this generically (the live path does it in the executor).
			// The internal run-state signal precedes deferrable public `agent_end`,
			// keeping idle-TTL ownership synchronized even while prompts unwind.
			registry.syncSessionStatus(ref.id, session);
			attachIrcWakeTurnMonitor(session, {
				id: ref.id,
				agent: persistedAgentDefinition(ref.displayName, init),
				completionProbe: isCompletionProbeEnabled(ctx.settings, taskDepth - 1),
				eventBus: ctx.eventBus,
				subagentEventBus: ctx.subagentEventBus,
				sessionFile,
				structured,
				outputSchema: init.outputSchema,
				outputSchemaMode: init.outputSchemaMode,
				// Anchor artifacts to the revived ref's own dir (its parent's children
				// dir), not the live root session's, matching the spawn callers (#11563).
				artifactsDir: path.dirname(sessionFile),
			});
			return session;
		};
	};
}
