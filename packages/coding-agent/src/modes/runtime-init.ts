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
	/**
	 * Resolve `id` through {@link resolveInScope}, but first prefer a family
	 * member whose backing transcript is still reachable under
	 * `preferredSessionFile`'s own directory tree (see
	 * {@link isCurrentTranscriptRef}) over a stale same-family sibling left
	 * over from a `/new` or `ctx.switchSession()` transition. `scopeAgentId`
	 * stays the same across such a transition, so a persisted child
	 * registered from an OLD transcript remains this scope's descendant
	 * forever — `resolveInScope` alone can't tell it apart from a genuine
	 * current one. `get` and `prompt` have no explicit "which transcript"
	 * argument the way `ensureLive`'s `parentSessionFile` does, so they pass
	 * this scope's own live current transcript (`getScopeSessionFile()`)
	 * instead; falls back to `resolveInScope`'s plain match when no preferred
	 * transcript is known or no member backed by it exists.
	 */
	const resolveCurrent = (id: string, preferredSessionFile: string | null): string => {
		if (scopeAgentId !== undefined && preferredSessionFile !== null) {
			for (const memberId of collectAgentFamily(registry, scopeAgentId)) {
				const ref = registry.get(memberId);
				if (
					ref &&
					bareAgentId(memberId, ref.parentId) === id &&
					isCurrentTranscriptRef(ref, preferredSessionFile)
				) {
					return memberId;
				}
			}
		}
		return resolveInScope(id);
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
			const resolvedId = resolveCurrent(id, getScopeSessionFile?.() ?? null);
			if (!inScope(resolvedId)) return undefined;
			const ref = registry.get(resolvedId);
			return ref ? toExtensionAgentInfo(ref) : undefined;
		},
		agentsEnsureLive: async (id, agentOptions) => {
			const parentSessionFile = agentOptions?.parentSessionFile;
			const scanEligible = parentSessionFile !== undefined && isOwnSessionFile(parentSessionFile);
			// A live re-check of the same condition above, not a snapshot of it:
			// `registerPersistedSubagents` below can await filesystem I/O for a
			// while, and a `/new` or `ctx.switchSession()` completing during
			// that await moves `getScopeSessionFile()` on without rebuilding
			// this scope, leaving `scanEligible` stale. Kept as its own
			// function (rather than re-deriving `scanEligible`) so TypeScript's
			// aliased-condition narrowing of `parentSessionFile` below still
			// applies to `scanEligible`'s own definition.
			const ownsCurrentTranscript = (): boolean =>
				parentSessionFile !== undefined && isOwnSessionFile(parentSessionFile);
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
			// Scan whenever `id` resolves to no in-scope agent yet, or its only
			// in-scope match is stale: a foreign session can already hold the
			// bare id, or a same-family sibling from a superseded transcript can,
			// in which case the scan must still run so this session's own
			// CURRENT-transcript child can be registered under its disambiguated
			// key. Gate on the resolved `priorRef`, not the raw `id`: once that
			// disambiguated key is registered, the bare `id` still belongs to the
			// foreign session, and re-testing it would rescan the whole persisted
			// tree on every call. Only ever scan under a transcript verified to be
			// this scope's own — see `isOwnSessionFile`. `shouldContinue` re-checks
			// that ownership on every yield point inside the scan, so a session
			// transition mid-scan stops it from registering (and thus attributing
			// to this scope) anything more from the now-foreign transcript.
			if (scanEligible && (priorRef === undefined || stale)) {
				await registerPersistedSubagents(registry, parentSessionFile, {
					rootParentId: scopeAgentId,
					shouldContinue: ownsCurrentTranscript,
				});
			}
			// Revalidate after the scan: a scan the predicate above cut short can
			// leave `scanEligible` true while this scope no longer owns
			// `parentSessionFile`. Refuse rather than resolve against that
			// transcript: the scoped reviver reads live context, not a snapshot,
			// so reviving here would reopen an agent the caller asked for by the
			// transcript this scope just left under the NOW-current session's
			// cwd, settings, and artifact manager. This is the last check before
			// the revive; a transition that completes while the revive itself is
			// awaiting is not caught, and reopens an agent that is still in this
			// scope's family under the new context, as a later call may anyway.
			if (scanEligible && !ownsCurrentTranscript()) {
				throw new Error(`Agent "${id}" is not visible to this session.`);
			}
			// Re-resolve preferring a match still backed by the CURRENT transcript
			// over a stale same-family sibling: the rescanned `parentSessionFile`
			// when there was one, otherwise this scope's own live transcript —
			// the same preference `get` and `prompt` apply, so an option-less
			// call never revives a superseded generation they would not return.
			// Falls back to the plain in-scope resolution (possibly still that
			// stale ref, e.g. when the current transcript has no same-named child
			// at all) so an id unique to this session keeps resolving as before.
			const resolvedId = resolveCurrent(
				id,
				scanEligible ? (parentSessionFile ?? null) : (getScopeSessionFile?.() ?? null),
			);
			if (!inScope(resolvedId)) throw new Error(`Agent "${id}" is not visible to this session.`);
			await AgentLifecycleManager.global().ensureLive(resolvedId, coldRevive);
			const ref = registry.get(resolvedId);
			if (!ref) throw new Error(`agent ${id} not in registry after revive`);
			return toExtensionAgentInfo(ref);
		},
		agentsPrompt: async (id, text, agentOptions) => {
			const resolvedId = resolveCurrent(id, getScopeSessionFile?.() ?? null);
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
	/** Optional observer of every extension-originated send, turn-triggering or not. */
	trackExtensionSend?: (task: Promise<unknown>) => void;
	/** Optional filter applied to tool names an extension activates. */
	filterActiveTools?: (toolNames: string[]) => string[];
	/**
	 * Optional wrapper around extension-initiated session changes (new, branch,
	 * navigate, switch, reload), so the host can quiesce and reattach its own per-session
	 * state exactly as it does for its own session-change commands.
	 * `detachesRun` is true for changes that stop the running agent (new, switch);
	 * branch and navigation leave a live run streaming to its normal end.
	 */
	wrapSessionChange?: <T extends { cancelled: boolean }>(
		change: () => Promise<T>,
		options: { detachesRun: boolean },
	) => Promise<T>;
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
		trackExtensionSend,
		filterActiveTools,
		wrapSessionChange = change => change(),
		agentActionsScope,
	} = options;
	const shutdown = onShutdown ?? (() => {});

	runner.initialize(
		// ExtensionActions
		{
			sendMessage: (message, sendOptions) => {
				const sendTask = session.sendCustomMessage(message, sendOptions);
				trackExtensionSend?.(sendTask);
				if (sendOptions?.triggerTurn || sendOptions?.deliverAs === "aside") {
					// sendCustomMessage resolves `false` for outcomes that provably start no turn
					// (streaming queue, idle plan-mode fold, deferred ACP turn) — only a `true`
					// result should mark this send as agent-invoking, so downstream trackers (RPC's
					// hasAgentMessageTask) don't wait on agent events that will never arrive.
					const invokingTask = sendTask.then(started => {
						if (!started) throw new Error("send did not invoke the agent");
					});
					// A send that starts no turn (idle steer superseded by a concurrent turn,
					// plan-mode fold, deferred ACP turn) is a normal outcome, not a process error.
					// `trackAgentInvokingMessage` only attaches a handler while a prompt scope is
					// active (RpcExtensionUserMessageTracker); outside that window this rejection
					// would otherwise be unobserved and fatal the process. Mark it handled up front.
					invokingTask.catch(() => {});
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
				trackExtensionSend?.(sendTask);
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
			setActiveTools: (toolNames: string[]) =>
				session.setActiveToolsByName(filterActiveTools ? filterActiveTools(toolNames) : toolNames),
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
			runEphemeralTurn: args => session.runEphemeralTurn(args),
			compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
		},
		// ExtensionCommandContextActions — commands invokable via prompt("/command")
		{
			getContextUsage: () => session.getContextUsage(),
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: newOptions =>
				wrapSessionChange(
					async () => {
						const success = await session.newSession({ parentSession: newOptions?.parentSession });
						if (success && newOptions?.setup) {
							await newOptions.setup(session.sessionManager);
						}
						return { cancelled: !success };
					},
					{ detachesRun: true },
				),
			branch: entryId =>
				wrapSessionChange(
					async () => {
						const result = await session.branch(entryId);
						return { cancelled: result.cancelled };
					},
					{ detachesRun: false },
				),
			navigateTree: (targetId, navOptions) =>
				wrapSessionChange(
					async () => {
						const result = await session.navigateTree(targetId, { summarize: navOptions?.summarize });
						return { cancelled: result.cancelled };
					},
					{ detachesRun: false },
				),
			switchSession: sessionPath =>
				wrapSessionChange(
					async () => {
						const success = await session.switchSession(sessionPath);
						return { cancelled: !success };
					},
					{ detachesRun: true },
				),
			// Reload reopens the session file (as `session.reload()` does), detaching a live run;
			// it throws when cancelled, after the wrapper has seen the change as cancelled.
			reload: async () => {
				const result = await wrapSessionChange(
					async () => {
						// Without a session file reload is a no-op and nothing is detached.
						const sessionFile = session.sessionFile;
						if (!sessionFile) return { cancelled: true };
						return { cancelled: !(await session.switchSession(sessionFile)) };
					},
					{ detachesRun: true },
				);
				if (result.cancelled && session.sessionFile) throw new Error("Session reload cancelled");
			},
			compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
		},
		uiContext,
		mode,
	);

	runner.onError(reportRuntimeError);
	await runner.emit({ type: "session_start" });
}
