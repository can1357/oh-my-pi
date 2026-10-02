/**
 * Mirror scan and tail loops.
 *
 * Every live *interactive* session of another omp process that this host does
 * not run itself becomes a read-only topic: `/close` ends correspondence,
 * `/rename` renames the topic, anything else is refused so the mirrored
 * session keeps its single writer (the terminal). The transcript is followed by
 * byte offset in the session file and relayed in complete lines only.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { SessionPresence } from "../session/session-presence";
import {
	mirrorChunks,
	readSessionLines,
	sessionFileSize,
	sessionIdOf,
	transcriptMessagesFrom,
	type TranscriptMessage,
} from "./mirror-text";
import { createMirrorTopic, MIRROR_STATUS } from "./mirror-topic";
import type { MirrorDeps, MirrorService, TopicEntry } from "./types";

export const MIRROR_SCAN_MS = 60_000;
export const MIRROR_TAIL_MS = 3_000;

function defaultEvery(ms: number, tick: () => Promise<void>): () => void {
	const timer = setInterval(() => void tick(), ms);
	return () => clearInterval(timer);
}

export function createMirror(deps: MirrorDeps): MirrorService {
	const every = deps.every ?? defaultEvery;
	let stopped = false;
	const disposers: Array<() => void> = [];
	const missing = new Set<string>();
	const pids = new Map<number, number>();

	/**
	 * Every pass — the 60 s scan and the 3 s tail alike — runs on this chain, so
	 * two of them never overlap. Overlapping passes read the session file from
	 * the same offset and relay the same lines twice; a slow pass (a burst,
	 * several mirrors, a 429 `retry_after` sleep in the API) therefore also holds
	 * off the next tick instead of racing it. A timer tick whose kind is already
	 * waiting on the chain is dropped: the waiting pass covers it, so a long
	 * stall never piles up passes.
	 */
	let passes: Promise<void> = Promise.resolve();
	const waiting = new Set<"scan" | "tail">();

	function serialize(run: () => Promise<unknown>): Promise<void> {
		passes = passes.then(run).then(
			() => undefined,
			() => undefined,
		);
		return passes;
	}

	function tick(kind: "scan" | "tail", run: () => Promise<void>): Promise<void> {
		if (waiting.has(kind)) return passes;
		waiting.add(kind);
		return serialize(() => {
			waiting.delete(kind);
			return guard(run);
		});
	}

	const note = (event: string, extra: Record<string, unknown> = {}): void => {
		logger.debug(`telegram: ${event}`, extra);
	};

	const mirroring = (): TopicEntry[] => deps.registry.list().filter(entry => entry.status === MIRROR_STATUS);
	const heldByTerminal = (): TopicEntry[] => deps.registry.list().filter(entry => entry.mirror === true);

	async function guard<T>(run: () => Promise<T>): Promise<T | null> {
		try {
			return await run();
		} catch (error) {
			note("mirror.failed", { error: String(error instanceof Error ? error.message : error) });
			return null;
		}
	}

	async function say(threadId: number, message: TranscriptMessage): Promise<void> {
		for (const chunk of mirrorChunks(message)) await deps.topics.notify(threadId, chunk);
	}

	async function read(entry: TopicEntry): Promise<void> {
		// The caller's copy may predate a pass that already advanced the offset;
		// relaying from a stale offset would send those lines a second time.
		const current = deps.registry.get(entry.threadId) ?? entry;
		const file = current.sessionFile;
		const from = current.tailOffset;
		if (file === null || !Number.isInteger(from)) {
			note("mirror.no_offset", { threadId: current.threadId });
			return;
		}
		const offset = from ?? 0;
		const chunk = await readSessionLines(file, { from: offset });
		if (!chunk.ok) {
			note("mirror.read_failed", { threadId: current.threadId, error: chunk.reason });
			return;
		}
		if (chunk.text === "") return;
		for (const relay of transcriptMessagesFrom(chunk.text, offset)) {
			if (stopped) return;
			await say(current.threadId, relay.message);
			// Advance per relayed message: a pass that is cut short here resumes
			// at the next line instead of sending the whole chunk again.
			deps.registry.update(current.threadId, { tailOffset: relay.offset });
		}
		// Lines that carry nothing to relay (thinking, tool chatter) still move
		// the offset on, or the next pass would read them again.
		deps.registry.update(current.threadId, { tailOffset: chunk.offset });
	}

	function entryFor(session: SessionPresence): TopicEntry | null {
		const direct = deps.registry.bySessionFile(session.sessionFile);
		if (direct !== null) return direct;
		const id = session.sessionId;
		if (id === "") return null;
		return (
			deps.registry.list().find(entry => {
				const file = entry.sessionFile;
				if (file === null || file === "") return false;
				return sessionIdOf(file).endsWith(id) || entry.sessionId === id;
			}) ?? null
		);
	}

	async function ready(file: string): Promise<boolean> {
		const size = await sessionFileSize(file);
		if (size.ok) return true;
		if (missing.has(file)) return false;
		missing.add(file);
		note("mirror.file_missing", { file });
		return false;
	}

	/**
	 * `deps.isHeldHere` takes a registry entry; a candidate that has none yet
	 * (first scan of a session this host just attached) is probed with its
	 * presence facts, which is all the host's file-based check reads.
	 */
	const heldHere = (session: SessionPresence, entry: TopicEntry | null): boolean => {
		if (entry !== null) return deps.isHeldHere(entry);
		return deps.isHeldHere({
			threadId: 0,
			name: session.sessionName ?? "",
			cwd: session.cwd,
			sessionFile: session.sessionFile,
			sessionId: session.sessionId,
			status: "idle",
			createdAt: 0,
			updatedAt: 0,
		});
	};

	const topic = createMirrorTopic({
		registry: deps.registry,
		topics: deps.topics,
		clock: deps.clock ?? { now: Date.now },
		isHeldHere: deps.isHeldHere,
		note,
		say,
		read,
	});

	async function scanOnce(): Promise<void> {
		if (stopped) return;
		let live: SessionPresence[];
		try {
			live = await deps.livePresence();
		} catch (error) {
			note("mirror.live_failed", { error: String(error instanceof Error ? error.message : error) });
			return;
		}
		const alive = new Set<string>();
		for (const session of live) {
			if (session.kind !== "interactive" || session.sessionFile === "") continue;
			alive.add(session.sessionFile);
			const entry = entryFor(session);
			if (entry !== null) pids.set(entry.threadId, session.pid);
			if (heldHere(session, entry)) continue;
			if (stopped) return;
			if (!(await ready(session.sessionFile))) continue;
			if (entry !== null) {
				await topic.readopt(session);
				continue;
			}
			const opened = await topic.adopt(session);
			if (opened !== null) pids.set(opened, session.pid);
		}
		for (const entry of heldByTerminal()) {
			if (stopped) return;
			if (entry.sessionFile !== null && alive.has(entry.sessionFile)) continue;
			await topic.release(entry);
		}
	}

	async function tailOnce(): Promise<void> {
		if (stopped) return;
		for (const entry of mirroring()) {
			if (stopped) return;
			await read(entry);
		}
	}

	async function start(): Promise<void> {
		if (stopped) return;
		if (disposers.length === 0) {
			disposers.push(
				every(MIRROR_SCAN_MS, () => tick("scan", scanOnce)),
				every(MIRROR_TAIL_MS, () => tick("tail", tailOnce)),
			);
		}
		await serialize(() => guard(scanOnce));
	}

	function stop(): void {
		stopped = true;
		for (const dispose of disposers) dispose();
		disposers.length = 0;
	}

	async function scan(): Promise<void> {
		await serialize(() => guard(scanOnce));
	}

	async function tail(): Promise<void> {
		await serialize(() => guard(tailOnce));
	}

	async function handle(entry: TopicEntry, text: string): Promise<string> {
		const result = await guard(() => topic.handle(entry, text, pids.get(entry.threadId) ?? null));
		return result ?? "mirror_readonly";
	}

	return { start, stop, scan, tail, handle };
}
