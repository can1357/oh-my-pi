/**
 * Worker thread for subagent execution.
 *
 * This worker runs in a separate thread via Bun's Worker API. It creates a minimal
 * AgentSession and forwards events back to the parent thread.
 *
 * ## Event Flow
 *
 * 1. Parent sends { type: "start", payload } with task config
 * 2. Worker creates AgentSession and subscribes to events
 * 3. Worker forwards AgentEvent messages via postMessage
 * 4. Worker sends { type: "done", exitCode, ... } on completion
 * 5. Parent can send { type: "abort" } to request cancellation
 */

import type { AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import type { AgentSessionEvent } from "../../agent-session";
import { AuthStorage } from "../../auth-storage";
import type { CustomTool } from "../../custom-tools/types";
import { ModelRegistry } from "../../model-registry";
import { parseModelPattern, parseModelString } from "../../model-resolver";
import { createAgentSession, discoverAuthStorage, discoverModels } from "../../sdk";
import { SessionManager } from "../../session-manager";
import { SettingsManager } from "../../settings-manager";
import { untilAborted } from "../../utils";
import { createPythonTool, type PythonProxyExecutor, type PythonToolDetails, type PythonToolParams } from "../python";
import type {
	MCPToolCallResponse,
	MCPToolMetadata,
	PythonToolCallResponse,
	SubagentWorkerRequest,
	SubagentWorkerResponse,
	SubagentWorkerStartPayload,
} from "./worker-protocol";

type PostMessageFn = (message: SubagentWorkerResponse) => void;

const postMessageSafe: PostMessageFn = (message) => {
	try {
		(globalThis as typeof globalThis & { postMessage: PostMessageFn }).postMessage(message);
	} catch {
		// Parent may have terminated worker, nothing we can do
	}
};

interface PendingMCPCall {
	resolve: (result: MCPToolCallResponse["result"]) => void;
	reject: (error: Error) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingPythonCall {
	resolve: (result: PythonToolCallResponse["result"]) => void;
	reject: (error: Error) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

const pendingMCPCalls = new Map<string, PendingMCPCall>();
const pendingPythonCalls = new Map<string, PendingPythonCall>();
const MCP_CALL_TIMEOUT_MS = 60_000;
const PYTHON_CALL_TIMEOUT_MS = 300_000;
let mcpCallIdCounter = 0;
let pythonCallIdCounter = 0;

function generateMCPCallId(): string {
	return `mcp_${Date.now()}_${++mcpCallIdCounter}`;
}

function generatePythonCallId(): string {
	return `python_${Date.now()}_${++pythonCallIdCounter}`;
}

function callMCPToolViaParent(
	toolName: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	timeoutMs = MCP_CALL_TIMEOUT_MS,
): Promise<{ content: Array<{ type: string; text?: string; [key: string]: unknown }>; isError?: boolean }> {
	return new Promise((resolve, reject) => {
		const callId = generateMCPCallId();
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const timeoutId = setTimeout(() => {
			pendingMCPCalls.delete(callId);
			reject(new Error(`MCP call timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		const cleanup = () => {
			clearTimeout(timeoutId);
			pendingMCPCalls.delete(callId);
		};

		signal?.addEventListener(
			"abort",
			() => {
				cleanup();
				reject(new Error("Aborted"));
			},
			{ once: true },
		);

		pendingMCPCalls.set(callId, {
			resolve: (result) => {
				cleanup();
				resolve(result ?? { content: [] });
			},
			reject: (error) => {
				cleanup();
				reject(error);
			},
			timeoutId,
		});

		postMessageSafe({
			type: "mcp_tool_call",
			callId,
			toolName,
			params,
		} as SubagentWorkerResponse);
	});
}

function callPythonToolViaParent(
	params: PythonToolParams,
	signal?: AbortSignal,
	timeoutMs = PYTHON_CALL_TIMEOUT_MS,
): Promise<PythonToolCallResponse["result"]> {
	return new Promise((resolve, reject) => {
		const callId = generatePythonCallId();
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const timeoutId = setTimeout(() => {
			pendingPythonCalls.delete(callId);
			reject(new Error(`Python call timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		const cleanup = () => {
			clearTimeout(timeoutId);
			pendingPythonCalls.delete(callId);
		};

		signal?.addEventListener(
			"abort",
			() => {
				cleanup();
				reject(new Error("Aborted"));
			},
			{ once: true },
		);

		pendingPythonCalls.set(callId, {
			resolve: (result) => {
				cleanup();
				resolve(result ?? { content: [] });
			},
			reject: (error) => {
				cleanup();
				reject(error);
			},
			timeoutId,
		});

		postMessageSafe({
			type: "python_tool_call",
			callId,
			params,
		} as SubagentWorkerResponse);
	});
}

function handleMCPToolResult(response: MCPToolCallResponse): void {
	const pending = pendingMCPCalls.get(response.callId);
	if (!pending) return;
	if (response.error) {
		pending.reject(new Error(response.error));
	} else {
		pending.resolve(response.result);
	}
}

function handlePythonToolResult(response: PythonToolCallResponse): void {
	const pending = pendingPythonCalls.get(response.callId);
	if (!pending) return;
	if (response.error) {
		pending.reject(new Error(response.error));
	} else {
		pending.resolve(response.result);
	}
}

function createMCPProxyTool(metadata: MCPToolMetadata): CustomTool<TSchema> {
	return {
		name: metadata.name,
		label: metadata.label,
		description: metadata.description,
		parameters: metadata.parameters as TSchema,
		execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
			try {
				const result = await callMCPToolViaParent(
					metadata.name,
					params as Record<string, unknown>,
					signal,
					metadata.timeoutMs,
				);
				return {
					content: result.content.map((c) =>
						c.type === "text"
							? { type: "text" as const, text: c.text ?? "" }
							: { type: "text" as const, text: JSON.stringify(c) },
					),
					details: { serverName: metadata.serverName, mcpToolName: metadata.mcpToolName, isError: result.isError },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `MCP error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: { serverName: metadata.serverName, mcpToolName: metadata.mcpToolName, isError: true },
				};
			}
		},
	};
}

function getPythonCallTimeoutMs(params: PythonToolParams): number {
	const timeout = params.timeout;
	if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) {
		return timeout * 1000 + 5000;
	}
	return PYTHON_CALL_TIMEOUT_MS;
}

const pythonProxyExecutor: PythonProxyExecutor = async (params, signal) => {
	const timeoutMs = getPythonCallTimeoutMs(params);
	const result = await callPythonToolViaParent(params, signal, timeoutMs);
	return {
		content:
			result?.content?.map((c) =>
				c.type === "text"
					? { type: "text" as const, text: c.text ?? "" }
					: { type: "text" as const, text: JSON.stringify(c) },
			) ?? [],
		details: result?.details as PythonToolDetails | undefined,
	};
};

interface WorkerMessageEvent<T> {
	data: T;
}

/** Agent event types to forward to parent (excludes session-only events like compaction) */
const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent => {
	return agentEventTypes.has(event.type as AgentEvent["type"]);
};

interface RunState {
	abortController: AbortController;
	startTime: number;
	session: { abort: () => Promise<void>; dispose: () => Promise<void> } | null;
	unsubscribe: (() => void) | null;
	sendDoneOnce: (message: Extract<SubagentWorkerResponse, { type: "done" }>) => void;
}

const createSendDoneOnce = (): RunState["sendDoneOnce"] => {
	let sent = false;
	return (message) => {
		if (sent) return;
		sent = true;
		postMessageSafe(message);
	};
};

const createRunState = (): RunState => ({
	abortController: new AbortController(),
	startTime: Date.now(),
	session: null,
	unsubscribe: null,
	sendDoneOnce: createSendDoneOnce(),
});

let activeRun: RunState | null = null;
let pendingAbort = false;

/**
 * Resolve model string to Model object with optional thinking level.
 * Supports both exact "provider/id" format and fuzzy matching ("sonnet", "opus").
 */
function resolveModelOverride(
	override: string | undefined,
	modelRegistry: { getAvailable: () => Model<Api>[]; find: (provider: string, id: string) => Model<Api> | undefined },
): { model?: Model<Api>; thinkingLevel?: ThinkingLevel } {
	if (!override) return {};

	// Try exact "provider/id" format first
	const parsed = parseModelString(override);
	if (parsed) {
		return { model: modelRegistry.find(parsed.provider, parsed.id) };
	}

	// Fall back to fuzzy pattern matching
	const result = parseModelPattern(override, modelRegistry.getAvailable());
	return {
		model: result.model,
		thinkingLevel: result.thinkingLevel !== "off" ? result.thinkingLevel : undefined,
	};
}

/**
 * Main task execution function.
 *
 * Equivalent to CLI flow:
 * 1. omp --mode json --non-interactive
 * 2. --append-system-prompt <agent.systemPrompt>
 * 3. --tools <toolNames> (if specified)
 * 4. --model <model> (if specified)
 * 5. --session <sessionFile> OR --no-session
 * 6. --prompt <task>
 *
 * Environment equivalent:
 * - OMP_BLOCKED_AGENT: payload.blockedAgent (prevents same-agent recursion)
 * - OMP_SPAWNS: payload.spawnsEnv (controls nested spawn permissions)
 */
async function runTask(runState: RunState, payload: SubagentWorkerStartPayload): Promise<void> {
	const { signal } = runState.abortController;
	const startTime = runState.startTime;
	let exitCode = 0;
	let error: string | undefined;
	let aborted = false;
	const sessionAbortController = new AbortController();

	// Helper to check abort status - throws if aborted to exit early
	const checkAbort = (): void => {
		if (signal.aborted) {
			aborted = true;
			exitCode = 1;
			throw new Error("Aborted");
		}
	};

	try {
		// Check for pre-start abort
		checkAbort();

		// Set working directory (CLI does this implicitly)
		process.chdir(payload.cwd);

		// Use serialized auth/models if provided, otherwise discover from disk
		let authStorage: AuthStorage;
		let modelRegistry: ModelRegistry;

		if (payload.serializedAuth && payload.serializedModels) {
			authStorage = AuthStorage.fromSerialized(payload.serializedAuth);
			modelRegistry = ModelRegistry.fromSerialized(payload.serializedModels, authStorage);
		} else {
			authStorage = await discoverAuthStorage();
			checkAbort();
			modelRegistry = await discoverModels(authStorage);
			checkAbort();
		}

		// Create MCP/python proxy tools if provided
		const mcpProxyTools = payload.mcpTools?.map(createMCPProxyTool) ?? [];
		const pythonProxyTools = payload.pythonToolProxy
			? [createPythonTool(null, { proxyExecutor: pythonProxyExecutor })]
			: [];
		const proxyTools = [...mcpProxyTools, ...pythonProxyTools];

		// Resolve model override (equivalent to CLI's parseModelPattern with --model)
		const { model, thinkingLevel: modelThinkingLevel } = resolveModelOverride(payload.model, modelRegistry);
		const thinkingLevel = modelThinkingLevel ?? payload.thinkingLevel;

		// Create session manager (equivalent to CLI's --session or --no-session)
		const sessionManager = payload.sessionFile
			? await SessionManager.open(payload.sessionFile)
			: SessionManager.inMemory(payload.cwd);
		checkAbort();

		// Use serialized settings if provided, otherwise use empty in-memory settings
		// This avoids opening the SQLite database in worker threads
		const settingsManager = SettingsManager.inMemory(payload.serializedSettings ?? {});

		// Create agent session (equivalent to CLI's createAgentSession)
		// Note: hasUI: false disables interactive features
		const completionInstruction =
			"When finished, call the complete tool exactly once. Do not end with a plain-text final answer.";

		const { session } = await createAgentSession({
			cwd: payload.cwd,
			authStorage,
			modelRegistry,
			settingsManager,
			model,
			thinkingLevel,
			toolNames: payload.toolNames,
			outputSchema: payload.outputSchema,
			requireCompleteTool: true,
			// Append system prompt (equivalent to CLI's --append-system-prompt)
			systemPrompt: (defaultPrompt) => `${defaultPrompt}\n\n${payload.systemPrompt}\n\n${completionInstruction}`,
			sessionManager,
			hasUI: false,
			// Pass spawn restrictions to nested tasks
			spawns: payload.spawnsEnv,
			enableLsp: payload.enableLsp ?? true,
			// Disable local MCP discovery if using proxy tools
			enableMCP: !payload.mcpTools,
			// Add proxy tools
			customTools: proxyTools.length > 0 ? proxyTools : undefined,
		});

		runState.session = session;
		checkAbort();

		signal.addEventListener(
			"abort",
			() => {
				void session.abort();
			},
			{ once: true, signal: sessionAbortController.signal },
		);

		// Initialize extensions (equivalent to CLI's extension initialization)
		// Note: Does not support --extension CLI flag or extension CLI flags
		const extensionRunner = session.extensionRunner;
		if (extensionRunner) {
			extensionRunner.initialize(
				// ExtensionActions
				{
					sendMessage: (message, options) => {
						session.sendCustomMessage(message, options).catch((e) => {
							console.error(`Extension sendMessage failed: ${e instanceof Error ? e.message : String(e)}`);
						});
					},
					sendUserMessage: (content, options) => {
						session.sendUserMessage(content, options).catch((e) => {
							console.error(`Extension sendUserMessage failed: ${e instanceof Error ? e.message : String(e)}`);
						});
					},
					appendEntry: (customType, data) => {
						session.sessionManager.appendCustomEntry(customType, data);
					},
					setLabel: (targetId, label) => {
						session.sessionManager.appendLabelChange(targetId, label);
					},
					getActiveTools: () => session.getActiveToolNames(),
					getAllTools: () => session.getAllToolNames(),
					setActiveTools: (toolNames: string[]) => session.setActiveToolsByName(toolNames),
					setModel: async (model) => {
						const key = await session.modelRegistry.getApiKey(model);
						if (!key) return false;
						await session.setModel(model);
						return true;
					},
					getThinkingLevel: () => session.thinkingLevel,
					setThinkingLevel: (level) => session.setThinkingLevel(level),
				},
				// ExtensionContextActions
				{
					getModel: () => session.model,
					isIdle: () => !session.isStreaming,
					abort: () => session.abort(),
					hasPendingMessages: () => session.queuedMessageCount > 0,
					shutdown: () => {},
					getContextUsage: () => session.getContextUsage(),
					compact: async (instructionsOrOptions) => {
						const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
						const options =
							instructionsOrOptions && typeof instructionsOrOptions === "object"
								? instructionsOrOptions
								: undefined;
						await session.compact(instructions, options);
					},
				},
			);
			extensionRunner.onError((err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			});
			await extensionRunner.emit({ type: "session_start" });
		}

		// Track complete tool calls
		const MAX_COMPLETE_RETRIES = 3;
		let completeCalled = false;

		// Subscribe to events and forward to parent (equivalent to --mode json output)
		runState.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (isAgentEvent(event)) {
				postMessageSafe({ type: "event", event });
				// Track when complete tool is called
				if (event.type === "tool_execution_end" && event.toolName === "complete") {
					completeCalled = true;
				}
			}
		});

		// Run the prompt (equivalent to --prompt flag)
		await session.prompt(payload.task);

		// Retry loop if complete was not called
		let retryCount = 0;
		while (!completeCalled && retryCount < MAX_COMPLETE_RETRIES && !signal.aborted) {
			retryCount++;
			const reminder = `<system-reminder>
CRITICAL: You stopped without calling the complete tool. This is reminder ${retryCount} of ${MAX_COMPLETE_RETRIES}.

You MUST call the complete tool to finish your task. Options:
1. Call complete with your result data if you have completed the task
2. Call complete with status="aborted" and an error message if you cannot complete the task

Failure to call complete after ${MAX_COMPLETE_RETRIES} reminders will result in task failure.
</system-reminder>

Call complete now.`;

			await session.prompt(reminder);
		}

		// Check if aborted during execution
		const lastMessage = session.state.messages[session.state.messages.length - 1];
		if (lastMessage?.role === "assistant" && lastMessage.stopReason === "aborted") {
			aborted = true;
			exitCode = 1;
		}
	} catch (err) {
		exitCode = 1;
		// Don't record abort as error - it's handled via the aborted flag
		if (!signal.aborted) {
			error = err instanceof Error ? err.stack || err.message : String(err);
		}
	} finally {
		// Handle abort requested during execution
		if (signal.aborted) {
			aborted = true;
			if (exitCode === 0) exitCode = 1;
		}

		sessionAbortController.abort();

		if (runState.unsubscribe) {
			try {
				runState.unsubscribe();
			} catch {
				// Ignore unsubscribe errors
			}
			runState.unsubscribe = null;
		}

		// Cleanup session with timeout to prevent hanging
		if (runState.session) {
			const session = runState.session;
			runState.session = null;
			try {
				await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
			} catch {
				// Ignore cleanup errors
			}
		}

		if (activeRun === runState) {
			activeRun = null;
		}

		// Send completion message to parent (only once)
		runState.sendDoneOnce({
			type: "done",
			exitCode,
			durationMs: Date.now() - startTime,
			error,
			aborted,
		});
	}
}

/** Handle abort request from parent */
function handleAbort(): void {
	const runState = activeRun;
	if (!runState) {
		pendingAbort = true;
		return;
	}
	runState.abortController.abort();
	if (runState.session) {
		void runState.session.abort();
	}
}

const reportFatal = (message: string): void => {
	const runState = activeRun;
	if (runState) {
		runState.abortController.abort();
		if (runState.session) {
			void runState.session.abort();
		}
		runState.sendDoneOnce({
			type: "done",
			exitCode: 1,
			durationMs: Date.now() - runState.startTime,
			error: message,
			aborted: false,
		});
		return;
	}

	postMessageSafe({
		type: "done",
		exitCode: 1,
		durationMs: 0,
		error: message,
		aborted: false,
	});
};

// Global error handlers to ensure we always send a done message
// Using self instead of globalThis for proper worker scope typing
declare const self: {
	addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
	addEventListener(type: "unhandledrejection", listener: (event: { reason: unknown }) => void): void;
	addEventListener(type: "messageerror", listener: (event: MessageEvent) => void): void;
};

self.addEventListener("error", (event) => {
	reportFatal(`Uncaught error: ${event.message || "Unknown error"}`);
});

self.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason;
	const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
	reportFatal(`Unhandled rejection: ${message}`);
});

self.addEventListener("messageerror", () => {
	reportFatal("Failed to deserialize parent message");
});

// Message handler - receives start/abort/mcp_tool_result commands from parent
globalThis.addEventListener("message", (event: WorkerMessageEvent<SubagentWorkerRequest>) => {
	const message = event.data;
	if (!message) return;

	if (message.type === "abort") {
		handleAbort();
		return;
	}

	if (message.type === "mcp_tool_result") {
		handleMCPToolResult(message);
		return;
	}

	if (message.type === "python_tool_result") {
		handlePythonToolResult(message);
		return;
	}

	if (message.type === "start") {
		// Only allow one task per worker
		if (activeRun) return;
		const runState = createRunState();
		if (pendingAbort) {
			pendingAbort = false;
			runState.abortController.abort();
		}
		activeRun = runState;
		void runTask(runState, message.payload);
	}
});
