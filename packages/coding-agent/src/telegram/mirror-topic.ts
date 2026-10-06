/**
 * Topic-level actions of the mirror: adopting a live terminal session into a
 * new read-only topic, re-adopting a known one, releasing it when the session
 * ends, and handling text written into a mirror topic.
 */
import { parseCommand, TOPIC_NAME_LIMIT } from "./commands";
import {
	MIRROR_CLOSED,
	MIRROR_ENDED,
	MIRROR_READOPTED,
	type MirrorSessionInfo,
	mirrorHeader,
	mirrorName,
	readSessionLines,
	refusalText,
	sessionFileSize,
	sessionCwdOf,
	sessionTitleOf,
	type TranscriptMessage,
	transcriptMessages,
} from "./mirror-text";
import { mdText } from "./rich";
import type { Clock, TelegramTopics, TopicEntry, TopicRegistry, TopicStatus } from "./types";

/** Status of a topic whose session runs in another omp process. */
export const MIRROR_STATUS = "mirror" satisfies TopicStatus;
const CLOSED_STATUS = "closed" satisfies TopicStatus;
const WINDOW_BYTES = 128 * 1024;

export interface MirrorTopicDeps {
	registry: TopicRegistry;
	topics: TelegramTopics;
	clock: Clock;
	/** True when this host runs the entry's session in-process (owned or attached). */
	isHeldHere(entry: TopicEntry): boolean;
	note(event: string, extra?: Record<string, unknown>): void;
	say(threadId: number, message: TranscriptMessage): Promise<void>;
	read(entry: TopicEntry): Promise<void>;
}

export interface MirrorTopic {
	/** Creates the mirror topic; resolves its thread id, or null when nothing was created. */
	adopt(session: MirrorSessionInfo): Promise<number | null>;
	readopt(session: MirrorSessionInfo): Promise<boolean>;
	release(entry: TopicEntry): Promise<void>;
	handle(entry: TopicEntry, text: string, pid: number | null): Promise<"close" | "rename" | "mirror_readonly">;
}

export function createMirrorTopic(deps: MirrorTopicDeps): MirrorTopic {
	async function readopt(session: MirrorSessionInfo): Promise<boolean> {
		const entry = deps.registry.bySessionFile(session.sessionFile);
		if (entry === null) return false;
		if (entry.status === MIRROR_STATUS || entry.status === CLOSED_STATUS) return false;
		if (deps.isHeldHere(entry)) return false;
		const size = await sessionFileSize(session.sessionFile);
		if (!size.ok) {
			deps.note("mirror.file_failed", { file: session.sessionFile, error: size.reason });
			return false;
		}
		deps.registry.update(entry.threadId, { mirror: true, status: MIRROR_STATUS, tailOffset: size.size });
		deps.note("mirror.readopted", { threadId: entry.threadId, file: session.sessionFile });
		await deps.topics.notify(entry.threadId, MIRROR_READOPTED);
		return true;
	}

	async function adopt(session: MirrorSessionInfo): Promise<number | null> {
		const file = session.sessionFile;
		const size = await sessionFileSize(file);
		if (!size.ok) {
			deps.note("mirror.file_failed", { file, error: size.reason });
			return null;
		}
		const window = await readSessionLines(file, { from: Math.max(0, size.size - WINDOW_BYTES), size: size.size });
		if (!window.ok) {
			deps.note("mirror.file_failed", { file, error: window.reason });
			return null;
		}
		const name = deps.registry.freeName(mirrorName(session, await sessionTitleOf(file)));
		let threadId: number | null = null;
		try {
			threadId = await deps.topics.create(name);
		} catch (error) {
			deps.note("mirror.topic_failed", { name, error: String(error instanceof Error ? error.message : error) });
			return null;
		}
		if (threadId === null) {
			deps.note("mirror.no_topic", { name });
			return null;
		}
		const now = deps.clock.now();
		const entry = deps.registry.put({
			threadId,
			name,
			cwd: session.cwd,
			sessionFile: file,
			sessionId: session.sessionId,
			status: MIRROR_STATUS,
			mirror: true,
			tailOffset: window.offset,
			createdAt: now,
			updatedAt: now,
		});
		deps.note("mirror.opened", { threadId: entry.threadId, file, name });
		await deps.topics.notify(entry.threadId, mirrorHeader(session, name));
		const answers = transcriptMessages(window.text).filter(message => message.who === "agent");
		const last = answers.length === 0 ? null : answers[answers.length - 1];
		if (last !== undefined && last !== null) await deps.say(entry.threadId, last);
		return entry.threadId;
	}

	async function release(entry: TopicEntry): Promise<void> {
		const wasMirroring = entry.status === MIRROR_STATUS;
		if (wasMirroring) await deps.read(entry);
		const cwd = entry.sessionFile === null ? null : await sessionCwdOf(entry.sessionFile);
		deps.registry.update(entry.threadId, {
			mirror: false,
			status: wasMirroring ? "idle" : entry.status,
			cwd: cwd ?? entry.cwd,
		});
		if (!wasMirroring) return;
		deps.note("mirror.ended", { threadId: entry.threadId });
		await deps.topics.notify(entry.threadId, MIRROR_ENDED);
	}

	async function renameTopic(entry: TopicEntry, name: string): Promise<"rename"> {
		if (name === "" || name.length > TOPIC_NAME_LIMIT) {
			await deps.topics.notify(
				entry.threadId,
				`⚠️ The name must be non-empty and at most ${TOPIC_NAME_LIMIT} characters: \`/rename <name>\``,
			);
			return "rename";
		}
		deps.registry.update(entry.threadId, { name });
		try {
			await deps.topics.rename(entry.threadId, name);
		} catch (error) {
			deps.note("mirror.rename_failed", {
				threadId: entry.threadId,
				error: String(error instanceof Error ? error.message : error),
			});
		}
		await deps.topics.notify(
			entry.threadId,
			`Topic is now “${mdText(name)}”. The session in the terminal keeps its own name.`,
		);
		return "rename";
	}

	async function handle(
		entry: TopicEntry,
		text: string,
		pid: number | null,
	): Promise<"close" | "rename" | "mirror_readonly"> {
		const current = deps.registry.get(entry.threadId) ?? entry;
		const command = parseCommand(text);
		if (command !== null && command.name === "close") {
			deps.registry.update(current.threadId, { status: CLOSED_STATUS });
			await deps.topics.close(current.threadId, current.name);
			await deps.topics.notify(current.threadId, MIRROR_CLOSED);
			deps.note("mirror.closed", { threadId: current.threadId });
			return "close";
		}
		if (command !== null && command.name === "rename") return renameTopic(current, command.rest);
		await deps.topics.notify(current.threadId, refusalText(command, pid));
		return "mirror_readonly";
	}

	return { adopt, readopt, release, handle };
}
