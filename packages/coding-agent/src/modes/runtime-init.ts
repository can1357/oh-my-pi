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

	runner.initialize(
		// ExtensionActions
		{
			sendMessage: (message, sendOptions) => {
				const sendTask = session.sendCustomMessage(message, sendOptions);
				if (sendOptions?.triggerTurn) {
					if (trackAgentInvokingMessage) {
						trackAgentInvokingMessage(sendTask);
					} else {
						markAgentInvokingMessage?.();
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
