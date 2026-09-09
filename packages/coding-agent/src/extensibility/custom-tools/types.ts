/**
 * Custom tool types.
 *
 * Custom tools are TypeScript modules that define additional tools for the agent.
 * They can provide custom rendering for tool calls and results in the TUI.
 */

import type { type as ArkType } from "@oh-my-pi/omptype";
import type * as TypeBox from "@oh-my-pi/omptype/typebox";
import type * as zod from "@oh-my-pi/omptype/zod";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApproval,
	ToolApprovalDecision,
	ToolLoadMode,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { FetchImpl, Model, Static, TSchema } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import type { logger as PiLogger } from "@oh-my-pi/pi-utils";
import type { Rule } from "../../capability/rule";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import type { HookUIContext } from "../../extensibility/hooks/types";
import type * as PiCodingAgent from "../../index";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { Theme } from "../../modes/theme/theme";
import type { ReadonlySessionManager } from "../../session/session-manager";
import type { TodoItem } from "../../tools/todo";
import type { RetryErrorUpdate } from "../shared-events";

/** Alias for clarity */
export type CustomToolUIContext = HookUIContext;

// Re-export for backward compatibility
export type { ExecOptions, ExecResult } from "../../exec/exec";
/** Re-export for custom tools to use in execute signature */
export type { AgentToolResult, AgentToolUpdateCallback, ToolApproval, ToolApprovalDecision, ToolTier };

/** Pending action entry consumed by the hidden resolve tool */
export interface CustomToolPendingAction {
	/** Human-readable preview label shown in resolve flow */
	label: string;
	/** Apply callback invoked when resolve(action="apply") is called */
	apply(reason: string): Promise<AgentToolResult<unknown>>;
	/** Optional reject callback invoked when resolve(action="discard") is called */
	reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	/** Optional details metadata stored with the pending action */
	details?: unknown;
	/** Optional source tool name shown by resolve renderer (defaults to "custom_tool") */
	sourceToolName?: string;
}

/** API passed to custom tool factory (stable across session changes) */
export interface CustomToolAPI {
	/** Current working directory */
	cwd: string;
	/** Execute a command */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	/** UI methods for user interaction (select, confirm, input, notify, custom) */
	ui: CustomToolUIContext;
	/** Whether UI is available (false in print/RPC mode) */
	hasUI: boolean;
	/** File logger for error/warning/debug messages */
	logger: typeof PiLogger;
	/** Injected typebox shim (legacy/compat — arktype-authored tools are preferred). */
	typebox: typeof TypeBox;
	/** Injected arktype module for arktype-authored custom tools. */
	arktype: typeof ArkType;
	/** Injected Zod-compatible omptype builder for custom tools. */
	zod: typeof zod;
	/** Injected pi-coding-agent exports */
	pi: typeof PiCodingAgent;
	/** Push a preview action that can later be resolved with the hidden resolve tool */
	pushPendingAction(action: CustomToolPendingAction): void;
}

/**
 * Context passed to tool execute and onSession callbacks.
 * Provides access to session state and model information.
 */
export interface CustomToolContext {
	/** Session manager (read-only) */
	sessionManager: ReadonlySessionManager;
	/** Model registry - use for API key resolution and model retrieval */
	modelRegistry: ModelRegistry;
	/** Current model (may be undefined if no model is selected yet) */
	model: Model | undefined;
	/** Whether the agent is idle (not streaming) */
	isIdle(): boolean;
	/** Whether there are queued messages waiting to be processed */
	hasQueuedMessages(): boolean;
	/** Abort the current agent operation (fire-and-forget, does not wait) */
	abort(): void;
	/** Settings instance for the current session. Prefer over the global singleton. */
	settings?: Settings;
	/** Fetch implementation for outbound HTTP; defaults to global fetch when omitted. */
	fetch?: FetchImpl;
	/** Calling session's `local://` root mapping for tools that bridge out of the OMP process. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Whether to auto-approve all destructive tool operations (--auto-approve CLI flag) */
	autoApprove?: boolean;
}

/** Session event passed to onSession callback */
export type CustomToolSessionEvent =
	| {
			/** Reason for the session event */
			reason: "start" | "switch" | "branch" | "tree" | "shutdown";
			/** Previous session file path, or undefined for "start" and "shutdown" */
			previousSessionFile: string | undefined;
	  }
	| {
			reason: "auto_compaction_start";
			trigger: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			reason: "auto_compaction_end";
			action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			reason: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| {
			reason: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			retryErrors?: RetryErrorUpdate[];
	  }
	| {
			reason: "ttsr_triggered";
			rules: Rule[];
	  }
	| {
			reason: "todo_reminder";
			todos: TodoItem[];
			attempt: number;
			maxAttempts: number;
	  };

/** Rendering options passed to renderResult */
export interface RenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (0-9, only provided during partial results) */
	spinnerFrame?: number;
	/**
	 * True once arguments are final (`message_end` / `setArgsComplete`).
	 * Exclusive tools can sit here while an earlier call still runs.
	 */
	argsComplete?: boolean;
	/**
	 * True once this specific call has begun executing (`tool_execution_start`).
	 * Streamed `xd://` previews stay queued until this is set.
	 */
	executionStarted?: boolean;
}

export type CustomToolResult<TDetails = any> = AgentToolResult<TDetails>;

/**
 * Custom tool definition.
 *
 * Custom tools are standalone - they don't extend AgentTool directly.
 * When loaded, they are wrapped in an AgentTool for the agent to use.
 *
 * The execute callback receives a ToolContext with access to session state,
 * model registry, and current model.
 *
 * @example
 * ```typescript
 * const factory: CustomToolFactory = (pi) => ({
 *   name: "my_tool",
 *   label: "My Tool",
 *   description: "Does something useful",
 *   parameters: Type.Object({ input: Type.String() }),
 *
 *   async execute(toolCallId, params, onUpdate, ctx, signal) {
 *     // Access session state via ctx.sessionManager
 *     // Access model registry via ctx.modelRegistry
 *     // Current model via ctx.model
 *     return { content: [{ type: "text", text: "Done" }] };
 *   },
 *
 *   onSession(event, ctx) {
 *     if (event.reason === "shutdown") {
 *       // Cleanup
 *     }
 *     // Reconstruct state from ctx.sessionManager.getEntries()
 *   }
 * });
 * ```
 */
export interface CustomTool<TParams extends TSchema = TSchema, TDetails = any> {
	/** Tool name (used in LLM tool calls) */
	name: string;
	/** Human-readable label for UI */
	label: string;
	/** If true, tool is strictly typed and validated against the parameters schema before execution */
	strict?: boolean;
	/** Description for LLM */
	description: string;
	/** Parameter schema (arktype, TypeBox, or legacy formats). */
	parameters: TParams;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field */
	hidden?: boolean;
	/** How this tool is presented when enabled. See {@link ToolLoadMode}. Custom tools default to `"discoverable"`; set `"essential"` to stay top-level. */
	loadMode?: ToolLoadMode;
	/** If true, tool may stage deferred changes that require explicit resolve/discard. */
	deferrable?: boolean;
	/** MCP server name for discovery/search metadata when this tool fronts an MCP server. */
	mcpServerName?: string;
	/** Original MCP tool name for discovery/search metadata. */
	mcpToolName?: string;

	/** Capability tier declaration used by approval gates. Omitted means "exec". */
	approval?: ToolApproval;

	/** Lines appended after the standard approval prompt header. */
	formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
	/**
	 * Execute the tool.
	 * @param toolCallId - Unique ID for this tool call
	 * @param params - Parsed parameters matching the schema
	 * @param onUpdate - Callback for streaming partial results (for UI, not LLM)
	 * @param ctx - Context with session manager, model registry, and current model
	 * @param signal - Optional abort signal for cancellation
	 */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		onUpdate: AgentToolUpdateCallback<TDetails, TParams> | undefined,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TDetails, TParams>>;

	/** Called on session lifecycle events - use to reconstruct state or cleanup resources */
	onSession?: (event: CustomToolSessionEvent, ctx: CustomToolContext) => void | Promise<void>;
	/** Custom rendering for tool call display - return a Component */
	renderCall?: (args: Static<TParams>, options: RenderResultOptions, theme: Theme) => Component;

	/** Custom rendering for tool result display - return a Component */
	renderResult?: (
		result: CustomToolResult<TDetails>,
		options: RenderResultOptions,
		theme: Theme,
		args?: Static<TParams>,
	) => Component;
}

/** Factory function that creates a custom tool or array of tools */
export type CustomToolFactory = (
	pi: CustomToolAPI,
) => CustomTool<any, any> | CustomTool<any, any>[] | Promise<CustomTool<any, any> | CustomTool<any, any>[]>;

/** Loaded custom tool with metadata and wrapped AgentTool */
export interface LoadedCustomTool<TParams extends TSchema = TSchema, TDetails = any> {
	/** Original path (as specified) */
	path: string;
	/** Resolved absolute path */
	resolvedPath: string;
	/** The original custom tool instance */
	tool: CustomTool<TParams, TDetails>;
	/** Source metadata (provider and level) */
	source?: { provider: string; providerName: string; level: "user" | "project" };
}

/** Error with source metadata */
export interface ToolLoadError {
	path: string;
	error: string;
	source?: { provider: string; providerName: string; level: "user" | "project" };
}

/** Result from loading custom tools */
export interface CustomToolsLoadResult {
	tools: LoadedCustomTool[];
	errors: ToolLoadError[];
	/** Update the UI context for all loaded tools. Call when mode initializes. */
	setUIContext(uiContext: CustomToolUIContext, hasUI: boolean): void;
}
