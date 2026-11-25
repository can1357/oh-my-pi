import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { formatDuration, logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { AsyncJobManagerApi } from "../async";
import { heldShellProcesses } from "../exec/bash-executor";
import { cfgBashReapBackground } from "../exec/settings";
import { killLeftoverProcesses, type LeftoverProcess, listLeftoverProcesses } from "../exec/session-processes";
import { listServices } from "../launch/services";
import leftoverProcessesPrompt from "../prompts/system/leftover-processes.md" with { type: "text" };
import type { ToolSession } from "../tools";
import type { SessionManager } from "./session-manager";

/** How long a service listing may hold up a yield or a dispose. */
const SERVICE_LIST_TIMEOUT_MS = 5_000;

/** Capabilities the leftover-process tracker borrows from its owning session. */
export interface LeftoverProcessHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	agentKind(): "main" | "sub";
	asyncJobManager(): AsyncJobManagerApi | undefined;
	/** Tool session the bash tool runs under; undefined when the session has none (no services). */
	toolSession(): ToolSession | undefined;
}

/**
 * Processes the session's bash calls left running (`cmd &`, `(cmd &)`, `nohup cmd &`):
 * a reminder when the main agent yields, and the `&` ones killed at session end.
 * Both gated on `bash.reapBackground` (forced off in RPC mode).
 */
export class LeftoverProcessTracker {
	readonly #host: LeftoverProcessHost;
	/** `pid:startedAt` of leftovers a reminder already listed. */
	readonly #reported = new Set<string>();

	constructor(host: LeftoverProcessHost) {
		this.#host = host;
	}

	/**
	 * Appends a reminder listing leftovers not reported before. Main agent only.
	 * Returns whether one was appended (the caller schedules the continuation).
	 */
	async remind(): Promise<boolean> {
		if (this.#host.agentKind() !== "main" || !cfgBashReapBackground.get(this.#host.settings)) return false;
		const leftovers = await this.#list();
		if (!leftovers) return false;
		const fresh = leftovers.filter(proc => !this.#reported.has(`${proc.pid}:${proc.startedAt}`));
		if (fresh.length === 0) return false;
		for (const proc of fresh) this.#reported.add(`${proc.pid}:${proc.startedAt}`);
		const now = Date.now();
		const text = prompt.render(leftoverProcessesPrompt, {
			count: fresh.length,
			plural: fresh.length !== 1,
			processes: fresh.map(proc => ({
				pid: proc.pid,
				kind: proc.kind,
				age: formatDuration(Math.max(0, now - proc.startedAt)),
				command: proc.command,
			})),
			hasAmpersand: fresh.some(proc => proc.kind === "&"),
			hasNohup: fresh.some(proc => proc.kind === "nohup"),
		});
		logger.debug("Leftover processes: sending reminder", { pids: fresh.map(proc => proc.pid) });
		const message: Message = {
			role: "developer",
			content: [{ type: "text", text }],
			attribution: "agent",
			timestamp: now,
		};
		this.#host.agent.appendMessage(message);
		this.#host.sessionManager.appendMessage(message);
		return true;
	}

	/**
	 * Session end: SIGKILLs the `&` leftovers' families; `nohup`'d ones survive. Runs before
	 * `releaseShellSessions` hands the session's shells off, while their held pids still count.
	 */
	async reap(): Promise<void> {
		if (!cfgBashReapBackground.get(this.#host.settings)) return;
		const leftovers = await this.#list();
		if (!leftovers || leftovers.length === 0) return;
		const killed = killLeftoverProcesses(leftovers);
		if (killed > 0) logger.debug("Leftover processes: reaped at session end", { killed });
	}

	/** Leftover roots; undefined when the service registry cannot be read (nothing is safe to act on). */
	async #list(): Promise<LeftoverProcess[] | undefined> {
		const sessionId = this.#host.sessionManager.getSessionId();
		const excluded: number[] = [];
		for (const job of this.#host.asyncJobManager()?.getAllJobs() ?? []) {
			if (job.status === "running" && job.process) excluded.push(...job.process.pids());
		}
		const held = heldShellProcesses(sessionId);
		const leftovers = listLeftoverProcesses(sessionId, held, excluded);
		if (leftovers.length === 0) return leftovers;
		// Services started by the bash tool carry the tag too: only consult the daemon when
		// there is something to exclude them from.
		const toolSession = this.#host.toolSession();
		if (!toolSession) return leftovers;
		try {
			const units = await listServices(toolSession, AbortSignal.timeout(SERVICE_LIST_TIMEOUT_MS));
			for (const unit of units) excluded.push(...unit.pids);
		} catch (error) {
			logger.warn("Leftover processes: service list failed; leaving processes alone", { error: String(error) });
			return undefined;
		}
		return listLeftoverProcesses(sessionId, held, excluded);
	}
}
