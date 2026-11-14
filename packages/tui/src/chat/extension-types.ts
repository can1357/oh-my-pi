import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { TspText } from "@oh-my-pi/pi-wire";
import type { Component, TUI } from "../tui";
import type { Theme } from "../theme/theme";
import type { TodoItem } from "../tools/todo";
import type { BashExecutionMessage, CustomMessage, HookMessage, PythonExecutionMessage } from "./messages";
import type { NotificationRule } from "./ttsr-notification";

export type ExtensionUiComponent = Component & { dispose?(): void };

export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;

export type ExtensionWidgetContent = string[] | ExtensionUiComponentFactory | undefined;

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export interface AssistantThinkingRenderContext {
	contentIndex: number;
	thinkingIndex: number;
	text: string;
	requestRender(): void;
}

export type AssistantThinkingRenderer = (
	context: AssistantThinkingRenderContext,
	theme: Theme,
) => Component | undefined;

export interface AssistantTextRenderContext {
	/**
	 * The message being drawn; `message.timestamp` identifies the reply for `ctx.ui.rerenderMessage()`.
	 * After a tool call this is only the segment drawn there, so its `content` does not hold the whole reply.
	 * A deep copy: editing it, at any depth, cannot change the stored reply.
	 */
	message: AssistantMessage;
	/**
	 * The text block's index in the full reply's `content`, also when the reply is drawn in segments
	 * around tool calls; not an index into `message.content` for a segment. It counts the content as
	 * currently stored: a transcript rebuild that drops tool calls left without a result shifts later
	 * blocks down, so do not persist it as a permanent key.
	 */
	contentIndex: number;
	/** The block's markdown as drawn so far, after any earlier renderer. */
	text: string;
	/** True while the block may still grow; false for its final render, a block sealed at a tool call, and later redraws. */
	streaming: boolean;
}

/**
 * Display-only transform of one assistant text block: returns the markdown to draw, or `undefined`
 * to draw `context.text` unchanged. The session, exports and model context keep the original text.
 */
export type AssistantTextRenderer = (context: AssistantTextRenderContext) => string | undefined;

/** Extension text renderers for one assistant component, and where its content starts in the full reply. */
export interface AssistantTextRendering {
	renderers: readonly AssistantTextRenderer[];
	/** Index in the full reply's `content` of this component's first block; a segment after a tool call starts past it. */
	contentOffset: number;
}

/**
 * One transcript block a {@link TranscriptPresenter} decides the display of. Later omp versions
 * add block types; answer `undefined` for a `type` you do not know.
 *
 * - `toolCall`: a model tool call, `id` its `toolCallId`. `result` arrives with the call's first
 *   result frame; `isPartial` stays true while the call still streams progress.
 * - `message`: a session message drawn as its own block, `id` the decimal `message.timestamp`
 *   (shared by messages recorded in the same millisecond).
 *   `custom` messages with `customType` `"advisor"`, `"skill-prompt"`, `"lsp-late-diagnostic"`,
 *   `"async-result"` or `"launch-completion"`, and `!`/`$` runs (`bashExecution`,
 *   `pythonExecution`). A `!`/`$` run still going has a provisional message and id; it is asked
 *   again with the recorded message once the session records the run. In Tern, late diagnostics
 *   an edit/write card takes are drawn with that card instead, so an `"lsp-late-diagnostic"`
 *   block appears only for the files no card took.
 * - `event`: a TTSR rule hit or an incomplete-todo reminder, shaped like the extension event of
 *   the same `type`. These exist only in the session that raised them; `id` is unique per process.
 *
 * Read-only, and not a copy: `args`, `result`'s `content` and `details`, `message` and `event`
 * are the live objects omp draws the block from, often the session's own message data. Never
 * mutate them: the change would reach the block and possibly the session.
 */
export type TranscriptBlock =
	| {
			readonly type: "toolCall";
			readonly id: string;
			readonly toolName: string;
			readonly args: unknown;
			readonly result?: { readonly content: readonly unknown[]; readonly details?: unknown };
			readonly isError: boolean;
			readonly isPartial: boolean;
	  }
	| {
			readonly type: "message";
			readonly id: string;
			readonly message: CustomMessage | BashExecutionMessage | PythonExecutionMessage;
	  }
	| {
			readonly type: "event";
			readonly id: string;
			readonly event:
				| { readonly type: "ttsr_triggered"; readonly rules: readonly NotificationRule[] }
				| {
						readonly type: "todo_reminder";
						readonly todos: readonly TodoItem[];
						readonly attempt: number;
						readonly maxAttempts: number;
				  };
	  };

/**
 * How a transcript block is drawn: `undefined` defers to the next presenter (and, after the
 * last, to `"full"`); `"full"` is omp's own card; `"hidden"` draws nothing, as hidden tool
 * activity does; `"compact"` is one row from omp's own summary. `{ compact: { label, rows } }`
 * replaces that row's text with `label` and adds one row per `rows` entry below it. Spans use the
 * semantic tokens and theme colour names of {@link TspText}.
 */
export type TranscriptPresentation =
	| undefined
	| "full"
	| "hidden"
	| "compact"
	| { readonly compact: { readonly label?: TspText; readonly rows?: readonly TspText[] } };

/**
 * Display-only choice of how one transcript block is drawn. Presenters are asked in extension
 * load order; the first answer other than `undefined` wins. A block the user expanded is always
 * drawn in full.
 */
export type TranscriptPresenter = (block: TranscriptBlock) => TranscriptPresentation;

export interface HookMessageRenderOptions {
	/** Whether the view is expanded */
	expanded: boolean;
}

/**
 * Renderer for hook messages.
 * Hooks register these to provide custom TUI rendering for their message types.
 */
export type HookMessageRenderer<T = unknown> = (
	message: HookMessage<T>,
	options: HookMessageRenderOptions,
	theme: Theme,
) => Component | undefined;
