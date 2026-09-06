/**
 * Shared extension runtime wiring for print and RPC modes.
 *
 * Both modes initialize the extension runner with the same action handlers
 * that delegate to the {@link AgentSession}. Only error reporting, shutdown
 * behavior, and UI context differ between callers — those stay as
 * caller-supplied hooks.
 */
import * as path from "node:path";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import type {
	ExtensionActions,
	ExtensionAgentInfo,
	ExtensionError,
	ExtensionMode,
	ExtensionUIContext,
} from "../extensibility/extensions/types";
import { AgentLifecycleManager, type PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import {
	type AgentRef,
	AgentRegistry,
	bareAgentId,
	collectAgentFamily,
	MAIN_AGENT_ID,
} from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import type { AgentSession } from "../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../session/messages";

function toExtensionAgentInfo(ref: AgentRef): ExtensionAgentInfo {
	return {
		id: ref.id,
		status: ref.status,
		kind: ref.kind,
		...(ref.sessionFile === null ? {} : { sessionFile: ref.sessionFile }),
	};
}

export interface ExtensionAgentActionsScope {
	/**
	 * Restrict `list`/`get`/`ensureLive`/`prompt` to this session's own id and
	 * its registry descendants — a subagent id is only unique within its owning
	 * top-level session's tree, so an unscoped view would let one session's
	 * extension inspect, revive, or message another session's agent in a host
	 * (ACP) that runs several concurrent top-level sessions in one process.
	 * Also attributes rescanned persisted children (`ensureLive`'s
	 * `parentSessionFile`) to this id instead of the {@link MAIN_AGENT_ID}
	 * default.
	 */
	scopeAgentId?: string;
	/**
	 * This session's own persisted transcript path, when known — the only
	 * lineage `ensureLive`'s `parentSessionFile` rescan is trusted to
	 * attribute discovered children to {@link scopeAgentId} under. Without
	 * this binding, a scoped caller could point the rescan at another loaded
	 * session's transcript (or a stale path left over from a session
	 * transition) and graft that session's persisted children into its own
	 * family, defeating the isolation {@link scopeAgentId} exists to enforce.
	 *
	 * Resolved on every call rather than captured once: a caller's session
	 * survives `/new`, `ctx.newSession()`, and `ctx.switchSession()` without
	 * this scope being rebuilt, so a snapshotted path would keep comparing
	 * against the transcript that was current when the scope was created —
	 * rejecting rescans of the session's actual current transcript while
	 * still trusting the stale one.
	 */
	getScopeSessionFile?: () => string | null;
	/**
	 * Session-scoped cold-revive support for a host that cannot install one
	 * process-global {@link PersistedSubagentReviverFactory} (ACP: concurrent
	 * top-level sessions each need their own ambient auth/model/settings).
	 * Overrides the global factory for revives triggered through these actions
	 * only; never touches process-global lifecycle state.
	 */
	reviverFactory?: PersistedSubagentReviverFactory;
	/** TTL applied when {@link reviverFactory} cold-revives a ref. Ignored without a reviverFactory; defaults to 0 (immediately re-parkable). */
	idleTtlMs?: number;
}

/** Actions shared by every extension host for process-global registry agents, optionally scoped to one session's own family. */
export function createExtensionAgentActions(
	scope: ExtensionAgentActionsScope = {},
): Required<Pick<ExtensionActions, "agentsList" | "agentsGet" | "agentsEnsureLive" | "agentsPrompt">> {
	const registry = AgentRegistry.global();
	const { scopeAgentId, getScopeSessionFile, reviverFactory, idleTtlMs } = scope;
	const inScope = (id: string): boolean =>
		scopeAgentId === undefined || collectAgentFamily(registry, scopeAgentId).has(id);
	/**
	 * A caller's own scoped view of a bare id can be shadowed by an unrelated
	 * session's identically-named agent: `AgentRegistry` is a flat,
	 * process-global map, but a subagent id is only unique within its owning
	 * session's own tree. `registerPersistedSubagentsFromDir` registers such a
	 * collision under a disambiguated key qualified against its (possibly
	 * itself already-qualified) parent — nesting a second collision one or
	 * more levels deep, e.g. `owner/Parent/Child` when `Parent` collided too.
	 * Rather than probing only the single-level `${scopeAgentId}/${id}` form,
	 * walk this session's own family for the member whose bare, unqualified
	 * leaf name (peeling off exactly one `${itsOwnParentId}/` prefix, however
	 * qualified that parent id itself is) equals `id`.
	 */
	const resolveInScope = (id: string): string => {
		if (scopeAgentId === undefined || inScope(id)) return id;
		for (const memberId of collectAgentFamily(registry, scopeAgentId)) {
			if (bareAgentId(memberId, registry.get(memberId)?.parentId) === id) return memberId;
		}
		return id;
	};
	/**
	 * Whether `file` is the transcript this scope is bound to — the only
	 * lineage `ensureLive` may attribute a rescan's discovered children to
	 * `scopeAgentId` under. An unscoped caller has no lineage to bind (it
	 * already sees the whole flat registry); a scoped caller with no known
	 * transcript of its own can never satisfy this, so the rescan is refused
	 * rather than trusting an unverifiable caller-supplied path.
	 */
	const isOwnSessionFile = (file: string): boolean => {
		if (scopeAgentId === undefined) return true;
		const own = getScopeSessionFile?.() ?? null;
		return own != null && path.resolve(file) === path.resolve(own);
	};
	/**
	 * Whether `ref`'s backing transcript is still reachable under
	 * `parentSessionFile`'s own directory tree (`<parentSessionFile without
	 * .jsonl>/**`). A ref with no persisted transcript yet (a live agent
	 * spawned this run, never scanned from disk) always passes — it has no
	 * stale generation to compare against. A ref whose transcript sits
	 * outside that tree is a same-family sibling kept alive only because it
	 * shares `scopeAgentId` across a `/new` or `ctx.switchSession()`
	 * transition, not an actual child of the CURRENT transcript.
	 */
	const isCurrentTranscriptRef = (ref: AgentRef, parentSessionFile: string): boolean => {
		if (ref.sessionFile === null) return true;
		const root = parentSessionFile.endsWith(".jsonl") ? parentSessionFile.slice(0, -6) : parentSessionFile;
		return path.resolve(ref.sessionFile).startsWith(`${path.resolve(root)}${path.sep}`);
	};
	const coldRevive = reviverFactory ? { reviverFactory, idleTtlMs } : undefined;
	return {
		agentsList: () => {
			if (scopeAgentId === undefined) return registry.list().map(toExtensionAgentInfo);
			const family = collectAgentFamily(registry, scopeAgentId);
			return registry
				.list()
				.filter(ref => family.has(ref.id))
				.map(toExtensionAgentInfo);
		},
		agentsGet: id => {
			const resolvedId = resolveInScope(id);
			if (!inScope(resolvedId)) return undefined;
			const ref = registry.get(resolvedId);
			return ref ? toExtensionAgentInfo(ref) : undefined;
		},
		agentsEnsureLive: async (id, agentOptions) => {
			const parentSessionFile = agentOptions?.parentSessionFile;
			const scanEligible = parentSessionFile !== undefined && isOwnSessionFile(parentSessionFile);
			// `scopeAgentId` stays the same across a `/new` or
			// `ctx.switchSession()` transition, so a persisted child registered
			// from an OLD transcript remains this scope's descendant forever —
			// `inScope` alone can't tell it apart from a genuine current child.
			// Compare the resolved match's own lineage against the CURRENT
			// `parentSessionFile` instead of trusting any in-scope id as already
			// registered for the current transcript.
			const priorMatch = resolveInScope(id);
			const priorRef = inScope(priorMatch) ? registry.get(priorMatch) : undefined;
			const stale =
				scopeAgentId !== undefined &&
				scanEligible &&
				priorRef !== undefined &&
				!isCurrentTranscriptRef(priorRef, parentSessionFile);
			// Scan (not just a bare registry miss) whenever `id` isn't yet ours,
			// or its only in-scope match is stale: a foreign session can already
			// hold the bare id, or a same-family sibling from a superseded
			// transcript can, in which case the scan must still run so this
			// session's own CURRENT-transcript child can be registered under its
			// disambiguated key. Only ever scan under a transcript verified to be
			// this scope's own — see `isOwnSessionFile`.
			if (scanEligible && (!inScope(id) || stale)) {
				await registerPersistedSubagents(registry, parentSessionFile, { rootParentId: scopeAgentId });
			}
			// Re-resolve preferring a match still backed by the CURRENT transcript
			// over a stale same-family sibling; fall back to the prior resolution
			// (possibly still that stale ref, e.g. when the current transcript has
			// no same-named child at all) so an id unique to this session keeps
			// resolving exactly as before.
			let resolvedId = priorMatch;
			if (scopeAgentId !== undefined && scanEligible) {
				for (const memberId of collectAgentFamily(registry, scopeAgentId)) {
					const ref = registry.get(memberId);
					if (
						ref &&
						bareAgentId(memberId, ref.parentId) === id &&
						isCurrentTranscriptRef(ref, parentSessionFile)
					) {
						resolvedId = memberId;
						break;
					}
				}
			}
			if (!inScope(resolvedId)) throw new Error(`Agent "${id}" is not visible to this session.`);
			await AgentLifecycleManager.global().ensureLive(resolvedId, coldRevive);
			const ref = registry.get(resolvedId);
			if (!ref) throw new Error(`agent ${id} not in registry after revive`);
			return toExtensionAgentInfo(ref);
		},
		agentsPrompt: async (id, text, agentOptions) => {
			const resolvedId = resolveInScope(id);
			if (!inScope(resolvedId)) throw new Error(`Agent "${id}" is not visible to this session.`);
			const liveSession = await AgentLifecycleManager.global().ensureLive(resolvedId, coldRevive);
			await liveSession.prompt(text, { streamingBehavior: agentOptions?.deliverAs ?? "steer" });
		},
	};
}

/** Action name for an extension-originated send failure. */
export type ExtensionSendAction = "extension_send" | "extension_send_user";

export interface InitializeExtensionsOptions {
	/** Reports an error thrown by an extension-initiated send. */
	reportSendError: (action: ExtensionSendAction, error: Error) => void;
	/** Reports a runtime error surfaced through {@link ExtensionRunner.onError}. */
	reportRuntimeError: (error: ExtensionError) => void;
	/** Optional shutdown hook (rpc mode signals its loop; print mode is a no-op). */
	onShutdown?: () => void;
	/** Pi-compatible mode exposed to extension contexts. Defaults to `"print"`. */
	mode?: ExtensionMode;
	/** Optional UI context (rpc supplies one; print runs headless). */
	uiContext?: ExtensionUIContext;
	/** Optional lifecycle hook for extension-originated messages that can start an agent turn. */
	markAgentInvokingMessage?: () => void;
	/** Optional lifecycle hook for extension-originated sends whose success/failure determines turn ownership. */
	trackAgentInvokingMessage?: (task: Promise<unknown>) => void;
	/**
	 * Overrides the cold-revive support passed to {@link createExtensionAgentActions}.
	 * A host with no process-global {@link PersistedSubagentReviverFactory} (ACP)
	 * must carry its session-scoped reviver into every subsequent
	 * `initializeExtensions` call for the SAME session lineage — persisted-revive
	 * cold revival of a subagent, or a warm re-init after `/new`/reload — or that
	 * call's own `api.agents.ensureLive` for ITS persisted children fails with
	 * "no reviver registered".
	 */
	agentActionsScope?: Pick<ExtensionAgentActionsScope, "reviverFactory" | "idleTtlMs">;
}

/**
 * Initialize the session's extension runner with the standard action set
 * shared by non-interactive modes, then emit `session_start`.
 *
 * No-op when the session was constructed without an extension runner.
 */
export async function initializeExtensions(session: AgentSession, options: InitializeExtensionsOptions): Promise<void> {
	const runner = session.extensionRunner;
	if (!runner) return;

	const {
		reportSendError,
		reportRuntimeError,
		onShutdown,
		mode = "print",
		uiContext,
		markAgentInvokingMessage,
		trackAgentInvokingMessage,
		agentActionsScope,
	} = options;
	const shutdown = onShutdown ?? (() => {});

	runner.initialize(
		// ExtensionActions
		{
			sendMessage: (message, sendOptions) => {
				const sendTask = session.sendCustomMessage(message, sendOptions);
				if (sendOptions?.triggerTurn || sendOptions?.deliverAs === "aside") {
					// sendCustomMessage resolves `false` for outcomes that provably start no turn
					// (streaming queue, idle plan-mode fold, deferred ACP turn) — only a `true`
					// result should mark this send as agent-invoking, so downstream trackers (RPC's
					// hasAgentMessageTask) don't wait on agent events that will never arrive.
					const invokingTask = sendTask.then(started => {
						if (!started) throw new Error("send did not invoke the agent");
					});
					if (trackAgentInvokingMessage) {
						trackAgentInvokingMessage(invokingTask);
					} else {
						invokingTask.then(
							() => markAgentInvokingMessage?.(),
							() => {},
						);
					}
				}
				sendTask.catch(e => {
					reportSendError("extension_send", e instanceof Error ? e : new Error(String(e)));
				});
			},
			sendUserMessage: (content, sendOptions) => {
				const sendTask = session.sendUserMessage(content, sendOptions);
				if (trackAgentInvokingMessage) {
					trackAgentInvokingMessage(sendTask);
				} else {
					markAgentInvokingMessage?.();
				}
				sendTask.catch(e => {
					reportSendError("extension_send_user", e instanceof Error ? e : new Error(String(e)));
				});
			},
			appendEntry: (customType, data) => {
				session.sessionManager.appendCustomEntry(customType, data);
			},
			...createExtensionAgentActions({
				scopeAgentId: session.getAgentId() ?? MAIN_AGENT_ID,
				getScopeSessionFile: () => session.sessionManager?.getSessionFile?.() ?? null,
				...agentActionsScope,
			}),
			setLabel: (targetId, label) => {
				session.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => session.getEnabledToolNames(),
			getAllTools: () => session.getAllToolInfos(),
			setActiveTools: (toolNames: string[]) => session.setActiveToolsByName(toolNames),
			getCommands: () => getSessionSlashCommands(session),
			setModel: model => runExtensionSetModel(session, model),
			getThinkingLevel: () => session.thinkingLevel,
			setThinkingLevel: level => session.setThinkingLevel(level),
			getServiceTiers: () => session.serviceTierByFamily,
			setServiceTier: (family, tier) => session.setServiceTierFamily(family, tier),
			getSessionName: () => session.sessionManager.getSessionName(),
			setSessionName: async name => {
				await session.sessionManager.setSessionName(name, "user");
			},
		},
		// ExtensionContextActions
		{
			getModel: () => session.model,
			isIdle: () => !session.isStreaming,
			abort: () => session.abort({ reason: USER_INTERRUPT_LABEL }),
			hasPendingMessages: () => session.queuedMessageCount > 0,
			shutdown,
			getContextUsage: () => session.getContextUsage(),
			getSystemPrompt: () => session.systemPrompt,
			compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
		},
		// ExtensionCommandContextActions — commands invokable via prompt("/command")
		{
			getContextUsage: () => session.getContextUsage(),
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async newOptions => {
				const success = await session.newSession({ parentSession: newOptions?.parentSession });
				if (success && newOptions?.setup) {
					await newOptions.setup(session.sessionManager);
				}
				return { cancelled: !success };
			},
			branch: async entryId => {
				const result = await session.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, navOptions) => {
				const result = await session.navigateTree(targetId, { summarize: navOptions?.summarize });
				return { cancelled: result.cancelled };
			},
			switchSession: async sessionPath => {
				const success = await session.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await session.reload();
			},
			compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
		},
		uiContext,
		mode,
	);

	runner.onError(reportRuntimeError);
	await runner.emit({ type: "session_start" });
}
