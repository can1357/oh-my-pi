/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { getOAuthProviders } from "@pk-nerdsaver-ai/pi-ai/oauth";
import { isZodSchema, zodToWireSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { $env, readJsonl, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { buildSkillPromptMessage } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import type { EventBus } from "../../utils/event-bus";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcResponse,
	RpcSessionState,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
): Promise<RpcSkillCommandResult | false> {
	if (!text.startsWith("/skill:")) return false;
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	const skillName = commandName.slice("skill:".length);
	const skill = session.skills.find(candidate => candidate.name === skillName);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, args);
	await session.promptCustomMessage({
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: built.message,
		display: true,
		details: built.details,
		attribution: "user",
	});
	return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (agentInvoked) return;
			await input.waitForExtensionAgentMessageTasks?.();
			if (!input.hasExtensionAgentMessageTask?.()) {
				input.output({ type: "prompt_result", id: input.id, agentInvoked: false });
			}
		})
		.catch(error => {
			input.onError(error instanceof Error ? error : new Error(String(error)));
		});
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: trackedPrompt.prompt,
		output: input.output,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}
/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new Map<string, PendingExtensionRequest>();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const subagentRegistry = eventBus ? new RpcSubagentRegistry(eventBus, output) : undefined;

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		/** Helper for dialog methods with signal/timeout support */
		#createDialogPromise<T>(
			opts: ExtensionUIDialogOptions | undefined,
			defaultValue: T,
			request: Record<string, unknown>,
			parseResponse: (response: RpcExtensionUIResponse) => T,
		): Promise<T> {
			if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

			const id = Snowflake.next() as string;
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			let timeoutId: NodeJS.Timeout | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pendingRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout !== undefined) {
				timeoutId = setTimeout(() => {
					opts.onTimeout?.();
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			this.pendingRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			this.output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
			return promise;
		}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{
					method: "select",
					title,
					options: options.map(getExtensionUISelectOptionLabel),
					timeout: dialogOptions?.timeout,
				},
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return this.#createDialogPromise(
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		reportSendError: (action, err) => {
			output(error(undefined, action, err.message));
		},
		reportRuntimeError: err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		onShutdown: () => {
			shutdownState.requested = true;
		},
		trackAgentInvokingMessage: task => {
			extensionUserMessageTracker.trackAgentMessageTask(task);
		},
		uiContext: rpcUiContext,
	});

	// Output all agent events as JSON
	session.subscribe(event => {
		output(event);
	});

	const getAvailableCommands = async () => buildAvailableSlashCommands(session);
	const reloadPluginState = async () => {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		session.setSlashCommands(await loadSlashCommands({ cwd }));
		await session.refreshSshTool({ activateIfAvailable: true });
		await emitAvailableCommandsUpdate();
	};
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	};
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	await emitAvailableCommandsUpdate();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				const skillResult = await tryRunRpcSkillCommand(session, command.message);
				if (skillResult) {
					return success(id, "prompt", skillResult);
				}
				const builtinResult = await executeAcpBuiltinSlashCommand(command.message, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: text => output({ type: "command_output", text }),
					refreshCommands: emitAvailableCommandsUpdate,
					reloadPlugins: reloadPluginState,
					notifyTitleChanged: async () => {
						output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
					},
					notifyConfigChanged: async () => {
						output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					},
				});
				if (builtinResult !== false) {
					if ("prompt" in builtinResult) {
						watchAndReportLocalOnlyPromptResult({
							id,
							startPrompt: () => session.prompt(builtinResult.prompt, { images: command.images }),
							output,
							onError: promptError => output(error(id, "prompt", promptError.message)),
							extensionUserMessageTracker,
						});
						return success(id, "prompt");
					}
					return success(id, "prompt", { agentInvoked: false });
				}

				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				watchAndReportLocalOnlyPromptResult({
					id,
					startPrompt: () =>
						session.prompt(command.message, {
							images: command.images,
							streamingBehavior: command.streamingBehavior,
						}),
					output,
					onError: promptError => output(error(id, "prompt", promptError.message)),
					extensionUserMessageTracker,
				});
				return success(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				session
					.prompt(command.message, { images: command.images })
					.catch(e => output(error(id, "abort_and_prompt", e.message)));
				return success(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch": {
				const result = await handleRpcSessionChange(session, command, subagentRegistry);
				if (!result.data.cancelled) await emitAvailableCommandsUpdate();
				return success(id, result.type, result.data);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: isZodSchema(tool.parameters) ? zodToWireSchema(tool.parameters) : tool.parameters,
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
				};
				return success(id, "get_state", state);
			}

			case "get_available_commands": {
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriBridge.setSchemes(command.schemes);
					return success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				if (!subagentRegistry) {
					return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				subagentRegistry.setSubscriptionLevel(command.level);
				return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) {
					return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = session.getAvailableModels();
				const model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
				}));
				return success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				// Track whether onAuth has fired. Providers that use OAuthCallbackFlow
				// always call onAuth first (emit browser URL), then onManualCodeInput as
				// a fallback. Providers that require interactive input (API-key paste,
				// GitHub Enterprise URL, device-code entry) call onPrompt before onAuth.
				// We use this ordering to self-classify at runtime — no static allowlist.
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: () => {
							if (!authEmitted) {
								// onPrompt called before any auth URL — provider requires
								// interactive input that cannot be satisfied headlessly.
								return Promise.reject(
									new Error(
										`Provider '${command.providerId}' requires interactive prompts ` +
											"which are not supported in RPC mode. Use the terminal UI to log in.",
									),
								);
							}
							// onAuth has already fired — we are inside OAuthCallbackFlow's
							// manual-redirect fallback race. Returning a never-settling promise
							// lets the race block until the callback server wins; a rejection
							// would be caught as null and spin the while(true) loop.
							return new Promise<string>(() => {});
						},
					});
					await session.modelRegistry.refresh();
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownState.requested) return;

		if (session.extensionRunner?.hasHandlers("session_shutdown")) {
			await session.extensionRunner.emit({ type: "session_shutdown" });
		}

		process.exit(0);
	}

	// Listen for JSON input using Bun's stdin
	for await (const parsed of readJsonl(Bun.stdin.stream())) {
		try {
			// Handle extension UI responses
			if ((parsed as RpcExtensionUIResponse).type === "extension_ui_response") {
				const response = parsed as RpcExtensionUIResponse;
				const pending = pendingExtensionRequests.get(response.id);
				if (pending) {
					pending.resolve(response);
				}
				continue;
			}

			if (isRpcHostToolResult(parsed)) {
				hostToolBridge.handleResult(parsed);
				continue;
			}

			if (isRpcHostToolUpdate(parsed)) {
				hostToolBridge.handleUpdate(parsed);
				continue;
			}

			if (isRpcHostUriResult(parsed)) {
				hostUriBridge.handleResult(parsed);
				continue;
			}

			// Handle regular commands
			const command = parsed as RpcCommand;
			const response = await handleCommand(command);
			output(response);

			// Check for deferred shutdown request (idle between commands)
			await checkShutdownRequested();
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			output(error(undefined, "parse", `Failed to parse command: ${message}`));
		}
	}

	// stdin closed — RPC client is gone, exit cleanly
	hostToolBridge.rejectAllPending("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	subagentRegistry?.dispose();
	process.exit(0);
}
