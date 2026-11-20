/**
 * Foreground handoff: ← on an empty composer moves this session into a hosted daemon
 * unit and turns this terminal into the Agent View with that session selected.
 *
 * Nothing is moved between processes: the session is persisted and disposed (its
 * lease released), then a hosted `omp --restore <file>` takes it over. A turn that
 * had to be aborted for the move goes on in the hosted process
 * ({@link AGENT_HANDOFF_CONTINUE_ENV}); `--restore` alone never resumes a turn that
 * ended aborted.
 */
import * as path from "node:path";
import { getActiveProfile } from "@oh-my-pi/pi-utils";
import { restartArgv } from "../cli/flag-tables";
import type { AsyncJob } from "../async";
import type { AgentSession } from "../session/agent-session";
import { AGENT_HANDOFF_CONTINUE_ENV, filterHostedEnv, launchHosted } from "./host";

/** How long ← waits for the running tool or turn to reach a boundary before aborting it. */
export const HANDOFF_BOUNDARY_TIMEOUT_MS = 10_000;

/** What the handoff needs from the interactive host. */
export interface HandoffHost {
	getSession(): AgentSession;
	/** Current composer draft. */
	composerText(): string;
	showStatus(message: string): void;
	showWarning(message: string): void;
	confirm(title: string, message: string): Promise<boolean>;
	/** Claim the session close; false when a close or restart already runs. */
	beginClose(): boolean;
	/** Give the close back after a refusal before {@link teardown}. */
	abandonClose(): void;
	/** Dispose the session (releasing its lease) and hand the terminal back; false when that failed (reported). */
	teardown(): Promise<boolean>;
	/** Launch the Agent View in this terminal; resolves its exit code. */
	runAgentsView(key: string): Promise<number>;
	/** Exit this process. */
	quit(code: number): Promise<void>;
	/** Report a failed launch after teardown, when only stderr is left. */
	reportFailure(message: string, sessionId: string | undefined): Promise<void>;
}

/** Why the session's state refuses a handoff, or undefined when it may proceed. */
export function handoffRefusal(session: AgentSession, composerText: string): string | undefined {
	// `--no-session`: nothing on disk for a hosted process to restore, and writing the
	// ephemeral history out would break the promise the flag made.
	if (!session.sessionManager.isPersistent()) return "A --no-session session cannot be backgrounded.";
	if (composerText.trim() !== "") return "Clear the composer to background this session.";
	if (session.queuedMessageCount > 0) return "Send or clear the queued messages to background this session.";
	return undefined;
}

/** The in-process background work a handoff would cut off, as confirm-dialog lines. */
export function describeInProcessWork(jobs: readonly AsyncJob[]): string[] {
	return jobs.map(job => `• ${(job.intent ?? job.label).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 120)}`);
}

/**
 * CLI arguments of the hosted process: the launch flags as `/restart` keeps them,
 * the session restored from `sessionFile`, and the active profile passed explicitly.
 */
export function hostedSessionArgv(launchArgv: string[], sessionFile: string, profile: string | undefined): string[] {
	const argv = restartArgv(launchArgv, path.resolve(sessionFile), profile ? { "--profile": true } : undefined);
	if (profile) argv.push("--profile", profile);
	return argv;
}

/**
 * Resolve when the session reaches a point that can be handed over: idle, a tool
 * finished, or a turn ended. Resolves false on timeout or when `now` fires first.
 */
function waitForBoundary(session: AgentSession, timeoutMs: number, now: Promise<void>): Promise<boolean> {
	if (!session.isStreaming) return Promise.resolve(true);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "tool_execution_end" || event.type === "turn_end" || event.type === "agent_end") {
			resolve(true);
		}
	});
	const unsubscribeRun = session.subscribeRunState(state => {
		if (state === "idle") resolve(true);
	});
	const timer = setTimeout(() => resolve(false), timeoutMs);
	void now.then(() => resolve(false));
	return promise.finally(() => {
		clearTimeout(timer);
		unsubscribe();
		unsubscribeRun();
	});
}

/** Drives one foreground handoff at a time; a second ← while it waits skips the wait. */
export class BackgroundHandoff {
	readonly #host: HandoffHost;
	#running = false;
	#skipWait: (() => void) | undefined;

	constructor(host: HandoffHost) {
		this.#host = host;
	}

	/** Whether a handoff is in progress (waiting for a boundary or tearing down). */
	get running(): boolean {
		return this.#running;
	}

	/** ← / `/background`: start a handoff, or hand over now when one is waiting. Resolves when this handoff attempt ends. */
	trigger(): Promise<void> {
		if (this.#running) {
			this.#skipWait?.();
			return Promise.resolve();
		}
		this.#running = true;
		return this.#run().finally(() => {
			this.#running = false;
			this.#skipWait = undefined;
		});
	}

	async #run(): Promise<void> {
		const host = this.#host;
		const session = host.getSession();
		const refusal = handoffRefusal(session, host.composerText());
		if (refusal) {
			host.showWarning(refusal);
			return;
		}
		const jobs = session.asyncJobManager?.getRunningJobs() ?? [];
		if (jobs.length > 0) {
			const lines = describeInProcessWork(jobs);
			const proceed = await host.confirm(
				"Background this session?",
				`These background jobs run in this process and stop when it hands the session over:\n${lines.join("\n")}`,
			);
			if (!proceed) return;
		}

		let aborted = false;
		if (session.isStreaming) {
			host.showStatus("Backgrounding after the current tool… (← again: now)");
			const skip = Promise.withResolvers<void>();
			this.#skipWait = skip.resolve;
			await waitForBoundary(session, HANDOFF_BOUNDARY_TIMEOUT_MS, skip.promise);
			this.#skipWait = undefined;
			// The composer may have changed while waiting.
			const lateRefusal = handoffRefusal(session, host.composerText());
			if (lateRefusal) {
				host.showWarning(lateRefusal);
				return;
			}
			if (session.isStreaming) {
				await session.abort();
				aborted = true;
			}
		}

		if (!host.beginClose()) return;
		const manager = session.sessionManager;
		let sessionFile: string | undefined;
		try {
			await manager.ensureOnDisk();
			sessionFile = manager.isSessionOnDisk() ? manager.getSessionFile() : undefined;
		} catch (error) {
			host.abandonClose();
			host.showWarning(`Could not save the session to background it: ${errorText(error)}`);
			return;
		}
		if (!sessionFile) {
			host.abandonClose();
			host.showWarning("Could not save the session to background it.");
			return;
		}
		const sessionId = manager.getSessionId();
		const cwd = manager.getCwd();
		const title = manager.getSessionName();
		if (!(await host.teardown())) return;

		let key: string;
		try {
			const env = filterHostedEnv(process.env);
			if (aborted) env[AGENT_HANDOFF_CONTINUE_ENV] = "1";
			key = await launchHosted({
				cwd,
				argv: hostedSessionArgv(process.argv.slice(2), sessionFile, getActiveProfile()),
				env,
				cols: process.stdout.columns || 120,
				rows: process.stdout.rows || 40,
				title,
			});
		} catch (error) {
			await host.reportFailure(`Could not background the session: ${errorText(error)}`, sessionId);
			return;
		}
		await host.quit(await host.runAgentsView(key));
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
