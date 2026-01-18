import type { AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SerializedAuthStorage } from "../../auth-storage";
import type { SerializedModelRegistry } from "../../model-registry";
import type { Settings } from "../../settings-manager";

/**
 * MCP tool metadata passed from parent to worker for proxy tool creation.
 */
export interface MCPToolMetadata {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	serverName: string;
	mcpToolName: string;
	timeoutMs?: number;
}

/**
 * Worker -> Parent: request to execute an MCP tool via parent's connection.
 */
export interface MCPToolCallRequest {
	type: "mcp_tool_call";
	callId: string;
	toolName: string;
	params: Record<string, unknown>;
}

/**
 * Parent -> Worker: result of an MCP tool call.
 */
export interface MCPToolCallResponse {
	type: "mcp_tool_result";
	callId: string;
	result?: {
		content: Array<{ type: string; text?: string; [key: string]: unknown }>;
		isError?: boolean;
	};
	error?: string;
}

export interface PythonToolCallRequest {
	type: "python_tool_call";
	callId: string;
	params: Record<string, unknown>;
}

export interface PythonToolCallResponse {
	type: "python_tool_result";
	callId: string;
	result?: {
		content: Array<{ type: string; text?: string; [key: string]: unknown }>;
		details?: unknown;
		isError?: boolean;
	};
	error?: string;
}

export interface SubagentWorkerStartPayload {
	cwd: string;
	task: string;
	systemPrompt: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	toolNames?: string[];
	outputSchema?: unknown;
	enableLsp?: boolean;
	sessionFile?: string | null;
	spawnsEnv?: string;
	serializedAuth?: SerializedAuthStorage;
	serializedModels?: SerializedModelRegistry;
	serializedSettings?: Settings;
	mcpTools?: MCPToolMetadata[];
	pythonToolProxy?: boolean;
}

export type SubagentWorkerRequest =
	| { type: "start"; payload: SubagentWorkerStartPayload }
	| { type: "abort" }
	| MCPToolCallResponse
	| PythonToolCallResponse;

export type SubagentWorkerResponse =
	| { type: "event"; event: AgentEvent }
	| { type: "done"; exitCode: number; durationMs: number; error?: string; aborted?: boolean }
	| MCPToolCallRequest
	| PythonToolCallRequest;
