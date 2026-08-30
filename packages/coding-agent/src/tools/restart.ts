/**
 * restart — cooperatively recycle this session to pick up host-staged changes
 * that a live `refresh` cannot reach (new extensions, project context, slash
 * commands, prompt templates, the tool roster, the model/provider registry).
 *
 * Restart recycles ONLY this session (same loaded engine code): the host
 * quiesces the running turn, flushes the transcript to disk, disposes the
 * session, then re-opens it from its file. Picking up a new engine *binary* is a
 * host-process operation, never this per-agent tool.
 *
 * Deadlock-critical shape: `execute()` returns an acknowledgement immediately,
 * then fires `requestRestart()` from an UNTRACKED continuation — never inline
 * (its `waitForIdle()` cannot resolve while the tool blocks the turn) and never
 * via `#schedulePostPromptTask` (that scheduler always tracks the task in
 * `#postPromptTasks`, and `requestRestart()`'s own `waitForIdle()` / `dispose()`
 * await that very set → self-deadlock). Absent from `#postPromptTasks`, the
 * continuation sits in neither set the restart drains; `requestRestart()`'s
 * internal `waitForIdle()` supplies the "let this turn settle" wait.
 *
 * Result reporting splits on dispose ordering. Pre-dispose refusals
 * (`busy`/`unavailable`/`no-session-file`, returned as `{ ok: false }` before
 * teardown) surface to the still-open transcript so the model sees them. A
 * pre-dispose THROW (flush/ensureOnDisk rejected before dispose began — the
 * session is still alive and unlatched) is likewise surfaced: the recycle did
 * not happen, so the model must learn it. Only a post-dispose host-callback
 * throw is log-only — dispose already closed the transcript, so there is no
 * caller to inform; recovery is via the durable session file. Never left
 * unhandled, never silently swallowed.
 */
import * as os from "node:os";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import restartDescription from "../prompts/tools/restart.md" with { type: "text" };
import { createCustomMessage } from "../session/messages";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";
import type { ToolSession } from "./index";
import type { OutputMeta } from "./output-meta";
import { toolResult } from "./tool-result";

const restartSchema = type({});

/** Details payload for TUI rendering of a restart acknowledgement. */
export interface RestartToolDetails {
	scheduled: boolean;
	meta?: OutputMeta;
}

/** One-line notice describing why a scheduled restart refused before teardown. */
function refusalNotice(reason: "unavailable" | "no-session-file" | "busy"): string {
	switch (reason) {
		case "unavailable":
			return "Restart was not performed: restart is unavailable in this session.";
		case "no-session-file":
			return "Restart was not performed: this session has no session file to re-attach.";
		case "busy":
			return "Restart was not performed: input is still queued. Retry once the session is idle.";
	}
}

export class RestartTool implements AgentTool<typeof restartSchema, RestartToolDetails> {
	readonly name = "restart";
	// `exec` tier: restart disposes and recycles the session. As a
	// model-discoverable tool it must NOT auto-run in always-ask/write modes —
	// same tier and reasoning as `refresh`. Auto-runs only in yolo.
	readonly approval = "exec" as const;
	readonly label = "Restart";
	readonly summary = "Recycle this session to pick up host-staged changes refresh cannot reach";
	readonly description: string;
	readonly parameters = restartSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(restartDescription);
	}

	/**
	 * Offer the tool only when a host `onRestartRequested` callback is wired
	 * (`session.requestRestart` bound) — mirrors how the SDK binds the method.
	 * Absent the callback there is nothing to drive, so the tool is not created
	 * rather than presented as one that always errors.
	 */
	static createIf(session: ToolSession): RestartTool | null {
		if (!session.requestRestart) return null;
		return new RestartTool(session);
	}

	async execute(
		_toolCallId: string,
		_params: typeof restartSchema.infer,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RestartToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RestartToolDetails>> {
		const requestRestart = this.session.requestRestart;
		if (!requestRestart) {
			return {
				content: [{ type: "text", text: "Restart is unavailable in this session." }],
				isError: true,
				details: { scheduled: false },
			};
		}

		// Fire from an UNTRACKED continuation (a detached promise, never a tracked
		// post-prompt task). requestRestart()'s own waitForIdle() defers the actual
		// recycle until this turn settles, so returning the ack first does not race
		// teardown. Report the outcome; never leave the promise unhandled.
		void requestRestart()
			.then(result => {
				if (result.ok) return;
				// Pre-dispose refusal: the session is still alive, so surface it to
				// the transcript. queueDeferredMessage triggers a turn so the model
				// reacts to the refusal instead of silently believing it restarted.
				this.session.queueDeferredMessage?.(
					createCustomMessage(
						"restart-refused",
						refusalNotice(result.reason),
						true,
						undefined,
						new Date().toISOString(),
					),
				);
			})
			.catch((err: unknown) => {
				// Sanitize before this reaches a `display: true` custom message: a raw
				// rejection can carry tabs, many lines, or an absolute home path, which
				// break TUI layout and leak the home directory (AGENTS.md § TUI
				// Sanitization). Collapse to one line, shorten paths, clamp the width.
				const rawMessage = err instanceof Error ? err.message : String(err);
				// `shortenPath()` only rewrites a string that *starts* with the home dir,
				// so replace every embedded occurrence instead.
				const homeDir = os.homedir();
				const message = truncateToWidth(
					replaceTabs(
						(homeDir ? rawMessage.replaceAll(homeDir, "~") : rawMessage).replace(/\s*\n+\s*/g, " "),
					).trim(),
					TRUNCATE_LENGTHS.LONG,
				);
				// Split on dispose ordering, the same seam requestRestart() latches
				// on. A rejection while the session is still alive is a RECOVERABLE
				// pre-dispose throw (flush()/ensureOnDisk() failed before teardown,
				// latch already cleared): the restart did NOT happen and the
				// transcript is still open, so surface a phase-aware failure the
				// model can act on — otherwise it believes the ack and never learns
				// the recycle was refused. A rejection after dispose is terminal
				// (the host callback threw, old session gone): no open transcript to
				// append to, so log only and rely on the durable session file.
				if (this.session.isDisposed?.() === false) {
					this.session.queueDeferredMessage?.(
						createCustomMessage(
							"restart-refused",
							`Restart was not performed: preparing the session to recycle failed (${message}). The session is still active; retry once it is idle.`,
							true,
							undefined,
							new Date().toISOString(),
						),
					);
				}
				logger.error("restart tool: requestRestart failed", { error: message });
			});

		return toolResult<RestartToolDetails>({ scheduled: true })
			.text("Restart scheduled. It runs once this turn settles; the conversation resumes in the recycled session.")
			.done();
	}
}
