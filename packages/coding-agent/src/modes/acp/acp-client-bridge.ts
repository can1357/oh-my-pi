/**
 * ACP-side `ClientBridge` implementation. Wraps `AgentSideConnection` so the
 * `read`/`write`/`bash`/`edit` tools (and the permission gate in
 * `AgentSession`) can route through the client when it advertises the
 * relevant capabilities at `initialize` time.
 */
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
	ClientBridgeCapabilities,
	ClientBridgeCreateTerminalParams,
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
	ClientBridgeTerminalHandle,
} from "../../session/client-bridge";

/**
 * Ordering dependency the permission path needs.
 *
 * Injected rather than reached for: today's permission call lives in
 * `session-tools.ts`, which cannot see a barrier private to `AcpAgent`. Without
 * this, `connection.requestPermission` — an independent JSON-RPC *request* outside
 * the notification stream — can beat the queued `started` frame for the same tool
 * call, and the dialog references a card the client has not rendered.
 */
export interface AcpPermissionSequencer {
	reservePermission<T>(toolCallId: string, invoke: () => Promise<T>): { readonly response: Promise<T> };
}

export function createAcpClientBridge(
	connection: AgentSideConnection,
	sessionId: string,
	clientCapabilities: ClientCapabilities | undefined,
	sequencer?: AcpPermissionSequencer,
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
	// Client terminal release is a wire-visible lifecycle action. Keep the raw ACP
	// handles keyed by their typed call so AcpAgent can perform it after (never before)
	// that call's settlement batch reaches the shared outbound writer.
	const terminalsAwaitingSettlement = new Map<string, AcpTerminalHandle>();

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
			createTerminalHandle(connection, sessionId, params, terminalsAwaitingSettlement);
		bridge.releaseTerminalAfterPresentationSettlement = async toolCallId => {
			const terminal = terminalsAwaitingSettlement.get(toolCallId);
			if (terminal === undefined) return;
			terminalsAwaitingSettlement.delete(toolCallId);
			await terminal.release();
		};
	}

	bridge.requestPermission = (toolCall, options, signal) =>
		requestPermission(connection, sessionId, toolCall, options, signal, sequencer);

	return bridge;
}

async function createTerminalHandle(
	connection: AgentSideConnection,
	sessionId: string,
	params: ClientBridgeCreateTerminalParams,
	terminalsAwaitingSettlement: Map<string, AcpTerminalHandle>,
): Promise<ClientBridgeTerminalHandle> {
	const handle = await connection.createTerminal({
		sessionId,
		command: params.command,
		...(params.args ? { args: params.args } : {}),
		...(params.env ? { env: params.env } : {}),
		...(params.cwd ? { cwd: params.cwd } : {}),
		...(typeof params.outputByteLimit === "number" ? { outputByteLimit: params.outputByteLimit } : {}),
	});
	if (params.toolCallId !== undefined) terminalsAwaitingSettlement.set(params.toolCallId, handle);
	return wrapTerminalHandle(handle, () => {
		if (params.toolCallId !== undefined && terminalsAwaitingSettlement.get(params.toolCallId) === handle) {
			terminalsAwaitingSettlement.delete(params.toolCallId);
		}
	});
}

function wrapTerminalHandle(handle: AcpTerminalHandle, forget: () => void): ClientBridgeTerminalHandle {
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
			forget();
			await handle.release();
		},
	};
}

async function requestPermission(
	connection: AgentSideConnection,
	sessionId: string,
	toolCall: ClientBridgePermissionToolCall,
	options: ClientBridgePermissionOption[],
	signal: AbortSignal | undefined,
	sequencer: AcpPermissionSequencer | undefined,
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
	// The reservation is taken synchronously; the *user's answer* is awaited out
	// here, outside the sequencer. Awaiting it inside would head-of-line-block every
	// later session update behind an open dialog, and handing the caller a
	// `Promise<Promise<T>>` would recreate the same block through promise
	// assimilation — hence the box.
	const response = sequencer
		? await sequencer.reservePermission(toolCall.toolCallId, () => connection.requestPermission(request)).response
		: await connection.requestPermission(request);
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
