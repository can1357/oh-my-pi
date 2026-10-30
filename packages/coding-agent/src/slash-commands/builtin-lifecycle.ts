import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { SEANCE_SLASH_COMMAND } from "./seance";
import { clearSubmittedText, refuseImages, restoreDetachedDraft, runWithDetachedDraft } from "./helpers/draft";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { logger, setProjectDir } from "@oh-my-pi/pi-utils";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import { rebindMemoryBackendForCwd } from "../hindsight/backend";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../memory-backend";
import { continuesConversation } from "../modes/utils/conversation-position";
import type { FreshSessionResult, HandoffResult } from "../session/agent-session";
import { COMPACT_MODES, parseCompactArgs } from "../session/compact-modes";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { resolveResumableSession, resolveResumeTarget } from "../session/session-listing";
import { toggleSessionPin } from "../session/session-pins";
import {
	cleanSourceCheckoutIfConfigured,
	createSessionWorktree,
	defaultSessionWorktreeBranch,
	formatSessionWorktreeSummary,
	type SessionWorktree,
} from "../session/session-worktree";
import { formatShakeSummary, type ShakeMode } from "../session/shake-types";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import { resolveToCwd } from "../tools/path-utils";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSshAcp } from "./helpers/ssh";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

function formatFreshSessionResult(result: FreshSessionResult): string {
	const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
	return `Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`;
}

export const shutdownHandlerTui = (
	_command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): SlashCommandResult => {
	clearSubmittedText(runtime);
	void runtime.ctx.shutdown();
	return commandConsumed();
};

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	if (verb === "thinking") return "thinking";
	return { error: __ompTranslate('Unknown /shake mode "{0}". Use elide, images, or thinking.', `${verb}`) };
}

/** Format the session's workspace directories (cwd + additional) for display. */
function formatWorkspaceDirectories(runtime: SlashCommandRuntime, note?: string): string {
	const cwd = runtime.sessionManager.getCwd();
	const additional = runtime.sessionManager.getAdditionalDirectories();
	const lines = [
		__ompTranslate("Workspace directories:"),
		__ompTranslate("  {0} (working directory)", `${cwd}`),
		...additional.map(d => `  ${d}`),
	];
	return note ? `${note}\n${lines.join("\n")}` : lines.join("\n");
}
async function fatalMoveFailure(text: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	await runtime.output(text);
	await runtime.session.dispose();
	return commandConsumed();
}

/** A move rollback failed: re-align the workspace to wherever the session ended up and report it. */
async function reportFailedRollback(runtime: SlashCommandRuntime, rollbackError: unknown): Promise<SlashCommandResult> {
	const actual = runtime.sessionManager.getCwd();
	try {
		await rescopeHeadlessToCwd(runtime, actual);
	} catch {
		return fatalMoveFailure(
			__ompTranslate(
				"Move failed and rollback failed: {0} (failed to re-align workspace to {1}; process remains at source while session is at {2})",
				`${errorMessage(rollbackError)}`,
				`${actual}`,
				`${actual}`,
			),
			runtime,
		);
	}
	return usage(
		__ompTranslate(
			"Move failed and rollback failed: {0} (workspace remains at {1})",
			`${errorMessage(rollbackError)}`,
			`${actual}`,
		),
		runtime,
	);
}

/**
 * Relocate the headless session to `resolvedPath` (an existing directory):
 * flush settings, move the session file, re-scope the process, rolling back
 * on failure. Returns a result when the move did not complete; `undefined`
 * on success so the caller can report its own confirmation.
 */
async function relocateHeadlessSession(
	runtime: SlashCommandRuntime,
	resolvedPath: string,
): Promise<SlashCommandResult | undefined> {
	try {
		await runtime.settings.flush();
	} catch (err) {
		return usage(
			__ompTranslate("Failed to save pending settings: {0}\u0004session.picker.status", `${errorMessage(err)}`),
			runtime,
		);
	}
	const previousState = runtime.sessionManager.captureState();
	try {
		await runtime.session.moveSession(resolvedPath);
	} catch (err) {
		return usage(`Move failed: ${errorMessage(err)}`, runtime);
	}
	try {
		setProjectDir(resolvedPath);
	} catch (err) {
		try {
			await runtime.sessionManager.rollbackMove(previousState);
		} catch (rollbackError) {
			return reportFailedRollback(runtime, rollbackError);
		}
		return usage(`Move failed: ${errorMessage(err)}`, runtime);
	}
	try {
		await rescopeHeadlessToCwd(runtime, resolvedPath);
	} catch (err) {
		try {
			await runtime.sessionManager.rollbackMove(previousState);
			await rescopeHeadlessToCwd(runtime, previousState.cwd);
		} catch (rollbackError) {
			return reportFailedRollback(runtime, rollbackError);
		}
		return usage(`Move failed: ${errorMessage(err)}`, runtime);
	}
	await runtime.notifyConfigChanged?.();
	await runtime.notifyTitleChanged?.();
	return undefined;
}

export const BUILTIN_LIFECYCLE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "ssh",
		icon: "host",
		description: __ompTranslate("Manage SSH hosts (add, list, remove)"),
		acpDescription: __ompTranslate("Manage SSH connections"),
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: __ompTranslate("Add an SSH host"),
				usage: "<name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]",
			},
			{ name: "list", description: __ompTranslate("List all configured SSH hosts") },
			{ name: "remove", description: __ompTranslate("Remove an SSH host"), usage: "<name> [--scope project|user]" },
			{ name: "help", description: __ompTranslate("Show help message") },
		],
		allowArgs: true,
		handle: handleSshAcp,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleSSHCommand(command.text);
		},
	},
	{
		name: "new",
		icon: "plus",
		description: __ompTranslate("Start a new session"),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleNewCommand();
		},
	},
	{
		name: "fresh",
		icon: "restart",
		description: __ompTranslate("Reset provider stream state without changing the local transcript"),
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming
				? __ompTranslate("Fresh: unavailable while streaming")
				: __ompTranslate("Fresh: ready"),
		handle: async (_command, runtime) => {
			const result = runtime.session.freshSession();
			if (!result) {
				await runtime.output(
					__ompTranslate("Wait for the current response to finish or abort it before refreshing provider state."),
				);
				return commandConsumed();
			}
			await runtime.output(formatFreshSessionResult(result));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleFreshCommand();
		},
	},
	{
		name: "clear",
		icon: "eraser",
		description: __ompTranslate("Clear the conversation context in place, keeping the session"),
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isStreaming
				? __ompTranslate("Clear: unavailable while streaming")
				: __ompTranslate("Clear: drop context, keep session"),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleResetContextCommand();
		},
	},
	{
		name: "delete",
		icon: "trash",
		description: __ompTranslate("Delete the current session and start a new one"),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleDeleteCommand();
		},
	},
	{
		name: "compact",
		icon: "compress",
		description: __ompTranslate("Manually compact the session context"),
		acpDescription: __ompTranslate("Compact the conversation"),
		subcommands: COMPACT_MODES.map(mode => ({
			name: mode.name,
			description: mode.description,
			usage: mode.rejectsFocus ? undefined : "[focus]",
		})),
		acpInputHint: `[${COMPACT_MODES.map(mode => mode.name).join("|")}] [focus]`,
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			return usage
				? __ompTranslate("Compact: context {0}% used", `${Math.round(usage.percent)}`)
				: __ompTranslate("Compact: context unavailable");
		},
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			// Print mode turns a failed compaction into a nonzero exit; the
			// flag is closure state because the background-dispatch branch
			// (RPC) returns before `runCompact` settles.
			let compactFailed = false;
			const runCompact = async (): Promise<void> => {
				const before = runtime.session.getContextUsage?.();
				const beforeTokens = before?.tokens;
				try {
					await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
				} catch (err) {
					// RPC `abort` and ACP `session/cancel` propagate their explicit
					// USER_INTERRUPT_LABEL through the compaction abort signal. The client
					// already saw the interrupt it sent; emitting anything here would
					// append an out-of-turn chunk. Other cancellations (including an
					// extension veto) remain visible.
					if (err instanceof CompactionCancelledError && err.cause === USER_INTERRUPT_LABEL) return;
					// Compaction precondition failures (no model, already compacted, too
					// small) and provider errors propagate as plain Errors; surface them
					// via runtime.output so they don't fail the ACP prompt turn.
					compactFailed = true;
					await runtime.output(__ompTranslate("Compaction failed: {0}", `${errorMessage(err)}`));
					return;
				}
				const after = runtime.session.getContextUsage?.();
				const afterTokens = after?.tokens;
				if (beforeTokens != null && afterTokens != null) {
					const saved = beforeTokens - afterTokens;
					await runtime.output(
						__ompTranslate(
							"Compaction complete. Tokens: {0} -> {1} (saved {2}).",
							`${beforeTokens}`,
							`${afterTokens}`,
							`${saved}`,
						),
					);
				} else {
					await runtime.output(__ompTranslate("Compaction complete."));
				}
			};
			// Provider-backed: background-dispatch under RPC so the serialized command
			// queue stays free for `abort` (SlashCommandRuntime.runCommandInBackground).
			// ACP/TUI have no such hook and keep the inline await.
			if (runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runCompact);
				return commandConsumed();
			}
			await runCompact();
			return commandConsumed({ failed: compactFailed });
		},
		handleTui: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			clearSubmittedText(runtime);
			if ("error" in parsed) {
				runtime.ctx.showWarning(parsed.error);
				return;
			}
			const { ctx } = runtime;
			const origin = runtime.followUp;
			// A switch still applying (or rolling back) decides which conversation is live; judge after it.
			if (origin && ctx.session.isSessionTransitioning) await ctx.session.waitForSessionTransition();
			if (origin && !continuesConversation(ctx.sessionManager, origin)) {
				// Input hooks ran while the conversation changed: never compact one it was not sent in.
				restoreDetachedDraft(ctx.editor, command.text, runtime.input?.images, runtime.input?.imageLinks);
				ctx.showWarning("Conversation changed before /compact ran; returned it to the editor");
				return;
			}
			if (origin && ctx.session.isStreaming) {
				ctx.yieldCompaction = {
					...origin,
					text: command.text,
					instructions: parsed.instructions,
					mode: parsed.mode,
				};
				ctx.updatePendingMessagesDisplay();
				ctx.showStatus("Queued compaction for when the agent yields");
				// A prompt still in setup may bail without an agent run, and so without the settle that runs this.
				ctx.runYieldCompaction();
				return;
			}
			await ctx.handleCompactCommand(parsed.instructions, parsed.mode);
		},
	},
	{
		name: "shake",
		icon: "vibrate",
		description: __ompTranslate("Drop heavy content from context (tool results, large blocks)"),
		acpDescription: __ompTranslate("Shake heavy content out of the conversation context"),
		subcommands: [
			{ name: "elide", description: __ompTranslate("Strip tool results + large blocks (default)") },
			{ name: "images", description: __ompTranslate("Strip image blocks") },
			{ name: "thinking", description: __ompTranslate("Drop all thinking blocks") },
		],
		acpInputHint: "[elide|images|thinking]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") {
				runtime.ctx.showWarning(mode.error);
				return;
			}
			await runtime.ctx.handleShakeCommand(mode);
		},
	},
	{
		name: "handoff",
		icon: "handoff",
		description: __ompTranslate("Summarize the session into a handoff document and compact in place"),
		acpDescription: __ompTranslate("Summarize the session into a handoff document and compact in place"),
		inlineHint: __ompTranslate("[focus instructions]"),
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage(
					__ompTranslate("Wait for the current response to finish or abort it before handing off."),
					runtime,
				);
			}
			if (runtime.session.isGeneratingHandoff) {
				return usage(__ompTranslate("Handoff generation is already in progress."), runtime);
			}
			// Print mode turns a failed handoff into a nonzero exit; closure
			// state because the background-dispatch branch (RPC) returns
			// before `runHandoff` settles.
			let handoffFailed = false;
			const runHandoff = async (): Promise<void> => {
				let result: HandoffResult | undefined;
				try {
					result = await runtime.session.handoff(command.args || undefined);
				} catch (err) {
					const message = errorMessage(err);
					// A user interrupt (ACP `session/cancel`, TUI Esc) already settled the
					// owning turn: `AgentSession.abort()` forwards its reason into the
					// handoff abort controller, and `throwIfHandoffAborted` rethrows a
					// reasoned abort verbatim — so the throw arrives as
					// `USER_INTERRUPT_LABEL`, not "Handoff cancelled". Emitting anything
					// here would append an out-of-turn chunk after the client already saw
					// `stopReason: "cancelled"`, so consume silently.
					if (message === USER_INTERRUPT_LABEL) {
						return;
					}
					// `session.handoff()` normalizes an unreasoned cancellation to this
					// exact message; every other throw is a real failure (no model
					// selected, nothing to hand off, already compacted, provider error)
					// and is surfaced verbatim behind the same "<verb> failed:" prefix
					// `/compact` uses.
					if (message === "Handoff cancelled") {
						await runtime.output("Handoff cancelled.");
						return;
					}
					// Persist the real failure so it stays debuggable after the client
					// message scrolls away (same rationale as the TUI path, #7993).
					logger.error("Handoff failed", { error: message });
					handoffFailed = true;
					await runtime.output(__ompTranslate("Handoff failed: {0}", `${message}`));
					return;
				}
				if (!result) {
					await runtime.output("Handoff cancelled.");
					return;
				}
				// `savedPath` is deliberately not reported: `SessionHandoff` only writes
				// the document to disk when `options.autoTriggered` is set, which the
				// user-invoked path never passes.
				await runtime.output(__ompTranslate("Context handed off and compacted in place."));
			};
			if (runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runHandoff);
				return commandConsumed();
			}
			await runHandoff();
			return commandConsumed({ failed: handoffFailed });
		},
		handleTui: async (command, runtime) => {
			if (refuseImages(command, runtime)) return;
			const customInstructions = command.args || undefined;
			clearSubmittedText(runtime);
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	SEANCE_SLASH_COMMAND,
	{
		name: "resume",
		icon: "history",
		description: __ompTranslate("Resume a different session"),
		inlineHint: __ompTranslate("[session id|@claude|@codex]"),
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const sessionArg = command.args.trim();
			clearSubmittedText(runtime);
			const foreignSource = sessionArg === "@claude" ? "claude" : sessionArg === "@codex" ? "codex" : undefined;
			if (foreignSource) {
				runtime.ctx.showSessionSelector(foreignSource);
				return;
			}
			if (!sessionArg) {
				runtime.ctx.showSessionSelector();
				return;
			}
			const target = await resolveResumeTarget(
				sessionArg,
				runtime.ctx.sessionManager.getCwd(),
				runtime.ctx.sessionManager.getSessionDir(),
				{ allowGlobalFallback: true },
			);
			if (!target) {
				runtime.ctx.showError(__ompTranslate('Session "{0}" not found', `${sessionArg}`));
				return;
			}
			try {
				await runtime.ctx.handleResumeSession(target.session.path, { continuation: target.continuation });
			} catch (error) {
				// The picker reports a failed switch itself; `/resume <id>` has no picker.
				runtime.ctx.showError(error instanceof Error ? error.message : String(error));
			}
		},
	},
	{
		name: "pin",
		icon: "pin",
		description: __ompTranslate("Pin or unpin a session at the top of the resume list"),
		inlineHint: __ompTranslate("[session id]"),
		allowArgs: true,
		handle: async (command, runtime) => {
			const sessionArg = command.args.trim();
			let sessionId: string | undefined;
			if (sessionArg) {
				const match = await resolveResumableSession(
					sessionArg,
					runtime.cwd,
					runtime.sessionManager.getSessionDir(),
					{ allowGlobalFallback: true },
				);
				if (!match) {
					return usage(
						__ompTranslate('Session "{0}" not found.\u0004session.lookup.not-found', `${sessionArg}`),
						runtime,
					);
				}
				sessionId = match.session.id;
			} else {
				sessionId = runtime.sessionManager.getSessionId();
				if (!sessionId) {
					return usage(__ompTranslate("No active session to pin."), runtime);
				}
			}
			const pinned = await toggleSessionPin(sessionId);
			await runtime.output(
				pinned
					? __ompTranslate("Session pinned to the top of the resume list.")
					: __ompTranslate("Session unpinned."),
			);
			return commandConsumed();
		},
	},
	{
		name: "btw",
		icon: "question",
		description: __ompTranslate("Ask a side question, or browse this session's BTW history"),
		inlineHint: "[question]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const question = command.text.slice(`/${command.name}`.length).trim();
			await runWithDetachedDraft(
				command,
				runtime,
				() => runtime.ctx.handleBtwCommand(question, runtime.input?.images),
				{ restoreText: true },
			);
		},
	},
	{
		name: "tan",
		icon: "rocket",
		description: __ompTranslate("Run a full background agent on tangential work"),
		inlineHint: "<work>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const work = command.text.slice(`/${command.name}`.length).trim();
			await runWithDetachedDraft(command, runtime, () => runtime.ctx.handleTanCommand(work, runtime.input?.images), {
				restoreText: true,
			});
		},
	},
	{
		name: "omfg",
		icon: "rule",
		description: __ompTranslate("Forge a TTSR rule from a complaint to stop a recurring behavior"),
		inlineHint: "<complaint>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			if (refuseImages(command, runtime)) return;
			const complaint = command.text.slice(`/${command.name}`.length).trim();
			clearSubmittedText(runtime);
			await runtime.ctx.handleOmfgCommand(complaint);
		},
	},
	{
		name: "cleanse",
		icon: "stethoscope",
		description: __ompTranslate(
			"Detect and fix project diagnostics with weighted parallel subagents\u0004project.diagnostics.command.description",
		),
		inlineHint: "[request] [--all]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			if (refuseImages(command, runtime)) return;
			const args = command.text.slice(`/${command.name}`.length).trim();
			clearSubmittedText(runtime);
			await runtime.ctx.handleCleanseCommand(args);
		},
	},
	{
		name: "retry",
		icon: "redo",
		description: __ompTranslate("Retry the last failed agent turn"),
		handle: async (_command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage(
					__ompTranslate("Wait for the current response to finish or abort it before retrying."),
					runtime,
				);
			}
			const didRetry = await runtime.session.retry();
			if (!didRetry) {
				return usage(__ompTranslate("Nothing to retry."), runtime);
			}
			await runtime.output(__ompTranslate("Retrying the last failed turn."));
			// `AgentSession.retry()` only schedules the continuation as a
			// post-prompt task; it returns before the retried turn streams. Hosts
			// whose prompt turn owns the event subscription (ACP) must stay open
			// across that turn — `AcpAgent.prompt` installs the subscription
			// before running the command and `#finishPrompt` unsubscribes, so
			// returning early would silently swallow the entire retried turn
			// (model output and tool calls). RPC and TUI omit this hook: they
			// stream the continuation through their own session subscription, and
			// blocking their command queue here would strand a follow-up `abort`.
			await runtime.keepTurnOpenUntilIdle?.();
			// `retry()` returned true, so a real agent turn is now scheduled — RPC
			// hosts must not be told this was local-only work.
			return commandConsumed({ agentInvoked: true });
		},
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus(__ompTranslate("Nothing to retry\u0004session.retry.empty"));
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "debug",
		icon: "bug",
		description: __ompTranslate("Open debug tools selector"),
		handleTui: async (_command, runtime) => {
			await runtime.ctx.showDebugSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "memory",
		icon: "memory",
		description: __ompTranslate("Inspect and operate memory maintenance"),
		acpDescription: __ompTranslate("Manage memory"),
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "view", description: __ompTranslate("Show current memory injection payload") },
			{ name: "stats", description: __ompTranslate("Show memory backend statistics") },
			{ name: "diagnose", description: __ompTranslate("Run memory backend diagnostics") },
			{ name: "queue", description: __ompTranslate("Show pending memory deltas awaiting consolidation") },
			{ name: "sync", description: __ompTranslate("Run memory consolidation now") },
			{ name: "clear", description: __ompTranslate("Clear persisted memory data and artifacts") },
			{ name: "reset", description: __ompTranslate("Alias for clear") },
			{ name: "enqueue", description: __ompTranslate("Enqueue memory consolidation maintenance") },
			{ name: "rebuild", description: __ompTranslate("Alias for enqueue") },
			{ name: "mm list", description: __ompTranslate("List mental models on the active bank") },
			{ name: "mm show", description: __ompTranslate("Show one mental model (id required)") },
			{
				name: "mm refresh",
				description: __ompTranslate("Refresh auto-refresh models bank-wide, or one model by id"),
			},
			{ name: "mm history", description: __ompTranslate("Diff the change history of a mental model") },
			{ name: "mm seed", description: __ompTranslate("Create any built-in mental models that are missing") },
			{ name: "mm delete", description: __ompTranslate("Delete a mental model from the bank (id required)") },
			{ name: "mm reload", description: __ompTranslate("Re-pull the cached <mental_models> block") },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await backend.buildDeveloperInstructions(
						runtime.settings.getAgentDir(),
						runtime.cwd,
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || __ompTranslate("Memory payload is empty."));
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt();
					await runtime.output(__ompTranslate("Memory cleared."));
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(__ompTranslate("Memory consolidation enqueued.\u0004session.lifecycle.status"));
					return commandConsumed();
				}
				case "queue": {
					const payload = await backend.queuePreview?.({
						agentDir: runtime.settings.getAgentDir(),
						cwd: runtime.cwd,
						session: runtime.session,
					});
					await runtime.output(
						payload ?? __ompTranslate("Memory queue is not available for the {0} backend.", `${backend.id}`),
					);
					return commandConsumed();
				}
				case "sync": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(__ompTranslate("Memory consolidation ran."));
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? memoryStatsUnavailableMessage(backend.id, verb));
					return commandConsumed();
				}
				case "mm":
					return usage(
						__ompTranslate(
							"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
						),
						runtime,
					);
				default:
					return usage("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild|queue|sync>", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
	{
		name: "rename",
		icon: "pencil",
		description: __ompTranslate("Rename the current session (omit title to generate)"),
		inlineHint: "[title]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const session = runtime.session;
			const sessionManager = runtime.sessionManager;
			const runRename = async (): Promise<void> => {
				const sessionId = sessionManager.getSessionId();
				const titleSignal = session.titleGenerationSignal;
				let titleRevision = sessionManager.titleRevision;
				const isCurrent = () =>
					runtime.session === session &&
					runtime.sessionManager === sessionManager &&
					!runtime.signal?.aborted &&
					// An interrupt cancels a generated title; a typed one applies regardless.
					!(titleSignal.aborted && !command.args) &&
					sessionManager.getSessionId() === sessionId &&
					sessionManager.titleRevision === titleRevision;
				try {
					const generation = session.renameTitle(command.args, runtime.signal);
					titleRevision = sessionManager.titleRevision;
					const title = await generation;
					if (!isCurrent() || title === undefined) return;
					if (!title) {
						await runtime.output(
							__ompTranslate("Could not generate a session title. Use /rename <title> to set one."),
						);
						return;
					}
					const persistence = sessionManager.setSessionName(title, "user");
					titleRevision = sessionManager.titleRevision;
					const ok = await persistence;
					if (!isCurrent()) return;
					if (!ok) {
						await runtime.output(__ompTranslate("Session name not changed (a user-set name takes precedence)."));
						return;
					}
					await runtime.notifyTitleChanged?.();
					if (!isCurrent()) return;
					await runtime.output(__ompTranslate("Session renamed to {0}.", `${title}`));
				} catch (err) {
					if (!isCurrent()) return;
					if (command.args || !runtime.runCommandInBackground) throw err;
					await runtime.output(__ompTranslate("Rename failed: {0}", `${errorMessage(err)}`));
				}
			};
			if (!command.args && runtime.runCommandInBackground) {
				runtime.runCommandInBackground(runRename);
				return commandConsumed();
			}
			await runRename();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const session = runtime.ctx.session;
			const sessionManager = runtime.ctx.sessionManager;
			const sessionId = sessionManager.getSessionId();
			// `renameTitle` resolves undefined for a generated title an interrupt cancelled.
			const generation = session.renameTitle(command.args.trim());
			const titleRevision = sessionManager.titleRevision;
			const title = await generation;
			if (
				runtime.ctx.session !== session ||
				runtime.ctx.sessionManager !== sessionManager ||
				sessionManager.getSessionId() !== sessionId ||
				sessionManager.titleRevision !== titleRevision ||
				title === undefined
			)
				return;
			if (!title) {
				runtime.ctx.showStatus(
					__ompTranslate("Could not generate a session title. Use /rename <title> to set one."),
				);
				return;
			}
			await runtime.ctx.handleRenameCommand(title);
		},
	},
	{
		name: "move",
		icon: "folderMove",
		description: __ompTranslate("Move the current session to a different directory"),
		acpDescription: __ompTranslate("Move the current session to a different directory"),
		inlineHint: "[<path>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) return usage(__ompTranslate("Cannot move while streaming."), runtime);
			if (!command.args) return usage(__ompTranslate("Usage: /move <path>"), runtime);
			const resolvedPath = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					return usage(__ompTranslate("Not a directory: {0}", `${resolvedPath}`), runtime);
				}
			} catch {
				return usage(__ompTranslate("Directory does not exist: {0}", `${resolvedPath}`), runtime);
			}
			const failure = await relocateHeadlessSession(runtime, resolvedPath);
			if (failure) return failure;
			await runtime.output(__ompTranslate("Moved to {0}.", `${runtime.sessionManager.getCwd()}`));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			clearSubmittedText(runtime);
			await runtime.ctx.handleMoveCommand(command.args || undefined);
		},
	},
	{
		name: "wt",
		aliases: ["worktree"],
		icon: "folderMove",
		description: __ompTranslate("Move this session into a new worktree, changes included"),
		acpDescription: __ompTranslate("Move this session into a new worktree, changes included"),
		inlineHint: "[<branch>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming)
				return usage(__ompTranslate("Cannot create a worktree while streaming."), runtime);
			const branch = command.args.trim() || defaultSessionWorktreeBranch();
			const sourceCwd = runtime.sessionManager.getCwd();
			let worktree: SessionWorktree;
			try {
				worktree = await createSessionWorktree(sourceCwd, runtime.settings, branch);
			} catch (err) {
				return usage(__ompTranslate("Worktree creation failed: {0}", `${errorMessage(err)}`), runtime);
			}
			const failure = await relocateHeadlessSession(runtime, worktree.path);
			if (failure) return failure;
			const cleanup = await cleanSourceCheckoutIfConfigured(sourceCwd, runtime.settings);
			if (cleanup.errorMessage !== undefined) {
				await runtime.output(
					__ompTranslate(
						"Warning: Worktree created, but cleaning source checkout failed: {0}",
						`${cleanup.errorMessage}`,
					),
				);
			}
			await runtime.output(formatSessionWorktreeSummary(worktree, cleanup.cleaned));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.addToHistory(command.text);
			clearSubmittedText(runtime);
			await runtime.ctx.handleWorktreeCommand(command.args || undefined);
		},
	},
	{
		name: "add-dir",
		icon: "folderPlus",
		description: __ompTranslate("Add a workspace directory to this session (multi-root)"),
		acpDescription: __ompTranslate("Add a workspace directory to this session"),
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming)
				return usage(__ompTranslate("Cannot add a directory while streaming."), runtime);
			if (!command.args)
				return usage(formatWorkspaceDirectories(runtime, __ompTranslate("Usage: /add-dir <path>")), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			try {
				const stat = await fs.stat(resolved);
				if (!stat.isDirectory()) return usage(__ompTranslate("Not a directory: {0}", `${resolved}`), runtime);
			} catch {
				return usage(__ompTranslate("Directory does not exist: {0}", `${resolved}`), runtime);
			}
			let added: string | null;
			try {
				added = await runtime.sessionManager.addWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (added === null) {
				await runtime.output(__ompTranslate("Already in the workspace: {0}", `${resolved}`));
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `Added ${added}.`));
			return commandConsumed();
		},
	},
	{
		name: "remove-dir",
		icon: "folderMinus",
		description: __ompTranslate("Remove a workspace directory from this session"),
		acpDescription: __ompTranslate("Remove a workspace directory from this session"),
		inlineHint: "<path>",
		allowArgs: true,
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming)
				return usage(__ompTranslate("Cannot remove a directory while streaming."), runtime);
			if (!command.args) return usage(__ompTranslate("Usage: /remove-dir <path>"), runtime);
			const resolved = resolveToCwd(command.args, runtime.cwd);
			if (resolved === path.resolve(runtime.cwd)) {
				return usage(__ompTranslate("Cannot remove the working directory; use /move to change it."), runtime);
			}
			let removed: string | null;
			try {
				removed = await runtime.sessionManager.removeWorkspaceDirectory(resolved);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			if (removed === null) {
				await runtime.output(__ompTranslate("Not a workspace directory: {0}", `${resolved}`));
				return commandConsumed();
			}
			await runtime.session.refreshBaseSystemPrompt();
			await runtime.output(formatWorkspaceDirectories(runtime, `Removed ${removed}.`));
			return commandConsumed();
		},
	},
	{
		name: "dirs",
		description: __ompTranslate("List this session's workspace directories"),
		acpDescription: __ompTranslate("List this session's workspace directories"),
		handle: async (_command, runtime) => {
			await runtime.output(formatWorkspaceDirectories(runtime));
			return commandConsumed();
		},
	},
	{
		name: "exit",
		description: __ompTranslate("Exit the application"),
		handleTui: shutdownHandlerTui,
	},
	{
		name: "restart",
		icon: "restart",
		description: __ompTranslate("Restart omp with the same launch flags, resuming this session"),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.restart();
		},
	},
];
async function rescopeHeadlessToCwd(runtime: SlashCommandRuntime, cwd: string): Promise<void> {
	setProjectDir(cwd);
	await runtime.settings.reloadForCwd(cwd);
	await rebindMemoryBackendForCwd(runtime.session);
	clearClaudePluginRootsCache();
	const src = discoverTitleSystemPromptFile(cwd);
	const p = await resolvePromptInput(src, "title system prompt");
	runtime.session.setTitleSystemPrompt(p);
	await runtime.session.refreshSkillsAndCommands();
	await runtime.refreshCommands?.();
	await runtime.reloadPlugins();
}
