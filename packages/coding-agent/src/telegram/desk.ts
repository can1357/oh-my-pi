/**
 * Desk of live topic sessions in this process. Owns the lifecycle of the
 * sessions the bridge created itself; the attached TUI relay is registered
 * here too but is only ever stopped, never disposed.
 */
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { raiseAllowed, type LivenessDeps } from "./liveness";
import { mdText } from "./rich";
import { createOwnedTopicSession, type TopicSessionDeps, type TopicSessionRuntime } from "./topic-session";
import type { TopicEntry } from "./types";

export interface TopicSessionDeskDeps extends TopicSessionDeps {
	liveness: LivenessDeps;
	/** Relay runtime of the hosting process for a session file, when one exists. */
	attachedRuntimeFor(sessionFile: string): TopicSessionRuntime | null;
}

export type DeskOpenResult = { ok: true; runtime: TopicSessionRuntime } | { ok: false; reason: string };

export interface TopicSessionDesk {
	/** Live runtime for the entry, raising one (attached preferred) when needed. */
	ensure(entry: TopicEntry): Promise<DeskOpenResult>;
	get(threadId: number): TopicSessionRuntime | null;
	/** `/close`: disposes an owned runtime or ends an attached relay; true when one existed. */
	close(threadId: number): Promise<boolean>;
	/** Stops owned runtimes holding this session file (an attach supersedes them). */
	stopForFile(sessionFile: string): Promise<void>;
	/** Registers an externally built runtime (the attached relay). */
	register(threadId: number, runtime: TopicSessionRuntime): void;
	unregister(threadId: number): void;
	/** Snapshot of every runtime the desk holds (owned and attached). */
	sessions(): TopicSessionRuntime[];
	/** Host shutdown: stops every runtime, leaving the registry statuses open. */
	shutdown(): Promise<number>;
	count(): number;
}

export function createSessionDesk(deps: TopicSessionDeskDeps): TopicSessionDesk {
	const live = new Map<number, TopicSessionRuntime>();

	const ensure = async (entry: TopicEntry): Promise<DeskOpenResult> => {
		const current = live.get(entry.threadId);
		if (current !== undefined && current.alive()) return { ok: true, runtime: current };
		const file = entry.sessionFile;
		if (typeof file === "string" && file !== "") {
			const attached = deps.attachedRuntimeFor(file);
			if (attached !== null) {
				await attached.reopen();
				live.set(entry.threadId, attached);
				return { ok: true, runtime: attached };
			}
		}
		const allowed = await raiseAllowed(deps.liveness, entry);
		if (!allowed.ok) return allowed;
		const runtime = await createOwnedTopicSession(deps, entry);
		live.set(entry.threadId, runtime);
		deps.log("session raised", { threadId: entry.threadId, cwd: entry.cwd });
		return { ok: true, runtime };
	};

	const get = (threadId: number): TopicSessionRuntime | null => live.get(threadId) ?? null;

	const close = async (threadId: number): Promise<boolean> => {
		const runtime = live.get(threadId) ?? null;
		live.delete(threadId);
		if (runtime !== null) {
			await runtime.close();
			return true;
		}
		const entry = deps.registry.get(threadId);
		if (entry !== null) deps.registry.update(threadId, { status: "closed" });
		return false;
	};

	const stopForFile = async (sessionFile: string): Promise<void> => {
		for (const [threadId, runtime] of Array.from(live)) {
			if (runtime.attached || runtime.sessionFile() !== sessionFile) continue;
			live.delete(threadId);
			await runtime.stop();
		}
	};

	const shutdown = async (): Promise<number> => {
		const all = [...live.values()];
		live.clear();
		for (const runtime of all) await runtime.stop();
		deps.log("desk shut down", { sessions: all.length });
		return all.length;
	};

	return {
		ensure,
		get,
		close,
		stopForFile,
		register: (threadId, runtime) => {
			live.set(threadId, runtime);
		},
		unregister: threadId => {
			live.delete(threadId);
		},
		sessions: () => [...live.values()],
		shutdown,
		count: () => live.size,
	};
}

export interface TopicLauncher {
	/** Raises a session for the entry and persists its file/id back into the registry. */
	start(entry: TopicEntry, options?: { rename?: string | null }): Promise<DeskOpenResult>;
}

export function createTopicLauncher(deps: TopicSessionDeskDeps & { desk: TopicSessionDesk }): TopicLauncher {
	return {
		start: async (entry, options) => {
			let opened: DeskOpenResult;
			try {
				opened = await deps.desk.ensure(entry);
			} catch (error) {
				try {
					deps.registry.update(entry.threadId, { status: "closed" });
				} catch (registryError) {
					deps.log("could not mark a failed session closed", {
						threadId: entry.threadId,
						error: String(registryError),
					});
				}
				await deps.notify(entry.threadId, `⚠️ The session did not start: ${mdText(toError(error).message)}`);
				return { ok: false, reason: "spawn_failed" };
			}
			if (!opened.ok) return opened;
			const runtime = opened.runtime;
			// A brand-new session is named by its caller; a raised one carries the
			// topic's name (the registry record is authoritative for the topic).
			const rename = options?.rename ?? (entry.sessionFile === null ? null : entry.name);
			if (rename !== null) {
				try {
					await runtime.rename(rename);
				} catch (error) {
					await deps.notify(
						entry.threadId,
						`⚠️ Could not set the session name: ${mdText(toError(error).message)}`,
					);
				}
			}
			// A session raised into a topic that was closed reopens it: a closed
			// topic is a paused session, not a new one.
			if (entry.status === "closed") {
				await deps.topics.reopen(entry.threadId, entry.name);
			}
			try {
				deps.registry.update(entry.threadId, {
					sessionFile: runtime.sessionFile() ?? entry.sessionFile ?? null,
					sessionId: runtime.sessionId() ?? entry.sessionId ?? null,
				});
			} catch (error) {
				deps.log("could not persist the raised session", {
					threadId: entry.threadId,
					error: String(error),
				});
			}
			return { ok: true, runtime };
		},
	};
}
