/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `omp -p "prompt"` - text output
 * - `omp --mode json "prompt"` - JSON event stream
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { type AgentSession, type AgentSessionEvent, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { isSilentAbort } from "../session/messages";
import { flushTelemetryExport } from "../telemetry-export";
import { initializeExtensions } from "./runtime-init";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** If true, include thinking blocks in text output */
	printThoughts?: boolean;
	/** Whether the caller explicitly started the headless plan flow. */
	planYolo?: boolean;
}

/** Matches the longest built-in provider request deadline while bounding tool-loop stalls. */
export const PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Error exits cannot hold automation for the full normal drain budget. */
export const PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS = 30_000;

/** Drop the provider-opaque replay payload (e.g. encrypted reasoning items) before printing. */
function stripProviderPayload<T extends AgentMessage>(message: T): T {
	if (!("providerPayload" in message) || message.providerPayload === undefined) return message;
	const { providerPayload: _providerPayload, ...rest } = message;
	return rest as T;
}

/**
 * Shape an event for `--mode json` output.
 *
 * Removes two classes of bloat so transcripts grow linearly with conversation
 * size instead of quadratically (a single long turn used to re-serialize its
 * whole in-progress message on every streamed delta, producing multi-GB logs):
 * - `message_update` snapshots (`message`, `assistantMessageEvent.partial`,
 *   and the `done`/`error` payloads) are dropped; only the incremental delta
 *   is printed. The authoritative message follows in `message_end`.
 * - `providerPayload` is transport-native replay state, opaque and useless
 *   outside this process.
 */
export function printableEvent(event: AgentSessionEvent): unknown {
	switch (event.type) {
		case "tool_stream_update":
			return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName };
		case "message_update": {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "done" || streamEvent.type === "error") {
				return {
					type: "message_update",
					assistantMessageEvent: { type: streamEvent.type, reason: streamEvent.reason },
				};
			}
			const { partial: _partial, ...rest } = streamEvent;
			return { type: "message_update", assistantMessageEvent: rest };
		}
		case "message_start":
		case "message_end":
			return { ...event, message: stripProviderPayload(event.message) };
		case "turn_end":
			return {
				...event,
				message: stripProviderPayload(event.message),
				toolResults: event.toolResults.map(stripProviderPayload),
			};
		case "agent_end":
			return { ...event, messages: event.messages.map(stripProviderPayload) };
		default:
			return event;
	}
}

/**
 * Run in print (single-shot) mode.
 *
 * Sends prompts, writes the selected output format, disposes the session, and
 * returns the process exit code for the completed turn.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts, planYolo = false } = options;

	// process.stdout.write is fire-and-forget: a large final record (e.g. a
	// multi-MB agent_end) can be dropped when the process exits before the pipe
	// drains, truncating the record mid-line while the process still exits 0.
	// Serialize every stdout write on the previous write's completion callback so
	// records stay ordered and honor backpressure, then block shutdown on the
	// tail before dispose/exit. Same truncation class as issue #5309 (issue #7635).
	let stdoutTail: Promise<void> = Promise.resolve();
	const writeStdoutLine = (text: string): void => {
		stdoutTail = stdoutTail.then(() => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			process.stdout.write(text, err => {
				if (err) reject(err);
				else resolve();
			});
			return promise;
		});
	};

	// Emit session header for JSON mode
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			writeStdoutLine(`${JSON.stringify(header)}\n`);
		}
	}
	// Set up extensions for print mode (no UI, no command context)
	await initializeExtensions(session, {
		mode: mode === "json" ? "json" : "print",
		reportSendError: (action, err) => {
			process.stderr.write(
				`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${err.message}\n`,
			);
		},
		reportRuntimeError: err => {
			process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
		},
	});

	// `plan.defaultOnStartup` opens fresh *interactive* sessions in plan mode so a
	// human can review the plan before it executes. Headless print mode has no
	// surface to review, approve, or exit a plan from, and the turn carries no
	// deterministic way out of plan mode — the model must voluntarily emit a valid
	// `xd://propose` execute-dispatch, and when it does not the run strands until
	// the deadline (issue #8272). So do not honor the startup default here; the
	// supported headless plan flow is `--plan-yolo` (auto-approve → implement),
	// which is wired independently through the prewalk coordinator.
	const planStartupIgnored =
		session.settings.get("plan.defaultOnStartup") &&
		session.settings.get("plan.enabled") &&
		session.sessionManager.buildSessionContext().messages.length === 0 &&
		!session.sessionManager.getEntries().some(entry => entry.type === "mode_change") &&
		!planYolo;
	if (planStartupIgnored) {
		process.stderr.write(
			"Note: plan.defaultOnStartup is ignored in print mode (no interactive surface to review the plan). Use --plan-yolo for a headless plan flow.\n",
		);
	}

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		// In JSON mode, output all events
		if (mode === "json") {
			writeStdoutLine(`${JSON.stringify(printableEvent(event))}\n`);
			return;
		}
		// Text mode has no transcript to carry a notice: a warning raised mid-run
		// (an account signed out while a sibling took the request) goes to stderr,
		// where the run's other diagnostics already live.
		if (event.type === "notice" && event.level !== "info") {
			const message = event.source ? `${event.source}: ${event.message}` : event.message;
			process.stderr.write(`${sanitizeText(message)}\n`);
		}
	});

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};

	// Send initial message with attachments
	if (initialMessage !== undefined) {
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		await logger.time("print:prompt:initial", () => session.prompt(initialMessage, { images: initialImages }));
	}

	// Send remaining messages
	for (const message of messages) {
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		await logger.time("print:prompt:next", () => session.prompt(message));
	}

	// From this point onward a late blocker must be recorded without starting a
	// primary turn whose response print mode would never emit.
	session.prepareForHeadlessAdvisorDrain();

	// Read via the session accessor, not the raw state tail: a classifier
	// refusal is pruned from active context at settle, and an aborted turn
	// can trail synthetic tool results — both would hide the terminal
	// assistant message (and its error) from a last-element read.
	const assistantMsg = session.getLastAssistantMessage();
	// The terminal stop reason decides the process exit code in every output
	// mode: `--mode json` used to report success for the same turn-fatal error
	// text mode exits 1 on (issue #11498). Silent aborts (plan-mode compaction
	// transitions) stay non-fatal in both modes.
	const terminalFailure =
		assistantMsg !== undefined &&
		(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
		!isSilentAbort(assistantMsg);

	// In text mode, output the final response. A terminal failure prints only
	// the error line below; JSON mode already emitted the assistant message and
	// stop reason through the event subscription.
	if (mode === "text" && !terminalFailure) {
		if (assistantMsg) {
			if (
				assistantMsg.errorMessage &&
				assistantMsg.stopReason !== "error" &&
				assistantMsg.stopReason !== "aborted"
			) {
				process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
			}

			// Output text content
			for (const content of assistantMsg.content) {
				if (content.type === "text") {
					writeStdoutLine(`${sanitizeText(content.text)}\n`);
				} else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0) {
					writeStdoutLine(`${sanitizeText(content.thinking)}\n`);
				}
			}
		}
		session.setTextOutputCommitted(true);
	}

	// A turn-fatal exit cannot hold automation for the full normal drain budget.
	await session.waitForAdvisorCatchup(
		terminalFailure ? PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS : PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS,
	);
	// Error spans must reach the exporter; the postmortem `exit` handler can't await.
	if (terminalFailure) await flushTelemetryExport();

	// Block shutdown until every serialized stdout write (including the final
	// agent_end and late JSON advisor events) has drained; process.exit would
	// otherwise discard the buffered tail and truncate the last record.
	await stdoutTail;
	// Dispose before returning the status instead of hard-exiting ahead of it:
	// the awaited `dispose()` runs the browser reaper (releaseTabsForOwner), so
	// an OMP-owned Chromium cannot survive the exit (issue #5643).
	await session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });

	// Text mode reports the terminal failure on stderr exactly as before: same
	// line, same ordering after dispose, without terminating the process here.
	if (mode === "text" && terminalFailure && assistantMsg) {
		const errorLine = sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
		if (!process.stderr.write(`${errorLine}\n`)) {
			const { promise, resolve } = Promise.withResolvers<void>();
			process.stderr.once("drain", resolve);
			await promise;
		}
	}

	return terminalFailure ? 1 : 0;
}
