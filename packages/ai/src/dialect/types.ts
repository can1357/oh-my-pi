import type { Dialect as CatalogDialect } from "@oh-my-pi/pi-catalog/identity";
import type { Context, Message, ToolCall } from "../types";

export type { Dialect } from "@oh-my-pi/pi-catalog/identity";

export type InbandScanEvent =
	| { type: "text"; text: string }
	| { type: "thinkingStart" }
	| { type: "thinkingDelta"; delta: string }
	| { type: "thinkingEnd"; thinking: string }
	/**
	 * A reasoning close tag with no open in this stream. Chat templates that
	 * prefill the opener into the prompt (DeepSeek-R1, Qwen3-Thinking) make the
	 * model stream only the close, so everything emitted as `text` before this
	 * event was reasoning. Only {@link ThinkingInbandScanner} with `impliedOpen`
	 * emits it.
	 */
	| { type: "impliedThinkingEnd" }
	| { type: "toolStart"; id: string; name: string }
	| { type: "toolArgDelta"; id: string; name: string; key: string; delta: string }
	| { type: "toolEnd"; id: string; name: string; arguments: Record<string, unknown>; rawBlock?: string };

export interface InbandScanner {
	feed(text: string): InbandScanEvent[];
	flush(): InbandScanEvent[];
}

export interface DialectToolResult {
	readonly id: string;
	readonly name: string;
	readonly index: number;
	readonly text: string;
	readonly isError: boolean;
}

export interface DialectRenderOptions {
	readonly tools?: readonly InbandTool[];
}

export interface DialectDefinition {
	readonly dialect: CatalogDialect;
	readonly prompt: string;
	createScanner(options?: InbandScannerOptions): InbandScanner;
	/** Render a single tool-call invocation — the inner element only, WITHOUT any parallel-call block envelope (e.g. anthropic's `<function_calls>` / kimi's section wrapper). */
	renderToolCall(call: ToolCall, options?: DialectRenderOptions): string;
	/** Render a batch of (parallel) tool calls as one complete block, including whatever envelope the dialect wraps multiple calls in. */
	renderAssistantToolCalls(calls: readonly ToolCall[], options?: DialectRenderOptions): string;
	renderToolResults(results: readonly DialectToolResult[], options?: DialectRenderOptions): string;
	renderThinking(text: string): string;
	renderTranscript(messages: readonly Message[], options?: DialectRenderOptions): string;
}

export interface InbandScannerOptions {
	/** string-typed arg names for a tool → read verbatim. Ignored by JSON-carrying dialects. */
	stringArgs?: (toolName: string) => ReadonlySet<string>;
	/** Full tool schemas for schema-driven dialects such as GLM XML and pi-native. */
	tools?: readonly InbandTool[];
	/** XML only: parse pipe-wrapped DeepSeek DSML tags vs plain Anthropic invoke/parameter tags. */
	xmlTagset?: "anthropic" | "dsml";
	/** Emit thinking markers as thinking events instead of visible text when the dialect defines them. */
	parseThinking?: boolean;
}

export type InbandTool = NonNullable<Context["tools"]>[number];
