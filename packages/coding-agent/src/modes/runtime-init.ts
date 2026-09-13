/**
 * Shared extension runtime wiring for print and RPC modes.
 *
 * Both modes initialize the extension runner with the same action handlers
 * that delegate to the {@link AgentSession}. Only error reporting, shutdown
 * behavior, and UI context differ between callers — those stay as
 * caller-supplied hooks.
 */
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import type { ExtensionError, ExtensionMode, ExtensionUIContext } from "../extensibility/extensions/types";
import type { AgentSession } from "../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../session/messages";

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
	} = options;
	const shutdown = onShutdown ?? (() => {});

	// resources_discover and session_start handlers share this action context, so
	// a handler calling sendMessage/sendUserMessage starts an async session send
	// that the action itself does not expose a promise for (callers only see
	// trackAgentInvokingMessage/markAgentInvokingMessage side effects). Track
	// every such send here so callers can drain them before proceeding — matching
	// the task executor's equivalent queue (executor.ts, `pendingExtensionMessages`).
	const pendingExtensionSends: Promise<unknown>[] = [];
	const drainPendingExtensionSends = async (): Promise<void> => {
		while (pendingExtensionSends.length > 0) {
			await Promise.all(pendingExtensionSends.splice(0));
		}
	};
	// A `session_start` handler can call sendMessage/sendUserMessage synchronously,
	// starting the underlying session call — and, for a triggered turn, its system
	// prompt read — before `discoverStartupSkillPaths()` below has folded any
	// extension-contributed skill directories into the snapshot (PR #9379 review).
	// Gate every `session_start`-originated dispatch on discovery completing so
	// that turn sees the same skills a prompt issued after startup would.
	// `resources_discover` fires from inside `discoverStartupSkillPaths()` itself
	// — gating its own handler's sends on the same promise would deadlock, so
	// dispatch bypasses the gate once discovery is underway.
	let discoveryInFlight = false;
	let releaseDiscoveryGate!: () => void;
	const discoveryGate = new Promise<void>(resolve => {
		releaseDiscoveryGate = resolve;
	});
	const afterDiscovery = <T>(dispatch: () => Promise<T>): Promise<T> =>
		discoveryInFlight ? dispatch() : discoveryGate.then(dispatch);

	runner.initialize(
		// ExtensionActions
		{
			sendMessage: (message, sendOptions) => {
				const sendTask = afterDiscovery(() => session.sendCustomMessage(message, sendOptions));
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
				pendingExtensionSends.push(
					sendTask.catch(e => {
						reportSendError("extension_send", e instanceof Error ? e : new Error(String(e)));
					}),
				);
			},
			sendUserMessage: (content, sendOptions) => {
				const sendTask = afterDiscovery(() => session.sendUserMessage(content, sendOptions));
				if (trackAgentInvokingMessage) {
					trackAgentInvokingMessage(sendTask);
				} else {
					markAgentInvokingMessage?.();
				}
				pendingExtensionSends.push(
					sendTask.catch(e => {
						reportSendError("extension_send_user", e instanceof Error ? e : new Error(String(e)));
					}),
				);
			},
			appendEntry: (customType, data) => {
				session.sessionManager.appendCustomEntry(customType, data);
			},
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
	// resources_discover fires after `session_start` per its public contract
	// (extensibility/extensions/types.ts) — only now are runtime actions and
	// `onError` wired, so extension-contributed skill directories are folded
	// into the session's skill snapshot before any session_start-triggered send
	// actually dispatches (the `discoveryGate` above), and before the first
	// prompt.
	discoveryInFlight = true;
	await session.discoverStartupSkillPaths();
	releaseDiscoveryGate();
	// A session_start handler's sendMessage/sendUserMessage call, and any
	// resources_discover handler's own send, share this action context and
	// never expose their promise to the caller — drain both here so every
	// extension-triggered send is settled before returning. Without this the
	// caller (print mode's immediate session.prompt(), print-mode.ts) can
	// observe the session as still streaming and throw AgentBusyError, or
	// reorder the initial turn.
	await drainPendingExtensionSends();
}
