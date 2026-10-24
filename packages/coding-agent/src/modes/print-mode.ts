/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `omp -p "prompt"` - text output
 * - `omp --mode json "prompt"` - JSON event stream
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { presentNarrationAsAnswer } from "@oh-my-pi/pi-ai/utils/narration";
import { $flag, logger, postmortem, sanitizeText } from "@oh-my-pi/pi-utils";
import type { MCPManager } from "../mcp/manager";
import { resolveMCPTimeoutMs } from "../mcp/timeout";
import { type AgentSession, type AgentSessionEvent, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { CREDENTIAL_DISABLED_NOTICE_SOURCE } from "../session/credential-disabled-notice";
import { isSilentAbort } from "../session/messages";
import { flushTelemetryExport } from "../telemetry-export";
import { executeAcpBuiltinSlashCommand } from "../slash-commands/acp-builtins";
import { parseSlashCommand, parseSubcommand } from "../slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "../slash-commands/types";
import { reconnectMcpManagerServer } from "../mcp/oauth-reauth";
import {
	formatPersistenceDurabilityFailure,
	formatPersistenceFailure,
	formatPersistenceNotice,
} from "./persistence-failure";
import { initializeExtensions } from "./runtime-init";

import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from "../plan-mode/settings";

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
	/** Manager returned by session creation; only print mode waits for its servers. */
	mcpManager?: MCPManager;
}

/** Matches the longest built-in provider request deadline while bounding tool-loop stalls. */
export const PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Error exits cannot hold automation for the full normal drain budget. */
export const PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS = 30_000;

/** Sanitize untrusted text (server names, errors) into one stderr-safe line. */
function singleLine(text: string): string {
	return sanitizeText(text).replace(/[\r\n\t]+/g, " ");
}

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
	// A signal (SIGINT/SIGTERM/SIGHUP) landing mid-turn drives the exit code
	// through postmortem (130/143/129). Record the reason so the aborted-response
	// branch below never races that with its own ordinary failure status.
	let signalReason: postmortem.Reason | undefined;
	const cancelSignalTeardown = postmortem.register("print-mode-session", reason => {
		signalReason = reason;
		return session.dispose({ reason, mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
	});
	try {
		return await runPrintModeCore(session, options, () => signalReason !== undefined);
	} finally {
		cancelSignalTeardown();
	}
}

async function runPrintModeCore(
	session: AgentSession,
	options: PrintModeOptions,
	signalTeardownActive: () => boolean,
): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts, planYolo = false } = options;
	session.disableStopTimeTodoReminders();

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
		cfgPlanDefaultOnStartup.get(session.settings) &&
		cfgPlanEnabled.get(session.settings) &&
		session.sessionManager.buildSessionContext().messages.length === 0 &&
		!session.sessionManager.getEntries().some(entry => entry.type === "mode_change") &&
		!planYolo;
	if (planStartupIgnored) {
		process.stderr.write(
			"Note: plan.defaultOnStartup is ignored in print mode (no interactive surface to review the plan). Use --plan-yolo for a headless plan flow.\n",
		);
	}

	// process.stderr.write is fire-and-forget as well: a diagnostic buffered
	// behind a backpressured pipe would still be undelivered when runPrintMode
	// returns, and the caller drains stdout only. Serialize the persistence
	// diagnostics and await the tail before returning.
	let stderrTail: Promise<void> = Promise.resolve();
	const writeStderrLine = (line: string): void => {
		stderrTail = stderrTail
			.then(async () => {
				if (process.stderr.write(`${line}\n`)) return;
				const { promise, resolve } = Promise.withResolvers<void>();
				// A closed stream never emits `drain`; resolve on error/close too so
				// an undeliverable diagnostic cannot strand the tail.
				const settle = (): void => {
					process.stderr.off("drain", settle);
					process.stderr.off("error", settle);
					process.stderr.off("close", settle);
					resolve();
				};
				process.stderr.on("drain", settle);
				process.stderr.on("error", settle);
				process.stderr.on("close", settle);
				await promise;
			})
			// A stderr that throws (EPIPE) must not poison the tail: it would skip
			// every later diagnostic and reject the awaited tail below.
			.catch(() => {});
	};
	// Route slash input through the shared dispatcher so builtins run locally
	// (e.g. `/mcp reauth <name>` opens the browser) instead of prompting the
	// model with the literal text. Unknown or non-slash input falls through to
	// the model; a `{ prompt }` residual is forwarded. Diagnostics go to stderr
	// so stdout stays pure model output (critical in JSON mode).
	// The runtime is rebuilt per dispatch: an earlier positional message (e.g.
	// `/move`, `/wt`) may have changed the session cwd, and manager state may
	// have moved since the last one.
	const mcpManager = options.mcpManager;
	const builtinRuntimeFor = (): SlashCommandRuntime => ({
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		cwd: session.sessionManager.getCwd(),
		output: writeStderrLine,
		refreshCommands: () => {},
		reloadPlugins: () => Promise.resolve(),
		mcpManager,
		reconnectMcpServer: mcpManager
			? async (name, selected) => {
					const state = await reconnectMcpManagerServer(mcpManager, name, selected);
					if (state) {
						// Print mode wires no tools-changed callback; refresh the
						// session binding so later prompts see the recovered tools.
						await session.refreshMCPTools(mcpManager.getTools());
					}
					return state;
				}
			: undefined,
		// `/retry` only schedules its continuation (`session.retry()` posts a
		// post-prompt task) and returns before the retried turn streams: hold
		// the dispatch open until the session is idle — same pairing as the
		// ACP runtime — or the next CLI-authored message would prompt ~1ms
		// later and race the just-scheduled turn it should follow.
		keepTurnOpenUntilIdle: async () => {
			await session.waitForIdle();
		},
	});
	// Whether a dispatched command consumed an input but failed (usage error,
	// unknown server, refused operation). Print mode is automation surface: a
	// failed `/mcp reauth` must not exit 0, or scripts treat a failed
	// reauthorization as success.
	let builtinFailed = false;
	// Whether any input reached the model as a prompt this invocation. A run
	// where every input was consumed locally creates no assistant turn, so the
	// persisted previous turn must not be reprinted or its old stop reason
	// reused as this run's exit status.
	let admittedAgentTurn = false;
	// The print-mode-dispatched commands. Only commands whose runtime hooks
	// are real in the headless runtime belong here: each runs a session API
	// (`/mcp reauth` engine, `session.compact`, `session.handoff`,
	// `session.retry`). Commands whose hooks would be stubs
	// (`/reload-plugins` and friends) stay undispatched, and so does
	// `/stats`: its dashboard server is in-process (`Bun.serve` inside this
	// one-shot run), so launching it would open a browser tab that dies with
	// the process and report a success the run cannot deliver. Keeping the
	// process alive until the dashboard closes is a separate design
	// decision; until then `/stats` keeps the historic prompt-the-literal
	// behavior of every undispatched command.
	// Matched with the dispatcher's own parser, so `/compact:focus` and
	// `/compact focus` are treated alike; `/mcp` dispatches only `reauth`.
	const PRINT_DISPATCHED_COMMANDS: Record<string, true> = { compact: true, handoff: true, retry: true };
	/**
	 * Dispatch a CLI-authored message as a local command, if it is one.
	 * Only CLI-authored input (`messages`, the positional/-p args) is ever
	 * dispatched. The merged stdin/@file `initialMessage` is attacker-shaped
	 * end to end — `curl … | omp "summarize"` must never run a slash payload
	 * from the pipe as a command — so it always prompts the model as text.
	 * Commands outside the dispatched list keep the historic behavior of
	 * prompting the model with the literal text. Returns whether the message
	 * was consumed locally.
	 */
	const dispatchCliMessage = async (message: string): Promise<boolean> => {
		const parsed = parseSlashCommand(message);
		const dispatched =
			parsed !== null &&
			(parsed.name === "mcp"
				? parseSubcommand(parsed.args).verb === "reauth"
				: Object.hasOwn(PRINT_DISPATCHED_COMMANDS, parsed.name));
		if (!dispatched) return false;
		// `/retry` schedules its model turn outside `promptTurn`
		// (`session.retry()` posts the continuation as a post-prompt task),
		// so run `promptTurn`'s pre-turn prep BEFORE the command executes:
		// the readiness binding (`waitForStartup` + `refreshMCPTools`), the
		// strict `OMP_MCP_REQUIRE_READY` gate, the working indicator, and
		// the uncommitted text output. Without it the retried turn would
		// stream without the MCP tools turn one gets, strict automation
		// would pass on a run it should fail, and turn recovery would treat
		// buffered text as already committed.
		if (parsed.name === "retry" && !(await prepareAgentTurn())) {
			// The strict gate refused the turn the command would schedule:
			// reported, consumed without executing, and the run exits 1.
			return true;
		}
		const result = await executeAcpBuiltinSlashCommand(message, builtinRuntimeFor());
		// The allow-list only matches registered commands, so `false` (not a
		// command) and a `{ prompt }` residual cannot occur; stay defensive.
		if (result === false || "prompt" in result) return false;
		if (result.failed) builtinFailed = true;
		// A builtin that scheduled a real agent turn (`/retry`) admitted that
		// turn: its answer (and stop reason) belong to this run.
		if (result.agentInvoked) admittedAgentTurn = true;
		// A recovery command may have repaired a server the strict gate
		// failed on, so the gate re-evaluates before the next model turn.
		return true;
	};

	// Discriminates a store failure from any other dispose rejection below.
	let persistenceFailure: Error | undefined;
	session.sessionManager.onPersistenceError(error => {
		persistenceFailure = error;
		writeStderrLine(formatPersistenceFailure(error.message));
	});
	session.sessionManager.onPersistenceNotice(notice => {
		writeStderrLine(`Warning: ${formatPersistenceNotice(notice)}`);
	});

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		// In JSON mode, output all events
		if (mode === "json") {
			writeStdoutLine(`${JSON.stringify(printableEvent(event))}\n`);
		} else if (event.type === "notice" && event.source === CREDENTIAL_DISABLED_NOTICE_SOURCE) {
			// Text mode renders no session notices, but an automatic sign-out must not stay
			// hidden behind a sibling account that quietly answers the prompt.
			writeStderrLine(`Warning: ${event.message}`);
		}
	});

	const timeoutMs = resolveMCPTimeoutMs();
	const strict = $flag("OMP_MCP_REQUIRE_READY");
	let strictMCPFailure = false;
	// Warn once per unavailable server across evaluations: readiness is
	// re-evaluated after a dispatched recovery command, and a still-broken
	// server must not repeat its warning on every pass.
	const warnedUnavailable = new Set<string>();
	/** Await manager startup and bind its current tool set; report unavailable server names. */
	const evaluateReadiness = async (): Promise<string[]> => {
		if (!options.mcpManager) return [];
		const readiness = await options.mcpManager.waitForStartup(timeoutMs);
		// The manager's initial callback may have fired before SDK wiring, or a
		// reconnect may have fired it without awaiting the session mutation.
		// Refresh is serialized by AgentSession, so turn one sees the final snapshot.
		await session.refreshMCPTools(options.mcpManager.getTools());
		const unavailable: string[] = [];
		for (const name of readiness.pending) {
			const server = singleLine(name);
			unavailable.push(server);
			if (warnedUnavailable.has(server)) continue;
			warnedUnavailable.add(server);
			const after = timeoutMs > 0 ? ` after ${timeoutMs}ms` : "";
			writeStderrLine(`Warning: MCP server "${server}" not ready${after}; its tools are unavailable for this run.`);
		}
		for (const { name, error } of readiness.failed) {
			const server = singleLine(name);
			unavailable.push(server);
			if (warnedUnavailable.has(server)) continue;
			warnedUnavailable.add(server);
			writeStderrLine(
				`Warning: MCP server "${server}" failed to connect: ${singleLine(error)}; its tools are unavailable for this run.`,
			);
		}
		return unavailable;
	};
	// Readiness is evaluated lazily — before the first model turn, and again
	// after a dispatched recovery command — never up front: `/mcp reauth` must
	// run before the strict gate decides, or strict automation could never
	// repair the very server the gate failed on.
	let unavailable: string[] = [];
	let readinessDirty = true;
	const ensureReadiness = async (): Promise<void> => {
		if (!readinessDirty) return;
		unavailable = await evaluateReadiness();
		readinessDirty = false;
	};
	const reportStrictFailure = (): void => {
		if (strictMCPFailure) return;
		writeStderrLine(`Error: MCP servers not ready: ${unavailable.join(", ")}`);
		strictMCPFailure = true;
	};

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};
	/**
	 * Pre-turn prep shared by `promptTurn` and the dispatched
	 * turn-scheduling commands (`/retry`): readiness binding, the strict
	 * gate, the working indicator, and the uncommitted text output. Returns
	 * whether the turn may run.
	 */
	const prepareAgentTurn = async (): Promise<boolean> => {
		await ensureReadiness();
		if (strict && unavailable.length > 0) {
			reportStrictFailure();
			return false;
		}
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		return true;
	};
	/** Prompt the model with one input, gated on strict MCP readiness. */
	const promptTurn = async (text: string, images?: PrintModeOptions["initialImages"]): Promise<void> => {
		if (!(await prepareAgentTurn())) return;
		admittedAgentTurn = true;
		await logger.time("print:prompt", () =>
			images !== undefined ? session.prompt(text, { images }) : session.prompt(text),
		);
	};

	// Inputs run in order. The merged stdin/@file message is never dispatched
	// (see dispatchCliMessage): it always prompts the model with its text.
	if (initialMessage !== undefined) {
		await promptTurn(initialMessage, initialImages);
	}
	// Remaining messages are CLI-authored: dispatch the recovery command as
	// reached, prompt everything else.
	for (const message of messages) {
		if (strictMCPFailure) break;
		if (await dispatchCliMessage(message)) {
			readinessDirty = true;
			continue;
		}
		await promptTurn(message);
	}
	// A run with no model turn (every input consumed locally, or none) still
	// reports strict unreadiness: `OMP_MCP_REQUIRE_READY=1 omp -p '/mcp reauth
	// foo'` that failed to repair its server exits with the strict error, not
	// only the builtin's own failure.
	if (strict && !admittedAgentTurn && !strictMCPFailure) {
		await ensureReadiness();
		if (unavailable.length > 0) reportStrictFailure();
	}

	// From this point onward a late blocker must be recorded without starting a
	// primary turn whose response print mode would never emit.
	session.prepareForHeadlessAdvisorDrain();
	await session.waitForIdle();

	// Read via the session accessor, not the raw state tail: a classifier
	// refusal is pruned from active context at settle, and an aborted turn
	// can trail synthetic tool results — both would hide the terminal
	// assistant message (and its error) from a last-element read.
	const assistantMsg = admittedAgentTurn ? session.getLastAssistantMessage() : undefined;
	// The terminal stop reason decides the process exit code in every output
	// mode: `--mode json` used to report success for the same turn-fatal error
	// text mode exits 1 on (issue #11498). Silent aborts (plan-mode compaction
	// transitions) and aborts initiated by signal teardown stay non-fatal here;
	// postmortem owns the signal-specific exit code (130/143/129).
	const terminalFailure =
		!strictMCPFailure &&
		assistantMsg !== undefined &&
		(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
		!isSilentAbort(assistantMsg) &&
		!signalTeardownActive();

	// In text mode, output the final response. A terminal failure prints only
	// the error line below; JSON mode already emitted the assistant message and
	// stop reason through the event subscription.
	if (mode === "text" && !terminalFailure && !strictMCPFailure) {
		if (assistantMsg) {
			if (
				assistantMsg.errorMessage &&
				assistantMsg.stopReason !== "error" &&
				assistantMsg.stopReason !== "aborted"
			) {
				process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
			}

			// Output text content; narration the provider returned as thinking is part of the reply.
			for (const content of presentNarrationAsAnswer(assistantMsg).content) {
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
	if (!strictMCPFailure) {
		// Print mode's drain budget covers a fallback-chain switch; the reviewer's
		// verdict is the point of a headless advisor run, so wait through recovery,
		// and wait on `strict` reviewers past the budget like every primary boundary.
		await session.waitForAdvisorCatchup(
			terminalFailure ? PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS : PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS,
			{ waitThroughRecovery: true, strictWithoutDeadline: true },
		);
	}
	// Error spans must reach the exporter; the postmortem `exit` handler can't await.
	if (terminalFailure) await flushTelemetryExport();

	// Block shutdown until every serialized stdout write (including the final
	// agent_end and late JSON advisor events) has drained; process.exit would
	// otherwise discard the buffered tail and truncate the last record.
	await stdoutTail;
	// Dispose before returning the status instead of hard-exiting ahead of it:
	// the awaited `dispose()` runs the browser reaper (releaseTabsForOwner), so
	// an OMP-owned Chromium cannot survive the exit (issue #5643).
	//
	// A latched store failure rethrows from `dispose()`; report it as lost
	// durability rather than letting it escape as a raw fatal dump.
	let durabilityFailure = false;
	try {
		await session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
	} catch (error) {
		if (!persistenceFailure || error !== persistenceFailure) throw error;
		durabilityFailure = true;
		// The store is still failing at teardown, so this is the moment the
		// transcript stops being retryable and becomes lost.
		writeStderrLine(formatPersistenceDurabilityFailure(persistenceFailure.message));
		await stderrTail;
	}

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

	await stderrTail;
	return terminalFailure || durabilityFailure || strictMCPFailure || builtinFailed ? 1 : 0;
}
