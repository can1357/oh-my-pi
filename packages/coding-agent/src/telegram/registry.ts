/**
 * File-backed topic registry: one Telegram topic ↔ one omp session.
 *
 * Mutations apply to the in-memory view synchronously and queue one atomic
 * write (temp file + rename) that runs off the caller's path, so the hot
 * registrations of the bridge's async flows (`setStatus` per turn, a mirror's
 * `tailOffset` every few seconds) never block the event loop on disk I/O.
 * Writes are serialized and coalesced — the last queued write snapshots the
 * final state — and {@link TopicRegistry.flush} resolves once every mutation
 * made so far is on disk, rejecting with the first failed write.
 *
 * The one exception is the read at {@link openTopicRegistry}: it runs once, at
 * host construction, before any async flow and before the host may start, and
 * it is synchronous by design. A file that cannot be read or does not hold a
 * session array is refused with a named {@link TopicRegistryError} instead of
 * being silently replaced — losing the topic-to-session mapping would strand
 * every session behind a nameless topic.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { TOPIC_NAME_LIMIT } from "./commands";
import type { Clock, TopicEntry, TopicEntryDraft, TopicEntryPatch, TopicRegistry } from "./types";

export type TopicRegistryErrorReason = "broken_file" | "no_name" | "name_taken" | "unknown_thread" | "no_thread";

export class TopicRegistryError extends Error {
	readonly reason: TopicRegistryErrorReason;

	constructor(message: string, reason: TopicRegistryErrorReason) {
		super(message);
		this.name = "TopicRegistryError";
		this.reason = reason;
	}
}

const NAME_ATTEMPTS = 99;

const defaultClock: Clock = { now: () => Date.now() };

const nameKey = (value: unknown): string =>
	String(value ?? "")
		.trim()
		.toLowerCase();

const isEntryRecord = (value: unknown): value is TopicEntry => typeof value === "object" && value !== null;

/**
 * Reads the registry once, synchronously. This is the only sync filesystem call
 * in the module: it runs at host construction, before any async flow starts,
 * and its result decides whether the host may start at all.
 */
function readEntries(file: string): Map<number, TopicEntry> {
	const entries = new Map<number, TopicEntry>();
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return entries;
		throw new TopicRegistryError(
			`Registry file ${file} could not be read: ${(error as Error).message}. Fix or remove it; the bridge will not overwrite it.`,
			"broken_file",
		);
	}
	if (raw.trim() === "") return entries;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new TopicRegistryError(
			`Registry file ${file} does not parse as JSON: ${(error as Error).message}. Fix or remove it; the bridge will not overwrite it.`,
			"broken_file",
		);
	}
	if (!Array.isArray(parsed)) {
		throw new TopicRegistryError(
			`Registry file ${file} is not a session list: an array of entries was expected. Fix or remove it; the bridge will not overwrite it.`,
			"broken_file",
		);
	}
	for (const entry of parsed) {
		if (!isEntryRecord(entry) || !Number.isFinite(entry.threadId)) {
			throw new TopicRegistryError(
				`Registry file ${file} holds an entry without a numeric threadId; it answers no topic. Fix the file.`,
				"broken_file",
			);
		}
		entries.set(entry.threadId, entry);
	}
	return entries;
}

export function openTopicRegistry(options: { path: string; clock?: Clock }): TopicRegistry {
	const file = options.path;
	const clock = options.clock ?? defaultClock;
	const entries = readEntries(file);

	const sorted = (): TopicEntry[] =>
		[...entries.values()].sort(
			(left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.threadId - right.threadId,
		);
	const copy = (entry: TopicEntry | undefined): TopicEntry | null => (entry === undefined ? null : { ...entry });

	// Persistence state: one queued write at a time, coalescing every mutation
	// that arrives while a write is queued. `failure` holds the first write
	// error since the last successful write, so `flush` keeps reporting state
	// that is not (yet) on disk.
	let scheduled = false;
	let chain: Promise<void> = Promise.resolve();
	let failure: Error | null = null;

	const writeAtomic = async (): Promise<void> => {
		const dir = path.dirname(file);
		const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
		try {
			// `Bun.write` creates the state directory when it is missing.
			await Bun.write(temporary, `${JSON.stringify(sorted(), null, 2)}\n`);
			await fs.promises.rename(temporary, file);
		} catch (error) {
			await fs.promises.rm(temporary, { force: true }).catch(() => {});
			throw error;
		}
		logger.debug("telegram: registry persisted", { path: file, entries: entries.size });
	};

	/**
	 * Queues one write for the current state. A mutation that arrives while the
	 * write is already queued is covered by it, so a burst of mutations costs
	 * one write; a mutation that arrives while a write is in flight queues the
	 * next one. Failures are recorded, never thrown at the mutating caller.
	 */
	const persist = (): void => {
		if (scheduled) return;
		scheduled = true;
		chain = chain.then(async () => {
			scheduled = false;
			try {
				await writeAtomic();
				// The queued state is durable again.
				failure = null;
			} catch (error) {
				failure ??= error instanceof Error ? error : new Error(String(error));
			}
		});
	};

	const flush = async (): Promise<void> => {
		await chain;
		if (failure !== null) throw failure;
	};

	const claim = (name: unknown, threadId: number): void => {
		const wanted = nameKey(name);
		if (wanted === "") {
			throw new TopicRegistryError(
				"A session needs a name: the name is its topic, and without it the entry cannot be found.",
				"no_name",
			);
		}
		for (const entry of entries.values()) {
			if (entry.threadId !== threadId && entry.status !== "closed" && nameKey(entry.name) === wanted) {
				throw new TopicRegistryError(
					`The name "${String(name)}" is taken by open session ${entry.threadId}: close it or pick another name.`,
					"name_taken",
				);
			}
		}
	};

	const put = (entry: TopicEntryDraft): TopicEntry => {
		const threadId = entry?.threadId;
		if (!Number.isFinite(threadId)) {
			throw new TopicRegistryError("An entry without a threadId belongs to no topic.", "no_thread");
		}
		claim(entry.name, threadId);
		const previous = entries.get(threadId);
		const now = clock.now();
		const record: TopicEntry = {
			...entry,
			threadId,
			createdAt: entry.createdAt ?? previous?.createdAt ?? now,
			updatedAt: now,
		};
		entries.set(threadId, record);
		persist();
		return { ...record };
	};

	const update = (threadId: number, patch: TopicEntryPatch): TopicEntry => {
		const current = entries.get(threadId);
		if (current === undefined) {
			throw new TopicRegistryError(
				`Session ${threadId} is not in the registry: nothing to update.`,
				"unknown_thread",
			);
		}
		if (patch.name !== undefined) claim(patch.name, threadId);
		const record: TopicEntry = { ...current, ...patch, threadId, updatedAt: clock.now() };
		entries.set(threadId, record);
		persist();
		return { ...record };
	};

	const remove = (threadId: number): TopicEntry | null => {
		const current = entries.get(threadId);
		if (current === undefined) return null;
		entries.delete(threadId);
		persist();
		return { ...current };
	};

	const put_freeName = (base: string): string => {
		const free = (candidate: string): boolean => {
			const taken = byName(candidate);
			return taken === null || taken.status === "closed";
		};
		const clean = String(base).slice(0, TOPIC_NAME_LIMIT);
		if (free(clean)) return clean;
		for (let number = 2; number <= NAME_ATTEMPTS; number += 1) {
			const suffix = ` ${number}`;
			const candidate = `${clean.slice(0, TOPIC_NAME_LIMIT - suffix.length)}${suffix}`;
			if (free(candidate)) return candidate;
		}
		return clean;
	};

	const list = (): TopicEntry[] => sorted().map(entry => ({ ...entry }));
	const get = (threadId: number): TopicEntry | null => copy(entries.get(threadId));
	const byName = (name: string): TopicEntry | null => {
		const wanted = nameKey(name);
		const found = [...entries.values()].filter(entry => nameKey(entry.name) === wanted);
		return copy(found.find(entry => entry.status !== "closed") ?? found[0]);
	};
	const bySessionFile = (sessionFile: string): TopicEntry | null =>
		copy([...entries.values()].find(entry => entry.sessionFile === sessionFile));

	return {
		path: file,
		list,
		get,
		byName,
		bySessionFile,
		put,
		update,
		remove,
		freeName: put_freeName,
		flush,
	};
}
