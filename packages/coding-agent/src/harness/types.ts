import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

export interface WorkspacePolicy {
	readonly cwd: string;
	readonly additionalDirectories?: readonly string[];
	readonly readOnly?: boolean;
	readonly allowNetwork?: boolean;
	readonly maxExecutionTimeoutMs?: number;
	readonly blockedPaths?: readonly string[];
}

export interface ToolDescriptor {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
	readonly label?: string;
	readonly hidden?: boolean;
	readonly deferrable?: boolean;
	readonly loadMode?: string;
	readonly summary?: string;
	readonly strict?: boolean;
}

export interface ToolInvocationRequest {
	readonly callId: string;
	readonly toolName: string;
	readonly arguments: Record<string, unknown>;
	readonly signal?: AbortSignal;
}

export interface ToolInvocationResult {
	readonly callId: string;
	readonly toolName: string;
	readonly content: readonly (TextContent | ImageContent)[];
	readonly isError?: boolean;
	readonly details?: unknown;
}

export interface HarnessSessionInterface {
	readonly sessionId: string;
	readonly workspacePolicy: WorkspacePolicy;
	getTools(): readonly ToolDescriptor[];
	getTool(name: string): ToolDescriptor | undefined;
	hasTool(name: string): boolean;
	invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResult>;
	isDisposed?(): boolean;
	dispose?(): Promise<void> | void;
}
