import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { JSXNode, UiNode } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspText } from "@oh-my-pi/pi-wire";
import type { TodoItem } from "../../tools/details/todo";
import type {
	BashExecutionMessage,
	CustomMessage,
	HookMessage,
	PythonExecutionMessage,
} from "../../session/transcript/messages";
import type { NotificationRule } from "../../session/transcript/ttsr-notification";

/**
 * The plain-rows escape hatch: anything that draws rows at a width. The host draws it as a
 * `canvas` node (a `rows` node in Tern). Rows wider than `width` are cut to it.
 */
export interface ExtensionRows {
	/** Rows at `width` (ANSI styling allowed). */
	render(width: number): readonly string[];
	/** In the transcript: pack against neighbouring compact blocks while this returns true. */
	isTranscriptBlockCompact?(): boolean;
	/** In a `ctx.ui.custom` view: raw terminal input of each key and paste the view receives. */
	handleInput?(data: string): void;
	/** Called once when the host drops the view (a closed overlay, a replaced widget). */
	dispose?(): void;
}

/**
 * What extension renderers and custom UI return: pi-tui nodes (JSX via `@oh-my-pi/pi-tui`, node
 * objects, strings, arrays, accessors) or an {@link ExtensionRows} object.
 */
export type ExtensionRender = JSXNode | ExtensionRows;

/**
 * The theme extensions receive: pi-tui's theme (`fg`, `bg`, `style`, `symbols`, …) plus the text
 * attribute helpers row renderers used with pi-tui's theme.
 */
export interface ExtensionTheme extends Theme {
	bold(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	strikethrough(text: string): string;
	inverse(text: string): string;
}

/** One owned block of the interactive transcript; identity lasts until the block is replaced. */
export interface ExtensionLiveBlock {
	readonly id: string;
	readonly node: UiNode;
	native(): readonly UiNode[];
	render(width: number): readonly string[];
	setExpanded(expanded: boolean): void;
	/** Escaped sibling keypath below one native root, or below a column over multiple roots. */
	dispatchAction(path: string, act: string): boolean;
}

/** Retained UI access for interactive transcript widgets, not session-message transforms. */
export interface ExtensionLiveUi {
	readonly native: boolean;
	blocks(): readonly ExtensionLiveBlock[];
	decorate(transform: (blocks: readonly ExtensionLiveBlock[]) => readonly UiNode[]): () => void;
	invalidate(): void;
	focused(): UiNode | null;
	promptConsumesEscape(): boolean;
	showOverlay(factory: () => UiNode, options?: { passive?: boolean }): { hide(): void };
}

/** Optional native styling of a status; plain terminals and RPC keep the supplied text. */
export interface ExtensionStatusOptions {
	readonly role?: string;
	readonly spans?: readonly { readonly t: string; readonly s?: string }[];
}

/** What UI factories receive in place of the old pi-tui `TUI`. */
export interface ExtensionUiHost {
	/**
	 * Draw the view's rows again. Nodes repaint on their own when the signals they read change;
	 * an {@link ExtensionRows} object repaints only when its host calls `render` again.
	 */
	requestRender(): void;
	/** The terminal's size in cells (reactive when read inside nodes). */
	size(): { readonly columns: number; readonly rows: number };
	/**
	 * Hand the terminal to `run` (an external editor, a pager) and take it back once it settles;
	 * resolves with what `run` resolves.
	 */
	suspend<R>(run: () => Promise<R>): Promise<R>;
	/** Available to widgets on the interactive main transcript; decoration is native-only. */
	readonly live?: ExtensionLiveUi;
}

/** Builds a widget, header or footer view. */
export type ExtensionUiFactory = (ui: ExtensionUiHost, theme: ExtensionTheme) => ExtensionRender;

/** Widget content: lines of text (ANSI allowed), a view factory, or `undefined` to remove the widget. */
export type ExtensionWidgetContent = readonly string[] | ExtensionUiFactory | undefined;

export interface MessageRenderOptions {
	expanded: boolean;
}

/**
 * Draws a custom message; `undefined` (or a throw) keeps the default card. Called again whenever
 * the message's expansion changes.
 */
export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: ExtensionTheme,
) => ExtensionRender | undefined;

export interface AssistantThinkingRenderContext {
	contentIndex: number;
	thinkingIndex: number;
	text: string;
	requestRender(): void;
}

/** Draws under an assistant thinking block; `undefined` (or a throw) draws nothing. */
export type AssistantThinkingRenderer = (
	context: AssistantThinkingRenderContext,
	theme: ExtensionTheme,
) => ExtensionRender | undefined;

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

/**
 * One transcript block a {@link TranscriptPresenter} decides the display of. Later omp versions
 * add block types; answer `undefined` for a `type` you do not know.
 *
 * - `toolCall`: a model tool call, `id` its `toolCallId`. `result` arrives with the call's first
 *   result frame; `isPartial` stays true while the call still streams progress.
 * - `message`: a session message drawn as its own block, `id` the decimal `message.timestamp`
 *   (shared by messages recorded in the same millisecond).
 *   `custom` messages with `customType` `"advisor"`, `"skill-prompt"`, `"lsp-late-diagnostic"`,
 *   `"async-result"`, `"async-notify"` or `"launch-completion"`, and `!`/`$` runs (`bashExecution`,
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

/** Renderer for legacy hook messages; same contract as {@link MessageRenderer}. */
export type HookMessageRenderer<T = unknown> = (
	message: HookMessage<T>,
	options: HookMessageRenderOptions,
	theme: ExtensionTheme,
) => ExtensionRender | undefined;
