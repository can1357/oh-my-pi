/**
 * ACP-side `ClientBridge` implementation. Wraps `AgentSideConnection` so the
 * `read`/`write`/`bash`/`edit` tools (and the permission gate in
 * `AgentSession`) can route through the client when it advertises the
 * relevant capabilities at `initialize` time.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type {
	PermissionOption as AcpPermissionOption,
	TerminalHandle as AcpTerminalHandle,
	AgentSideConnection,
	ClientCapabilities,
	RequestPermissionRequest,
	ToolCallUpdate,
} from "@oh-my-pi/pi-utils/acp";
import type {
	ClientBridge,
	ClientBridgeAgentWakeNotification,
	ClientBridgeCapabilities,
	ClientBridgeCreateTerminalParams,
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
	ClientBridgeTerminalHandle,
} from "../../session/client-bridge";

const AGENT_WAKE_NOTIFICATION_METHOD = "_omp/session/wake";

export function createAcpClientBridge(
	connection: AgentSideConnection,
	sessionId: string,
	clientCapabilities: ClientCapabilities | undefined,
	wakeAware = false,
): ClientBridge {
	const capabilities: ClientBridgeCapabilities = {
		readTextFile: clientCapabilities?.fs?.readTextFile === true,
		writeTextFile: clientCapabilities?.fs?.writeTextFile === true,
		terminal: clientCapabilities?.terminal === true,
		// Permission requests are always usable on the connection; gating is
		// the agent's policy choice rather than a client capability.
		requestPermission: true,
	};

	const bridge: ClientBridge = { capabilities, deferAgentInitiatedTurns: true };
	if (wakeAware) {
		bridge.notifyAgentWake = notification => sendAgentWakeNotification(connection, sessionId, notification);
	}

	if (capabilities.readTextFile) {
		bridge.readTextFile = async params => {
			const response = await connection.readTextFile({
				sessionId,
				path: params.path,
				...(typeof params.line === "number" ? { line: params.line } : {}),
				...(typeof params.limit === "number" ? { limit: params.limit } : {}),
			});
			return response.content;
		};
	}

	if (capabilities.writeTextFile) {
		bridge.writeTextFile = async params => {
			await connection.writeTextFile({
				sessionId,
				path: params.path,
				content: params.content,
			});
		};
	}

	if (capabilities.terminal) {
		bridge.createTerminal = (params: ClientBridgeCreateTerminalParams) =>
			createTerminalHandle(connection, sessionId, params);
	}

	bridge.requestPermission = (toolCall, options, signal) =>
		requestPermission(connection, sessionId, toolCall, options, signal);

	return bridge;
}

async function createTerminalHandle(
	connection: AgentSideConnection,
	sessionId: string,
	params: ClientBridgeCreateTerminalParams,
): Promise<ClientBridgeTerminalHandle> {
	const handle = await connection.createTerminal({
		sessionId,
		command: params.command,
		...(params.args ? { args: params.args } : {}),
		...(params.env ? { env: params.env } : {}),
		...(params.cwd ? { cwd: params.cwd } : {}),
		...(typeof params.outputByteLimit === "number" ? { outputByteLimit: params.outputByteLimit } : {}),
	});
	return wrapTerminalHandle(handle);
}

function wrapTerminalHandle(handle: AcpTerminalHandle): ClientBridgeTerminalHandle {
	return {
		terminalId: handle.id,
		async currentOutput() {
			const out = await handle.currentOutput();
			return {
				output: out.output,
				truncated: out.truncated,
				exitStatus: out.exitStatus ?? null,
			};
		},
		async waitForExit() {
			const status = await handle.waitForExit();
			return { exitCode: status.exitCode ?? null, signal: status.signal ?? null };
		},
		async kill() {
			await handle.kill();
		},
		async release() {
			await handle.release();
		},
	};
}

function sendAgentWakeNotification(
	connection: AgentSideConnection,
	sessionId: string,
	notification: ClientBridgeAgentWakeNotification,
): void {
	connection
		.notify(AGENT_WAKE_NOTIFICATION_METHOD, {
			sessionId,
			reason: notification.reason,
			batchId: notification.batchId,
		})
		.catch(error => {
			// Fire-and-forget by design: a dropped wake only delays the parked
			// batch until the client's next prompt, which drains it regardless.
			logger.warn("Failed to send _omp/session/wake notification", {
				sessionId,
				reason: notification.reason,
				error: error instanceof Error ? error.message : String(error),
			});
		});
}

async function requestPermission(
	connection: AgentSideConnection,
	sessionId: string,
	toolCall: ClientBridgePermissionToolCall,
	options: ClientBridgePermissionOption[],
	signal: AbortSignal | undefined,
): Promise<ClientBridgePermissionOutcome> {
	const update: ToolCallUpdate = {
		toolCallId: toolCall.toolCallId,
		title: toolCall.title,
		...(toolCall.kind ? { kind: toolCall.kind as ToolCallUpdate["kind"] } : {}),
		...(toolCall.status ? { status: toolCall.status as ToolCallUpdate["status"] } : {}),
		...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
		...(toolCall.content ? { content: toolCall.content as ToolCallUpdate["content"] } : {}),
		...(toolCall.locations ? { locations: toolCall.locations } : {}),
	};
	const acpOptions: AcpPermissionOption[] = options.map(option => ({
		optionId: option.optionId,
		name: option.name,
		kind: option.kind,
	}));
	const request: RequestPermissionRequest = {
		sessionId,
		toolCall: update,
		options: acpOptions,
	};
	if (signal?.aborted) {
		return { outcome: "cancelled" };
	}
	const response = await connection.requestPermission(request);
	const outcome = response.outcome;
	if (outcome.outcome === "cancelled") {
		return { outcome: "cancelled" };
	}
	const matched = options.find(option => option.optionId === outcome.optionId);
	return {
		outcome: "selected",
		optionId: outcome.optionId,
		...(matched ? { kind: matched.kind } : {}),
	};
}
