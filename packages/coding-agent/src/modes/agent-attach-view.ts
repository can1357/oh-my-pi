/**
 * Fullscreen view for a live native task subagent attached from another terminal.
 *
 * The owner process sends a snapshot of the child's transcript, then live session
 * events. This view replays them into the shared transcript components and sends
 * steer, abort, and detach back through the client. It never starts a session,
 * model, or tool runtime, and leaving the view never ends the child.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	Editor,
	type Focusable,
	matchesKey,
	type OverlayHandle,
	ProcessTerminal,
	routeSgrMouseInput,
	TranscriptBrowser,
	type TranscriptBrowserFrame,
	type TranscriptBrowserRenderContext,
	TUI,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { formatKeyHint, formatKeyHints } from "@oh-my-pi/pi-tui/app-keybindings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import type { SessionMessageEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { splitAssistantMessageToolTimeline } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import { editorKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { getEditorTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { AgentAttachClient } from "../agent-attach/client";
import type {
	AgentAttachErrorCode,
	AgentAttachServerFrame,
	AgentAttachSnapshotEnd,
	AgentAttachSnapshotStart,
} from "../agent-attach/protocol";
import type { AgentSessionEvent } from "../session/agent-session-events";

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;
type QueueState = AgentAttachSnapshotEnd["queue"];
type ErrorFrame = Extract<AgentAttachServerFrame, { type: "error" }>;

interface ViewOutcome {
	end: "detached" | "disconnected";
	/** Sanitized owner-side reason for a disconnect, printed after the terminal is restored. */
	reason?: string;
}

/** Codes that end the view. Other errors carrying a request ID only report on the footer. */
const FATAL_CODES: Record<AgentAttachErrorCode, boolean> = {
	unauthorized: true,
	unsupported_version: true,
	not_found: true,
	ambiguous: true,
	session_gone: true,
	transport_limit: true,
	lagged: true,
	command_failed: false,
	invalid_request: false,
};
const EMPTY_QUEUE: QueueState = { steering: [], followUp: [], liveSteered: 0 };
/** Logical transcript rows per mouse wheel notch. */
const WHEEL_ROWS = 3;

/** One line of control-free text for chrome rows and notices. */
function oneLine(value: unknown): string {
	return sanitizeErrorLine(value);
}

function joinParts(parts: readonly string[]): string {
	return parts.join(theme.fg("dim", ` ${theme.sep.dot} `));
}

/** Name of the tool call still being generated at the end of an assistant message. */
function streamingToolName(message: AssistantAgentMessage): string | undefined {
	const last = message.content.at(-1);
	return last?.type === "toolCall" ? last.name : undefined;
}

function entryTimestamp(message: AgentMessage): string {
	const ms = "timestamp" in message ? message.timestamp : undefined;
	return new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function queueText(queue: QueueState): string | undefined {
	const items = [
		...queue.steering.map(text => `steer: ${oneLine(text)}`),
		...queue.followUp.map(text => `follow-up: ${oneLine(text)}`),
	];
	return items.length > 0 ? `queued ${items.join(" · ")}` : undefined;
}

class AgentAttachView implements Component, Focusable {
	readonly #ui: TUI;
	readonly #client: AgentAttachClient;
	readonly #end: (outcome: ViewOutcome) => void;
	readonly #editor = new Editor(getEditorTheme());
	readonly #browser: TranscriptBrowser;
	readonly #unsubscribe: () => void;
	readonly #onSignal = (): void => this.#end({ end: "detached" });

	/** Identity from the latest snapshot_start. */
	#identity: AgentAttachSnapshotStart | undefined;
	#status: "running" | "idle" = "idle";
	#builder: ChatTranscriptBuilder | undefined;
	/** Entries collected between snapshot_start and snapshot_end; undefined outside a snapshot. */
	#pending: SessionMessageEntryLike[] | undefined;
	/** The uncommitted assistant message, kept outside the builder until its message_end. */
	#stream: AssistantMessageComponent | undefined;
	/** Tool results replayed from a snapshot; their live message_end must not render twice. */
	#suppressedToolResults = new Set<string>();
	#entryCount = 0;
	#activity: string | undefined;
	#queue: QueueState = EMPTY_QUEUE;
	/** Text handed to the owner and not yet acknowledged. */
	#sending: string | undefined;
	#notice: string | undefined;
	#disposed = false;

	constructor(ui: TUI, client: AgentAttachClient, end: (outcome: ViewOutcome) => void) {
		this.#ui = ui;
		this.#client = client;
		this.#end = end;
		this.#browser = new TranscriptBrowser({
			getHeight: () => ui.terminal?.rows || process.stdout.rows || 40,
			frame: context => this.#frame(context),
			followBottom: true,
		});
		this.#editor.setMaxHeight(4);
		this.#editor.onSubmit = text => this.#submit(text);
		this.#unsubscribe = client.onFrame(frame => this.#onFrame(frame));
		process.on("SIGINT", this.#onSignal);
		process.on("SIGTERM", this.#onSignal);
		process.on("SIGHUP", this.#onSignal);
	}

	get focused(): boolean {
		return this.#editor.focused;
	}

	set focused(value: boolean) {
		this.#editor.focused = value;
	}

	render(width: number): readonly string[] {
		return this.#browser.render(width);
	}

	invalidate(): void {
		this.#browser.invalidate();
	}

	/** Stop listening and close only this attachment. The child is untouched. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		process.off("SIGINT", this.#onSignal);
		process.off("SIGTERM", this.#onSignal);
		process.off("SIGHUP", this.#onSignal);
		this.#client.close();
		this.#dropStream();
		this.#builder?.dispose();
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#browser.scroll(event.wheel * WHEEL_ROWS);
					this.#ui.requestRender();
				}
				return true;
			});
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.#abort();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.#editor.getText().length > 0) {
				this.#editor.setText("");
				this.#ui.requestRender();
				return;
			}
			this.#end({ end: "detached" });
			return;
		}
		if (matchesKey(data, "ctrl+d") && this.#editor.getText().length === 0) {
			this.#end({ end: "detached" });
			return;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			if (this.#browser.handleScrollKey(data)) this.#ui.requestRender();
			return;
		}
		this.#editor.handleInput(data);
		this.#ui.requestRender();
	}

	// ========================================================================
	// Owner frames
	// ========================================================================

	#onFrame(frame: AgentAttachServerFrame): void {
		if (this.#disposed) return;
		try {
			this.#apply(frame);
		} catch (error) {
			this.#end({ end: "disconnected", reason: `view failed: ${oneLine(error)}` });
			return;
		}
		this.#ui.requestRender();
	}

	#apply(frame: AgentAttachServerFrame): void {
		switch (frame.type) {
			case "snapshot_start":
				this.#beginSnapshot(frame);
				return;
			case "snapshot_message":
				this.#pending?.push(this.#entry(frame.message));
				return;
			case "snapshot_end":
				this.#endSnapshot(frame);
				return;
			case "event":
				this.#applyEvent(frame.event);
				return;
			case "run_state":
				this.#status = frame.state;
				return;
			case "error":
				this.#onError(frame);
				return;
			case "found":
			case "ack":
				// Lookup replies and acknowledgements are consumed by the client.
				return;
		}
	}

	#onError(frame: ErrorFrame): void {
		if (frame.requestId === undefined || FATAL_CODES[frame.code]) {
			this.#end({ end: "disconnected", reason: oneLine(frame.message) });
			return;
		}
		this.#notice = oneLine(frame.message);
	}

	#beginSnapshot(start: AgentAttachSnapshotStart): void {
		this.#identity = start;
		this.#status = start.status;
		this.#builder?.dispose();
		this.#builder = new ChatTranscriptBuilder({
			ui: this.#ui,
			cwd: start.cwd,
			// Charts are for the main session's answers, not a subagent's transcript.
			tableCharts: false,
			requestRender: () => this.#ui.requestRender(),
		});
		this.#dropStream();
		this.#suppressedToolResults.clear();
		this.#activity = undefined;
		this.#pending = [];
	}

	#endSnapshot(end: AgentAttachSnapshotEnd): void {
		const builder = this.#builder;
		if (!builder || !this.#pending) return;
		builder.rebuild(this.#pending);
		this.#pending = undefined;
		this.#queue = end.queue;
		for (const result of end.pendingToolResults) this.#suppressedToolResults.add(result.toolCallId);
		builder.append(end.pendingToolResults.map(result => this.#entry(result)));
		for (const update of end.activeToolExecutionUpdates) builder.applyToolEvent(update);
		if (end.streamMessage?.role === "assistant") this.#streamAssistant(end.streamMessage);
	}

	#applyEvent(event: AgentSessionEvent): void {
		const builder = this.#builder;
		if (!builder) return;
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") this.#streamAssistant(event.message);
				return;
			case "message_end":
				this.#commit(event.message);
				return;
			case "tool_execution_start":
				this.#activity = `running ${event.toolName}`;
				builder.applyToolEvent(event);
				return;
			case "tool_execution_update":
			case "tool_stream_update":
				builder.applyToolEvent(event);
				return;
			case "tool_execution_end":
				this.#activity = undefined;
				return;
			case "agent_end":
				this.#dropStream();
				this.#activity = undefined;
				return;
			case "queue_update":
				this.#queue = { steering: event.steering, followUp: event.followUp, liveSteered: event.liveSteered };
				return;
			default:
				return;
		}
	}

	/** Show the in-flight assistant text up to its first tool call, updated in place. */
	#streamAssistant(message: AssistantAgentMessage): void {
		this.#stream ??= new AssistantMessageComponent(undefined, false, () => this.#ui.requestRender());
		this.#stream.updateContent(splitAssistantMessageToolTimeline(message).beforeTools, { transient: true });
		const calling = streamingToolName(message);
		if (calling !== undefined) this.#activity = `calling ${calling}`;
	}

	/** Commit a finished message. Assistant text leaves the stream component first so it never shows twice. */
	#commit(message: AgentMessage): void {
		const builder = this.#builder;
		if (!builder) return;
		if (message.role === "assistant") {
			this.#dropStream();
			this.#activity = undefined;
		}
		if (message.role === "toolResult" && this.#suppressedToolResults.delete(message.toolCallId)) return;
		builder.append([this.#entry(message)]);
	}

	#dropStream(): void {
		this.#stream?.dispose();
		this.#stream = undefined;
	}

	#entry(message: AgentMessage): SessionMessageEntryLike {
		this.#entryCount += 1;
		return {
			type: "message",
			id: String(this.#entryCount),
			parentId: null,
			timestamp: entryTimestamp(message),
			message,
		};
	}

	// ========================================================================
	// Commands
	// ========================================================================

	#submit(text: string): void {
		if (this.#sending !== undefined) {
			// Editor already cleared itself; put the text back for correction.
			this.#editor.setText(text);
			this.#notice = "Previous message is still sending.";
			this.#ui.requestRender();
			return;
		}
		this.#notice = undefined;
		this.#sending = text;
		this.#ui.requestRender();
		void this.#client.steer(text).then(
			() => this.#settleSend(),
			error => this.#settleSend(text, error),
		);
	}

	/** Clear the pending state; a rejected send restores its text without an optimistic transcript row. */
	#settleSend(failedText?: string, error?: unknown): void {
		if (this.#disposed) return;
		this.#sending = undefined;
		if (failedText !== undefined) {
			this.#notice = `Not delivered: ${oneLine(error)}`;
			const draft = this.#editor.getText();
			this.#editor.setText(draft ? `${failedText}\n${draft}` : failedText);
		}
		this.#ui.requestRender();
	}

	#abort(): void {
		this.#notice = undefined;
		void this.#client.abort().catch(error => {
			if (this.#disposed) return;
			this.#notice = `Abort failed: ${oneLine(error)}`;
			this.#ui.requestRender();
		});
		this.#ui.requestRender();
	}

	// ========================================================================
	// Render
	// ========================================================================

	#frame(context: TranscriptBrowserRenderContext): TranscriptBrowserFrame {
		return {
			header: this.#headerLines(context.chromeWidth),
			body: { lines: this.#bodyLines(context.contentWidth) },
			footer: this.#footerLines(context.chromeWidth),
		};
	}

	#headerLines(width: number): string[] {
		const identity = this.#identity;
		if (!identity) return [truncateToWidth(theme.fg("dim", "Connecting to live subagent…"), width)];
		const model = identity.model ? `${identity.model.provider}/${identity.model.id}` : "no model";
		const status = this.#status === "running" ? theme.fg("success", "running") : theme.fg("muted", "idle");
		const title = joinParts([
			theme.fg("accent", "Attached"),
			theme.bold(oneLine(identity.agentId)),
			status,
			theme.fg("muted", oneLine(model)),
		]);
		const details = [
			identity.displayName && identity.displayName !== identity.agentId ? oneLine(identity.displayName) : "",
			`owner ${oneLine(identity.ownerSessionId)}`,
			oneLine(shortenPath(identity.cwd)),
		].filter(Boolean);
		return [truncateToWidth(title, width), truncateToWidth(theme.fg("dim", joinParts(details)), width)];
	}

	#bodyLines(width: number): readonly string[] {
		if (!this.#builder) return [` ${theme.fg("dim", "Waiting for transcript…")}`];
		const lines = [...this.#builder.container.render(width), ...(this.#stream?.render(width) ?? [])];
		return lines.length > 0 ? lines : [` ${theme.fg("dim", "No messages yet.")}`];
	}

	#footerLines(width: number): string[] {
		const lines: string[] = [];
		if (this.#notice) lines.push(truncateToWidth(theme.fg("error", this.#notice), width));
		const status: string[] = [];
		if (this.#sending !== undefined) status.push("sending…");
		if (this.#activity !== undefined) status.push(oneLine(this.#activity));
		if (status.length > 0) lines.push(truncateToWidth(theme.fg("accent", joinParts(status)), width));
		const queued = queueText(this.#queue);
		if (queued) lines.push(truncateToWidth(theme.fg("muted", queued), width));
		lines.push(...this.#editor.render(width));
		lines.push(truncateToWidth(theme.fg("dim", this.#hints()), width));
		return lines;
	}

	#hints(): string {
		const send = editorKey("tui.input.submit");
		return [
			send ? `${send}:send` : "",
			`${formatKeyHint("ctrl+c")}:abort child`,
			`${formatKeyHints(["escape", "ctrl+d"])}:detach (esc clears draft first)`,
			`${formatKeyHints(["pageUp", "pageDown"])}:scroll`,
		]
			.filter(Boolean)
			.join("  ");
	}
}

/**
 * Run the attached view until the user detaches or the owner ends the connection.
 * Resolves `detached` for intentional detach and local termination signals. Resolves
 * `disconnected` when the owner ends the connection, after printing the reason to
 * stderr. The terminal is restored on every path.
 */
export async function runAgentAttachView(client: AgentAttachClient): Promise<"detached" | "disconnected"> {
	const { promise, resolve } = Promise.withResolvers<ViewOutcome>();
	const ui = new TUI(new ProcessTerminal());
	const view = new AgentAttachView(ui, client, resolve);
	let overlay: OverlayHandle | undefined;
	try {
		overlay = ui.showOverlay(view, {
			fullscreen: true,
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		ui.setFocus(view);
		ui.start();
		const outcome = await promise;
		if (outcome.reason !== undefined) {
			process.stderr.write(`agent attach ended: ${outcome.reason}\n`);
		}
		return outcome.end;
	} finally {
		view.dispose();
		overlay?.hide();
		ui.stop();
	}
}
