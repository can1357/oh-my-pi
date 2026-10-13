import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import * as path from "node:path";
import { TempDir, __resetDirsFromEnvForTests, getBlobsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { parseBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

// Exceeds BLOB_EXTERNALIZE_THRESHOLD (1024) so image blocks are externalized to blob refs.
const LARGE_BASE64 = "A".repeat(2048);

function makeUserMessageWithImage() {
	return {
		role: "user" as const,
		content: [{ type: "image" as const, data: LARGE_BASE64, mimeType: "image/png" }],
		timestamp: Date.now(),
	};
}

/** `details` is the tool result's opaque slot, so it can hold any JSON value. */
function makeToolResultWithBoxedDetails() {
	return {
		role: "toolResult" as const,
		toolCallId: "call-fix15222",
		toolName: "bash",
		content: [{ type: "text" as const, text: "ok" }],
		details: new Number(1),
		isError: false,
		timestamp: Date.now(),
	};
}

const BLOB_REF_PATTERN = /blob:sha256:[a-f0-9]{64}/g;

function persistedBlobRefs(body: string): string[] {
	return body.match(BLOB_REF_PATTERN) ?? [];
}

/** Base64 bytes the blob store holds for `ref`; throws when the ref or blob is malformed or missing. */
async function blobBytesBase64(ref: string): Promise<string> {
	const hash = parseBlobRef(ref);
	if (!hash) throw new Error(`Expected blob reference, got ${ref}`);
	return Buffer.from(await Bun.file(path.join(getBlobsDir(), hash)).arrayBuffer()).toString("base64");
}

async function removeBlob(ref: string): Promise<void> {
	const hash = parseBlobRef(ref);
	if (!hash) throw new Error(`Expected blob reference, got ${ref}`);
	await Bun.file(path.join(getBlobsDir(), hash))
		.delete()
		.catch(() => {});
	await Bun.file(path.join(getBlobsDir(), `${hash}.png`))
		.delete()
		.catch(() => {});
}

describe("SessionManager entry-line memo", () => {
	// `setAgentDir` overwrites all three keys below (it also clears the profile
	// pair); every one is restored in `afterEach` so no later file inherits a
	// redirected agent dir.
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalOmpProfile = process.env.OMP_PROFILE;
	const originalPiProfile = process.env.PI_PROFILE;

	let tempDirs: TempDir[] = [];
	let storage: MemorySessionStorage;
	let sessionDir: string;
	let writeSpy: Mock<MemorySessionStorage["writeTextAtomic"]>;

	beforeEach(() => {
		const dir = TempDir.createSync("fix15222-memo-");
		tempDirs.push(dir);
		// Absolute, so the redirected agent dir in the environment is not
		// interpreted against whichever cwd a later test runs from.
		sessionDir = dir.absolute();
		// The blob store `SessionManager` externalizes oversized payloads into is
		// resolved from the process-global agent dir, which no env assignment
		// alone can move (the dir resolver froze at import time). Point it at this
		// test's temp root so those bytes — and the hardlinks the store keeps for
		// them — are deleted with the temp dir instead of surviving the run in the
		// developer's real blob directory.
		setAgentDir(path.join(sessionDir, "agent"));
		storage = new MemorySessionStorage();
		writeSpy = spyOn(MemorySessionStorage.prototype, "writeTextAtomic");
	});

	afterEach(() => {
		writeSpy.mockRestore();
		restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
		restoreEnv("OMP_PROFILE", originalOmpProfile);
		restoreEnv("PI_PROFILE", originalPiProfile);
		__resetDirsFromEnvForTests();
		for (const dir of tempDirs) dir.removeSync();
		tempDirs = [];
	});

	it("persists the same blob ref for an unchanged entry and a new ref when the nested image payload is mutated in place", async () => {
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage(makeUserMessageWithImage());

		// First rewrite: the oversized image is externalized into the blob store
		// the session resolved from the agent dir. That store must be this test's
		// temp root: without the redirect above it is the developer's real blob
		// directory, which the temp-dir cleanup below never reaches.
		await session.appendEntriesAtomically(() => {});
		expect(getBlobsDir()).toBe(path.join(sessionDir, "agent", "blobs"));

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		const refsAfterFirst = persistedBlobRefs(bodyAfterFirst);
		expect(refsAfterFirst).toHaveLength(1);
		const originalRef = refsAfterFirst[0];
		if (!originalRef) throw new Error("Expected blob reference");
		expect(await blobBytesBase64(originalRef)).toBe(LARGE_BASE64);
		expect(bodyAfterFirst).not.toContain(LARGE_BASE64);

		// Second rewrite with no changes: the persisted body is byte-identical —
		// the same line, still pointing at the original bytes.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toBe(bodyAfterFirst);

		// Mutate the nested image payload in place: same content array, same block object,
		// only the base64 leaf changes. Identity checks at any depth still compare equal.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "user")
			throw new Error("Expected user message entry");
		const content = entry.message.content;
		if (!Array.isArray(content)) throw new Error("Expected array content");
		const imageBlock = content[0];
		if (typeof imageBlock === "string" || imageBlock.type !== "image") throw new Error("Expected image block");
		const mutatedBase64 = "B".repeat(2048);
		imageBlock.data = mutatedBase64;

		// Third rewrite: the persisted line carries a new ref for the new payload,
		// and the old ref is gone — reloading restores the mutated image, not the
		// previous one.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterThird = storage.readTextSync(sessionFile);
		const refsAfterThird = persistedBlobRefs(bodyAfterThird);
		expect(refsAfterThird).toHaveLength(1);
		const mutatedRef = refsAfterThird[0];
		if (!mutatedRef) throw new Error("Expected blob reference");
		expect(mutatedRef).not.toBe(originalRef);
		expect(await blobBytesBase64(mutatedRef)).toBe(mutatedBase64);
		expect(bodyAfterThird).not.toContain(originalRef);
		expect(bodyAfterThird).not.toContain(mutatedBase64);
	});

	it("re-mints the blob bytes on the recovery rewrite after a disk failure", async () => {
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage(makeUserMessageWithImage());

		// First rewrite: succeeds, and the persisted line points at the original bytes.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		const refsAfterFirst = persistedBlobRefs(bodyAfterFirst);
		expect(refsAfterFirst).toHaveLength(1);
		const originalRef = refsAfterFirst[0];
		if (!originalRef) throw new Error("Expected blob reference");
		expect(await blobBytesBase64(originalRef)).toBe(LARGE_BASE64);

		// Second rewrite: storage rejects the write. The line that failed to land
		// leaves its blob unreferenced, so `omp gc` may collect it before the
		// recovery rewrite runs — remove it while the write is still in flight so
		// the recovery must re-mint the bytes rather than re-publish a ref whose
		// blob no longer exists.
		writeSpy.mockImplementationOnce(async () => {
			for (const ref of persistedBlobRefs(storage.readTextSync(sessionFile))) await removeBlob(ref);
			throw new Error("disk full");
		});
		await expect(session.appendEntriesAtomically(() => {})).rejects.toThrow("disk full");

		// Recovery: the persisted body still references the same content-addressed
		// ref, and the blob bytes are back on disk holding the original image.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterRecovery = storage.readTextSync(sessionFile);
		expect(persistedBlobRefs(bodyAfterRecovery)).toEqual([originalRef]);
		expect(await blobBytesBase64(originalRef)).toBe(LARGE_BASE64);
	});

	it("persists the current value of a non-message entry mutated in place", async () => {
		const session = SessionManager.create(process.cwd(), sessionDir, storage);

		// Append a non-message entry (model change).
		const entryId = session.appendModelChange("claude-sonnet-4-5");

		// First rewrite: serializes the header + model change entry.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain("claude-sonnet-4-5");

		// Mutate the entry in place.
		const entry = session.getEntries().find(e => e.id === entryId);
		if (!entry || entry.type !== "model_change") throw new Error("Expected model_change entry");
		entry.model = "gpt-5-mini";

		// Second rewrite: non-message entries are always re-projected, so the
		// persisted body carries the mutated value, not a stale line.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain("gpt-5-mini");
		expect(bodyAfterSecond).not.toContain("claude-sonnet-4-5");
	});

	it("persists the new value of a boxed-primitive detail changed in place", async () => {
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage(makeToolResultWithBoxedDetails());

		// First rewrite: the persisted body carries the original boxed value.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"details":1');

		// Swap the boxed value in place: a `Number` wrapper has no enumerable own
		// keys and no `toJSON`, so a stamp taken from its container shape treats
		// `new Number(1)` and `new Number(2)` as the same empty object — while
		// the projection reads `1` and then `2` into the line.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("Expected toolResult message entry");
		}
		entry.message.details = new Number(2);

		// Second rewrite: the persisted body carries `2`, not the stale `1`.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"details":2');
		expect(bodyAfterSecond).not.toContain('"details":1');
	});

	it("persists an indexed-slot change when details is an array with an overridden Symbol.iterator", async () => {
		// `details` is the tool result's opaque slot, so an extension can hand it
		// an array whose iterator yields a frozen snapshot while the slots move.
		const details = ["a", "b"];
		details[Symbol.iterator] = function* constantIterator(): ArrayIterator<string> {
			yield "a";
			yield "b";
		};
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-iterator",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: the persisted line carries the original slots.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"details":["a","b"]');

		// Move a slot in place: `JSON.stringify` serializes the indexed slots,
		// but the overridden iterator still yields the old pair — a stamp that
		// walks the iterator compares equal and reuses the stale line.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("Expected toolResult message entry");
		}
		const live = entry.message.details;
		if (!Array.isArray(live)) throw new Error("Expected array details");
		live[0] = "z";

		// Second rewrite: the persisted line carries the moved slot.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"details":["z","b"]');
		expect(bodyAfterSecond).not.toContain('"details":["a","b"]');
	});

	it("re-projects a details value swapped between JSON.rawJSON and a same-shaped plain object", async () => {
		if (!("rawJSON" in JSON) || typeof JSON.rawJSON !== "function") {
			throw new Error("Expected JSON.rawJSON support");
		}
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-rawjson",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: JSON.rawJSON("1"),
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: the branded value serializes as its payload verbatim.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"details":1');

		// Swap brands in place: `JSON.rawJSON("1")` and `{ rawJSON: "1" }` share
		// the same enumerable graph, but the projection emits `1` for the former
		// and `{"rawJSON":"1"}` for the latter — a stamp of the container shape
		// compares equal and reuses the stale line.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("Expected toolResult message entry");
		}
		entry.message.details = { rawJSON: "1" };

		// Second rewrite: the persisted line carries the plain object's shape.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"details":{"rawJSON":"1"}');
	});

	it("persists a jsonlEvents mutation inside a signed details object that persistence keeps verbatim", async () => {
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-atomic",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			// Signed: `truncateForPersistence` returns the whole object before its
			// key-stripping loop, so `jsonlEvents` reaches the persisted line.
			details: {
				type: "thinking",
				thinking: "opaque extension payload",
				thinkingSignature: "sig-fix15222",
				jsonlEvents: [{ seq: 1 }],
			},
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: the atomic details object lands on the line whole.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"jsonlEvents":[{"seq":1}]');

		// Mutate the events in place: the stamp must track them because the
		// projection kept them — an unconditional transient skip compares equal
		// and reuses the stale line.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("Expected toolResult message entry");
		}
		const details = entry.message.details;
		if (typeof details !== "object" || details === null || !("jsonlEvents" in details)) {
			throw new Error("Expected atomic details with jsonlEvents");
		}
		const events = details.jsonlEvents;
		if (!Array.isArray(events)) throw new Error("Expected jsonlEvents array");
		const first = events[0];
		if (typeof first !== "object" || first === null || !("seq" in first)) {
			throw new Error("Expected first event");
		}
		first.seq = 2;

		// Second rewrite: the persisted line carries the mutated event.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"jsonlEvents":[{"seq":2}]');
		expect(bodyAfterSecond).not.toContain('"jsonlEvents":[{"seq":1}]');
	});

	it("never reuses a line for a hook-backed details value whose serializer is stateful", async () => {
		// `details` is the tool result's opaque slot, so an extension can hand it
		// a value that serializes through `toJSON`. The hook's output is a
		// function call, not a field value: this one emits `1` on its first call
		// and `2` on every later call, while no field is ever written.
		let calls = 0;
		const details = {
			toJSON(): number {
				calls++;
				return calls === 1 ? 1 : 2;
			},
		};
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-hook",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// Every rewrite re-projects through the serializer: a stamp taken from
		// one hook call cannot describe the bytes another call produces, so the
		// line is never reused — each published body carries the output of the
		// serialization that produced it.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"details":2');
		expect(bodyAfterFirst).not.toContain('"details":1');

		// Second rewrite: still `2` — the stabilized output — rather than the
		// first call's `1` restored from a reused line.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"details":2');
		expect(bodyAfterSecond).not.toContain('"details":1');
	});

	it("re-normalizes lineCount when a stripped transient key is deleted after the rebuild that normalized it", async () => {
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const details: Record<string, unknown> = {
			content: "a\nb",
			lineCount: 7,
			jsonlEvents: [{ seq: 1 }],
		};
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-transient-count",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: the transient key forces the rebuild pass, which strips
		// it and normalizes the inconsistent count to the content's two lines.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"lineCount":2');
		expect(bodyAfterFirst).not.toContain("jsonlEvents");

		// Delete only the stripped key: a fresh projection now takes the fast
		// path and serializes the live count — a stamp that skips stripped keys
		// compares equal and reuses the normalized line instead.
		delete details.jsonlEvents;

		// Second rewrite: the persisted line carries the live count verbatim,
		// exactly what a fresh projection serializes.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"lineCount":7');
		expect(bodyAfterSecond).not.toContain('"lineCount":2');
	});

	it("rewrites a non-atomic tool result whose stripped jsonlEvents form a back-reference cycle", async () => {
		// A streaming event can reference the array holding it. Persistence
		// strips `jsonlEvents` before serialization, so the cycle never reaches
		// the line — but the hook pre-scan must skip the stripped subgraph too,
		// or it recurses into the cycle, overflows the stack, and latches a
		// persistence failure on every full rewrite.
		const events: unknown[] = [{ seq: 1 }];
		events.push(events);
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-cyclic-transient",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: { jsonlEvents: events },
			isError: false,
			timestamp: Date.now(),
		});

		// Full rewrite succeeds: the persisted line drops the stripped key and
		// carries the surviving fields — no latched failure, no truncated body.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).not.toContain("jsonlEvents");
		expect(body).toContain('"toolName":"bash"');
	});

	it("never invokes a stateful toJSON prototype getter outside serialization", async () => {
		// The opaque `details` slot can expose its serializer through a
		// prototype getter that closes over `++revision`. The hook pre-scan
		// must answer through the property descriptor, never by reading the
		// key: the persisted line must carry exactly what the serializations
		// observed, with no extra probe invocation between them.
		let revision = 0;
		const prototype = {};
		Object.defineProperty(prototype, "toJSON", {
			enumerable: true,
			configurable: true,
			get() {
				revision++;
				const observed = revision;
				return () => observed;
			},
		});
		const details = Object.create(prototype) as Record<string, unknown>;
		details.marker = "fix15222-getter";
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-stateful-getter",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// One atomic publish performs two full-body serializations
		// (materialize, then commit), so the getter runs exactly twice and the
		// persisted line carries the second serialization's revision — a probe
		// that reads the key would run it four times and persist revision 4.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(revision).toBe(2);
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"details":2');
	});
});
