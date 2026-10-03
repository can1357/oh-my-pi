import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { Tool, ToolSession } from "../tools";
import type {
	HarnessSessionInterface,
	ToolDescriptor,
	ToolInvocationRequest,
	ToolInvocationResult,
	WorkspacePolicy,
} from "./types";

export interface LocalHarnessAdapterOptions {
	session: ToolSession;
	toolRegistry?: Map<string, Tool>;
	workspacePolicy?: Partial<WorkspacePolicy>;
}

export class LocalHarnessAdapter implements HarnessSessionInterface {
	readonly #session: ToolSession;
	readonly #toolRegistry: Map<string, Tool>;
	readonly #workspacePolicy: WorkspacePolicy;
	#disposed = false;

	constructor(
		sessionOrOptions: ToolSession | LocalHarnessAdapterOptions,
		toolRegistry?: Map<string, Tool>,
	) {
		if ("session" in sessionOrOptions && typeof sessionOrOptions.session === "object") {
			this.#session = sessionOrOptions.session;
			this.#toolRegistry = sessionOrOptions.toolRegistry ?? sessionOrOptions.session.toolRegistry ?? new Map();
			this.#workspacePolicy = {
				cwd: sessionOrOptions.session.cwd,
				additionalDirectories: sessionOrOptions.session.additionalDirectories ?? [],
				readOnly: false,
				allowNetwork: true,
				...sessionOrOptions.workspacePolicy,
			};
		} else {
			this.#session = sessionOrOptions;
			this.#toolRegistry = toolRegistry ?? sessionOrOptions.toolRegistry ?? new Map();
			this.#workspacePolicy = {
				cwd: sessionOrOptions.cwd,
				additionalDirectories: sessionOrOptions.additionalDirectories ?? [],
				readOnly: false,
				allowNetwork: true,
			};
		}
	}

	get sessionId(): string {
		return this.#session.getSessionId?.() ?? "local-harness-session";
	}

	get workspacePolicy(): WorkspacePolicy {
		return this.#workspacePolicy;
	}

	#resolveTool(name: string): Tool | AgentTool | undefined {
		return this.#toolRegistry.get(name) ?? this.#session.getToolByName?.(name);
	}

	#toDescriptor(tool: Tool | AgentTool): ToolDescriptor {
		return {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			label: "label" in tool && typeof tool.label === "string" ? tool.label : tool.name,
			hidden: "hidden" in tool ? Boolean(tool.hidden) : undefined,
			deferrable: "deferrable" in tool ? Boolean(tool.deferrable) : undefined,
			loadMode: "loadMode" in tool && typeof tool.loadMode === "string" ? tool.loadMode : undefined,
			summary: "summary" in tool && typeof tool.summary === "string" ? tool.summary : undefined,
			strict: "strict" in tool ? Boolean(tool.strict) : undefined,
		};
	}

	registerTool(tool: Tool): void {
		this.#toolRegistry.set(tool.name, tool);
	}

	getTools(): readonly ToolDescriptor[] {
		const descriptors: ToolDescriptor[] = [];
		for (const tool of this.#toolRegistry.values()) {
			descriptors.push(this.#toDescriptor(tool));
		}
		return descriptors;
	}

	getTool(name: string): ToolDescriptor | undefined {
		const tool = this.#resolveTool(name);
		return tool ? this.#toDescriptor(tool) : undefined;
	}

	hasTool(name: string): boolean {
		return this.#resolveTool(name) !== undefined;
	}

	async invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResult> {
		if (this.isDisposed()) {
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: [{ type: "text", text: "Harness session is disposed" }],
				isError: true,
			};
		}

		const tool = this.#resolveTool(request.toolName);
		if (!tool) {
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: [{ type: "text", text: `Tool not found: "${request.toolName}"` }],
				isError: true,
			};
		}

		if (this.#workspacePolicy.readOnly && (request.toolName === "write" || request.toolName === "ast_edit")) {
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: [{ type: "text", text: `Tool invocation denied by WorkspacePolicy (read-only): "${request.toolName}"` }],
				isError: true,
			};
		}

		try {
			const context = this.#session.getToolContext?.();
			const result = await tool.execute(
				request.callId,
				request.arguments,
				request.signal,
				undefined,
				context,
			);
			const isError = isRecord(result) && (
				result.isError === true ||
				(isRecord(result.details) && result.details.isError === true)
			);
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: result.content,
				details: result.details,
				isError,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: [{ type: "text", text: `Error executing ${request.toolName}: ${errorMessage}` }],
				isError: true,
				details: error,
			};
		}
	}

	isDisposed(): boolean {
		return this.#disposed || (this.#session.isDisposed?.() ?? false);
	}

	dispose(): void {
		this.#disposed = true;
	}
}
