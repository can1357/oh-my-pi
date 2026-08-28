/**
 * Wire shapes for the omp RPC protocol, as spoken by `omp --mode rpc-ui`.
 *
 * These mirror `@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types` but are declared
 * locally and structurally on purpose: that module's type graph reaches into
 * `bun:sqlite`, node builtins and the whole coding-agent runtime, none of which
 * belong in a DOM-targeted tsconfig. `test/protocol.conformance.test.ts` pins
 * these against real captured frames so drift shows up as a failing test rather
 * than a runtime surprise.
 *
 * Everything here is `unknown`-tolerant: frames arrive as plain JSON from a
 * separate process that may be a different omp version than the one we shipped.
 */

/** First frame the server writes, before it processes any command. */
export interface ReadyFrame {
	type: "ready";
	protocolVersion: number;
	supportedProtocolVersions?: number[];
	maxFrameBytes?: number;
	maxReassembledFrameBytes?: number;
}

export interface ResponseFrame {
	type: "response";
	id: string;
	success?: boolean;
	data?: unknown;
	error?: string;
	/** Machine-readable code on failures, e.g. `session_busy`, `stale_cursor`. */
	code?: string;
}

/**
 * Host-facing UI requests. Only `confirm`, `select`, `input`, `editor` and
 * `open_url` expect an answer; the rest are fire-and-forget.
 *
 * Verified empirically: a `setWidget` request left unanswered for 12s did not
 * wedge the server — later commands still resolved. So ignoring the
 * non-blocking methods is safe.
 */
export type ExtensionUiMethod =
	| "select"
	| "confirm"
	| "input"
	| "editor"
	| "cancel"
	| "notify"
	| "setStatus"
	| "setWidget"
	| "setTitle"
	| "set_editor_text"
	| "open_url";

/** The subset that blocks the agent until the host answers. */
export const BLOCKING_UI_METHODS = new Set<ExtensionUiMethod>(["select", "confirm", "input", "editor", "open_url"]);

export interface ExtensionUiRequestFrame {
	type: "extension_ui_request";
	id: string;
	method: ExtensionUiMethod;
	title?: string;
	message?: string;
	placeholder?: string;
	/*
	 * `editor` only, and not a placeholder: the document the caller handed over to
	 * be edited. `/review`'s custom mode sends its scaffold here and an extension
	 * sends the text it is proposing, so a dialog that ignores it answers "" over
	 * the caller's own content.
	 */
	prefill?: string;
	options?: string[];
	optionDetails?: Array<{ description?: string }>;
	/*
	 * Plan review only. Its presence is what says `message` is the plan's
	 * markdown rather than the prose of an `ask` — declared rather than sniffed,
	 * because every field this package left as `unknown` has cost a silent bug.
	 */
	planFilePath?: string;
	timeout?: number;
	/** `open_url` only. */
	url?: string;
	instructions?: string;
	/** Truncation-safe loopback URL that 302s to `url`. */
	launchUrl?: string;
	[key: string]: unknown;
}

export type ExtensionUiResponseFrame =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

/**
 * The answer half of a UI response, without the discriminant.
 *
 * A plain `Omit<ExtensionUiResponseFrame, "type">` would NOT work: `Omit` is not
 * distributive, so it collapses the union into the intersection of its keys and
 * every variant-specific field (`value`, `confirmed`, `cancelled`) disappears.
 * The conditional forces distribution over each member.
 */
export type ExtensionUiAnswer = ExtensionUiResponseFrame extends infer Frame
	? Frame extends { type: string }
		? Omit<Frame, "type">
		: never
	: never;

export interface AvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: string;
}

export interface AvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: AvailableSlashCommand[];
}

/** Session-level events forwarded from `AgentSession.subscribe`. */
export interface SessionEventFrame {
	type: string;
	[key: string]: unknown;
}

export type ServerFrame =
	| ReadyFrame
	| ResponseFrame
	| ExtensionUiRequestFrame
	| AvailableCommandsUpdateFrame
	| SessionEventFrame;

/** One task. Referenced by its `content`: the tool deliberately has no ids. */
export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** Only when `status === "blocked"`: what it is waiting for. */
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface RpcSessionState {
	model?: {
		provider?: string;
		id?: string;
		contextWindow?: number;
		/** False for a model that cannot reason at all — then there are no levels. */
		reasoning?: boolean;
		/*
		 * Verified against a live `get_state`, because the CLI serialises this
		 * differently: `omp models --json` flattens it to a bare string array,
		 * while the RPC sends the model unflattened. Same field, two shapes —
		 * the same trap as `args` versus `arguments` on tool calls.
		 */
		thinking?: { mode?: string; efforts?: string[] };
	};
	thinkingLevel?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	/**
	 * The agent's plan, as `tools/todo.ts` declares it.
	 *
	 * Typed rather than `unknown[]`, because `unknown[]` is exactly what let the
	 * panel read `phase.items` for months — a field the *input* to the todo tool
	 * has and its *state* does not. The state's tasks live under `tasks`.
	 */
	todoPhases: TodoPhase[];
	/**
	 * Plan mode, when the server reports it.
	 *
	 * Absent means an omp too old to say — which is not the same as off, and the
	 * difference decides whether this client may offer a toggle at all.
	 */
	planMode?: { enabled: boolean; planFilePath?: string };
	/**
	 * Captured from a live `get_state`: `{ tokens, contextWindow, percent }`.
	 * Not `used`/`total` — an earlier guess that happened to work only because
	 * `percent` is present and was checked first.
	 */
	contextUsage?: {
		tokens?: number;
		contextWindow?: number;
		percent?: number;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/**
 * Subagent progress, as embedded in `RpcSubagentSnapshot.progress` and pushed
 * on `subagent_progress` frames. Rich enough that the panel needs no extra
 * round trips: it carries the current tool, recent tools and recent output.
 */
export interface SubagentProgress {
	index: number;
	id: string;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput?: string[];
	toolCount?: number;
	requests?: number;
	[key: string]: unknown;
}

export interface SubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	description?: string;
	status: SubagentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: SubagentProgress;
	parentToolCallId?: string;
}

export interface LoginProvider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
}

/** Session metadata as emitted by `omp sessions --json`. */
export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	title?: string;
	created: string;
	modified: string;
	messageCount: number;
	size: number;
	firstMessage: string;
	status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
	/** Main repo root when `cwd` is a linked worktree; otherwise `cwd`. */
	projectRoot: string;
	isWorktree: boolean;
}

export function isResponseFrame(frame: ServerFrame): frame is ResponseFrame {
	return frame.type === "response";
}

export function isReadyFrame(frame: ServerFrame): frame is ReadyFrame {
	return frame.type === "ready";
}

export function isExtensionUiRequest(frame: ServerFrame): frame is ExtensionUiRequestFrame {
	return frame.type === "extension_ui_request";
}

export function isAvailableCommandsUpdate(frame: ServerFrame): frame is AvailableCommandsUpdateFrame {
	return frame.type === "available_commands_update";
}
