/**
 * Loads of a transcript of 8 MiB or more, a session manager's and
 * `loadSessionFile`'s, stream it through the storage's `readChunks`. A full
 * rewrite or delete of it between two chunks fails that stream with
 * `SessionReadConflictError` (or ENOENT after the bytes already read); an open
 * (with its header probe), a switch and a `loadSessionFile` then stream the
 * transcript again from its start, a bounded number of times, and never read
 * it as one string. Each test streams a 9 MiB transcript in memory up to five
 * times, so each has a 30 s timeout.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	RACED_READ_RETRIES,
	SessionReadConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as ttyid from "@oh-my-pi/pi-coding-agent/utils/ttyid";
import { TempDir } from "@oh-my-pi/pi-utils";
import { useAgentDir } from "../helpers/settings-test-state";

const MiB = 1024 * 1024;
const FILE = path.resolve("/sessions/p/raced.jsonl");
const TIMESTAMP = "2026-11-18T00:00:00.000Z";
// Past the 8 MiB above which the loader streams.
const BODY =
	`${JSON.stringify({ type: "session", version: 3, id: "raced", timestamp: TIMESTAMP, cwd: "/tmp" })}\n` +
	`${JSON.stringify({ type: "custom", id: "c1", parentId: null, timestamp: TIMESTAMP, customType: "pad", data: "x".repeat(9 * MiB) })}\n`;

/** What the running test acquired; afterEach releases it newest first, each release even after another throws. */
let cleanup: AsyncDisposableStack;
beforeEach(() => {
	cleanup = new AsyncDisposableStack();
});
afterEach(() => cleanup.disposeAsync());

/** Report no terminal until afterEach, so a manager made here overwrites no terminal's `--continue` breadcrumb. */
function withoutTerminal(): void {
	const terminalId = spyOn(ttyid, "getTerminalId").mockReturnValue(null);
	cleanup.defer(() => terminalId.mockRestore());
}

/** A missing file, coded ENOENT as the storages code it. */
function fileMissing(file: string): Error {
	return Object.assign(new Error(`File not found: ${file}`), { code: "ENOENT" });
}

/**
 * In-memory storage that streams a transcript 1 MiB at a time, and fails each
 * stream that `raced` names (by its 1-based pass number) after its first
 * chunk, as a full rewrite made between two chunks fails a chunked read. A
 * stream of a missing transcript fails with ENOENT before it reads anything.
 */
class RacedStorage extends MemorySessionStorage {
	passes = 0;
	#bytes!: Buffer;
	conflict = (file: string): Error | Promise<Error> => new SessionReadConflictError(file);
	/** Called with each stream's 1-based pass number before the stream reads anything. */
	onPass?: (pass: number) => void;

	constructor(readonly raced: (pass: number) => boolean) {
		super();
	}

	override writeTextSync(file: string, body: string): void {
		super.writeTextSync(file, body);
		if (file === FILE) this.#bytes = Buffer.from(body, "utf8");
	}

	async *readChunks(file: string, fromByte = 0): AsyncGenerator<Uint8Array> {
		const pass = ++this.passes;
		this.onPass?.(pass);
		if (!this.existsSync(file)) throw fileMissing(file);
		const bytes = this.#bytes.subarray(fromByte);
		for (let start = 0; start < bytes.byteLength; start += MiB) {
			if (start > 0 && this.raced(pass)) throw await this.conflict(file);
			yield bytes.subarray(start, start + MiB);
		}
	}
}

/** Storage holding `body` at {@link FILE} whose streams `raced` names are raced, and spies on its whole-text reads. */
function racedStorage(raced: (pass: number) => boolean, body = BODY) {
	const storage = new RacedStorage(raced);
	storage.writeTextSync(FILE, body);
	const wholeReads = [spyOn(storage, "readText"), spyOn(storage, "readTextSync")];
	return { storage, wholeReads: () => wholeReads.reduce((total, spy) => total + spy.mock.calls.length, 0) };
}

/** The first {@link RACED_READ_RETRIES} streams, which a reader that reads again gets past. */
const firstRetries = (pass: number): boolean => pass <= RACED_READ_RETRIES;
const everyPass = (): boolean => true;

/** A streamed transcript whose header and one entry fit in its first chunk. */
const shortTranscript = (id: string): string =>
	[
		{ type: "session", version: 3, id, timestamp: TIMESTAMP },
		{ type: "custom", id: `${id}-entry`, parentId: null, customType: "note", timestamp: TIMESTAMP },
	]
		.map(record => `${JSON.stringify(record)}\n`)
		.join("") + "\n".repeat(8 * MiB);

/** Make each raced stream of `storage` fail with ENOENT after `replacement` took the transcript's place. */
function replaceMidReadWithEnoent(storage: RacedStorage, replacement: string): void {
	storage.conflict = file => {
		storage.writeTextSync(file, replacement);
		return fileMissing(file);
	};
}

/** Make each raced stream of `storage` fail with ENOENT after the transcript was deleted, with nothing in its place. */
function deleteMidReadWithEnoent(storage: RacedStorage): void {
	storage.conflict = async file => {
		await storage.unlink(file);
		return fileMissing(file);
	};
}

describe("a session manager's load that a full rewrite races", () => {
	/** Each entry `manager` holds, as its type and the length of its data. */
	function held(manager: SessionManager): unknown[] {
		return manager.getEntries().map(entry => [entry.type, entry.type === "custom" ? String(entry.data).length : 0]);
	}

	it("opens the session with every entry, its header probe reading one chunk and its load streamed again", async () => {
		// The first stream is the header probe, which stops in its first chunk, so no race reaches it;
		// the second is the load's first pass, raced past that chunk.
		const { storage, wholeReads } = racedStorage(pass => pass <= 2);

		const manager = cleanup.adopt(
			await SessionManager.open(FILE, path.dirname(FILE), storage, { suppressBreadcrumb: true }),
			opened => opened.close(),
		);

		expect({
			held: held(manager),
			sessionId: manager.getSessionId(),
			passes: storage.passes,
			wholeReads: wholeReads(),
		}).toEqual({ held: [["custom", 9 * MiB]], sessionId: "raced", passes: 3, wholeReads: 0 });
	}, 30_000);

	it("opens the session after a race on a header probe that reads past its first chunk", async () => {
		// A header record longer than a chunk: the probe reads a second chunk, which the race cuts off.
		const header = {
			type: "session",
			version: 3,
			id: "raced",
			timestamp: TIMESTAMP,
			cwd: "/tmp",
			pad: "h".repeat(MiB),
		};
		const body = `${JSON.stringify(header)}\n${BODY.slice(BODY.indexOf("\n") + 1)}`;
		const { storage, wholeReads } = racedStorage(pass => pass === 1, body);

		const manager = cleanup.adopt(
			await SessionManager.open(FILE, path.dirname(FILE), storage, { suppressBreadcrumb: true }),
			opened => opened.close(),
		);

		expect({ held: held(manager), sessionId: manager.getSessionId(), wholeReads: wholeReads() }).toEqual({
			held: [["custom", 9 * MiB]],
			sessionId: "raced",
			wholeReads: 0,
		});
	}, 30_000);

	it("switches to the session with every entry, streaming the load again from its start", async () => {
		withoutTerminal();
		const { storage, wholeReads } = racedStorage(firstRetries);
		const manager = cleanup.adopt(SessionManager.create("/tmp", path.dirname(FILE), storage), created =>
			created.close(),
		);

		await manager.setSessionFile(FILE);

		expect({
			held: held(manager),
			sessionId: manager.getSessionId(),
			passes: storage.passes,
			wholeReads: wholeReads(),
		}).toEqual({ held: [["custom", 9 * MiB]], sessionId: "raced", passes: RACED_READ_RETRIES + 1, wholeReads: 0 });
	}, 30_000);

	it("surfaces the read conflict from a switch raced on every pass, after its retries, with no whole-text read", async () => {
		withoutTerminal();
		const { storage, wholeReads } = racedStorage(everyPass);
		const manager = cleanup.adopt(SessionManager.create("/tmp", path.dirname(FILE), storage), created =>
			created.close(),
		);

		const error = await manager.setSessionFile(FILE).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(SessionReadConflictError);
		expect({ passes: storage.passes, wholeReads: wholeReads() }).toEqual({
			passes: RACED_READ_RETRIES + 1,
			wholeReads: 0,
		});
	}, 30_000);

	it("gives the entries the ids and parents of the body it loads when a full write lands between the check for entry ids and the load", async () => {
		// If this regresses, opening a current-version session whose entries had
		// no ids while another writer rewrote it with ids renumbers every entry of
		// the new body, so the tree, the leaf and every reference by id break.
		const pad = (fill: string, identity: object) => ({
			type: "custom",
			customType: "pad",
			...identity,
			timestamp: TIMESTAMP,
			data: fill.repeat(9 * MiB),
		});
		const transcript = (entries: object[]) =>
			[{ type: "session", version: 3, id: "raced", timestamp: TIMESTAMP, cwd: "/tmp" }, ...entries]
				.map(entry => `${JSON.stringify(entry)}\n`)
				.join("");
		const unindexed = transcript([pad("u", {}), { type: "custom", customType: "note", timestamp: TIMESTAMP }]);
		const indexed = transcript([
			pad("i", { id: "p0", parentId: null }),
			{ type: "custom", customType: "note", id: "n1", parentId: "p0", timestamp: TIMESTAMP },
		]);
		const { storage } = racedStorage(() => false, unindexed);
		// The streams: the header probe, the load's first pass (which stops at the
		// first entry, without an id), the check that reads every entry, then the load.
		storage.onPass = pass => {
			if (pass === 4) storage.writeTextSync(FILE, indexed);
		};

		const manager = cleanup.adopt(
			await SessionManager.open(FILE, path.dirname(FILE), storage, { suppressBreadcrumb: true }),
			opened => opened.close(),
		);

		const entries = manager.getEntries();
		expect({
			entries: entries.map(entry => [entry.id, entry.parentId]),
			// The fill of the pad, which tells the two bodies apart.
			pads: entries.flatMap(entry =>
				entry.type === "custom" && entry.customType === "pad" ? [String(entry.data).charAt(0)] : [],
			),
		}).toEqual({
			entries: [
				["p0", null],
				["n1", "p0"],
			],
			pads: ["i"],
		});
	}, 30_000);

	it("uses the launch workspace when the replacement loaded after the probe has a missing cwd", async () => {
		const root = cleanup.adopt(TempDir.createSync("@omp-raced-open-"), created => created.remove());
		const launch = root.path();
		// Both opens resolve the default session dir; keep it, and any migration of it, inside the temp root.
		useAgentDir(cleanup, path.join(launch, "agent"));
		const originalCwd = path.join(launch, "original");
		const missingCwd = path.join(launch, "missing");
		await fs.mkdir(originalCwd);
		const bodyAt = (id: string, cwd: string) =>
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: TIMESTAMP, cwd })}\n${"\n".repeat(8 * MiB)}`;
		const replacement = bodyAt("replacement", missingCwd);
		const { storage } = racedStorage(() => false, bodyAt("original", originalCwd));
		storage.onPass = pass => {
			if (pass === 2) storage.writeTextSync(FILE, replacement);
		};
		const options = { initialCwd: launch, suppressBreadcrumb: true };
		const direct = cleanup.adopt(
			await SessionManager.open(FILE, undefined, racedStorage(() => false, replacement).storage, options),
			opened => opened.close(),
		);
		const raced = cleanup.adopt(await SessionManager.open(FILE, undefined, storage, options), opened =>
			opened.close(),
		);
		const workspace = (manager: SessionManager) => [
			manager.getSessionId(),
			manager.getCwd(),
			manager.getSessionDir(),
		];

		expect(workspace(direct)).toEqual([
			"replacement",
			launch,
			SessionManager.getDefaultSessionDir(launch, undefined, storage),
		]);
		expect(workspace(raced)).toEqual(workspace(direct));
	}, 30_000);

	it("retries from the start after ENOENT follows a valid streamed prefix", async () => {
		const { storage, wholeReads } = racedStorage(pass => pass === 2, shortTranscript("partial"));
		replaceMidReadWithEnoent(storage, shortTranscript("replacement"));

		const manager = cleanup.adopt(
			await SessionManager.open(FILE, path.dirname(FILE), storage, { suppressBreadcrumb: true }),
			opened => opened.close(),
		);

		expect(manager.getSessionId()).toBe("replacement");
		expect(manager.getEntries().map(entry => entry.id)).toEqual(["replacement-entry"]);
		expect(wholeReads()).toBe(0);
	}, 30_000);
});

describe("a session file load that a delete races", () => {
	it("reads the replacement from its start instead of returning the prefix read before ENOENT", async () => {
		// If this regresses, an export or other read-only load of a long transcript
		// deleted or replaced mid-read gets its first chunk's entries as the whole session.
		const { storage, wholeReads } = racedStorage(pass => pass === 1, shortTranscript("partial"));
		replaceMidReadWithEnoent(storage, shortTranscript("replacement"));

		const loaded = await loadSessionFile(FILE, storage);

		expect({
			ids: loaded.entries.map(entry => entry.id),
			sourceSize: loaded.sourceSize,
			wholeReads: wholeReads(),
		}).toEqual({
			ids: ["replacement", "replacement-entry"],
			sourceSize: Buffer.byteLength(shortTranscript("replacement")),
			wholeReads: 0,
		});
	}, 30_000);

	it("reads a transcript deleted mid-read with nothing in its place as a missing file", async () => {
		// If this regresses, a long transcript deleted while it is loaded reads as an
		// existing empty file (`sourceSize: 0`) instead of a missing one (`sourceSize: null`).
		const { storage, wholeReads } = racedStorage(pass => pass === 1, shortTranscript("deleted"));
		deleteMidReadWithEnoent(storage);

		const loaded = await loadSessionFile(FILE, storage);

		expect({ loaded, exists: storage.existsSync(FILE), wholeReads: wholeReads() }).toEqual({
			// What the whole-text route returns for a path that does not exist.
			loaded: await loadSessionFile(FILE, new MemorySessionStorage()),
			exists: false,
			wholeReads: 0,
		});
	}, 30_000);

	it("rejects with ENOENT for a transcript deleted mid-read when missing files must throw", async () => {
		const { storage, wholeReads } = racedStorage(pass => pass === 1, shortTranscript("deleted"));
		deleteMidReadWithEnoent(storage);

		await expect(loadSessionFile(FILE, storage, { throwIfMissing: true })).rejects.toMatchObject({ code: "ENOENT" });

		expect(wholeReads()).toBe(0);
	}, 30_000);
});
