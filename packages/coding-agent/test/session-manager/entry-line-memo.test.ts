import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import * as path from "node:path";
import * as vm from "node:vm";
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

	it("re-projects a hook-backed message instead of reusing its hookless line", async () => {
		// The conservative-union twin of the stabilizing-hook test above: that
		// one pins the always-uncached gate for messages that are hook-backed
		// from the start; this one pins the other direction — a message whose
		// hook arrives in place after its hookless line was cached must still
		// re-project. The hook is installed directly on the live `details`
		// object as a non-enumerable key with no field write, so key
		// enumeration and the stamp's leaves still compare equal — only the
		// descriptor-based hook-presence checks (gate plus matcher fallback)
		// can force the miss. Without them the second rewrite reuses the
		// hookless line instead of persisting the hook's output.
		const details: Record<string, unknown> = { ordinal: 3 };
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-hook-miss",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: hookless, so the line is stamped, cached, and carries
		// the live shape.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"ordinal":3');

		// Install the hook in place on the same object the entry holds, as a
		// non-enumerable key: `JSON.stringify` still consults it, but no
		// key walk — entry fields, stamp, or matcher leaves — can see it.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("Expected toolResult message entry");
		}
		const live = entry.message.details;
		if (live === null || typeof live !== "object") throw new Error("Expected object details");
		Object.defineProperty(live, "toJSON", {
			enumerable: false,
			configurable: true,
			value: () => 7,
		});

		// Second rewrite: the persisted body carries the hook's output, never
		// the cached hookless line.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"details":7');
		expect(bodyAfterSecond).not.toContain('"ordinal":3');
	});
	it("persists a stateful content getter's serialization-observed values instead of the probe-shifted ones", async () => {
		// The opaque `details` slot can hold a signed object with an ordinary
		// enumerable accessor — here a getter that yields a fresh payload on
		// every read. The hook pre-scan must answer through property
		// descriptors, never by reading the key: each probe read shifts the
		// sequence, so the persisted line carries a value native serialization
		// alone never produces.
		let calls = 0;
		const details: Record<string, unknown> = {
			type: "thinking",
			thinkingSignature: "sig-fix15222-stateful",
		};
		Object.defineProperty(details, "content", {
			enumerable: true,
			configurable: true,
			get() {
				calls++;
				return `payload-${calls}`;
			},
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-stateful",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// One atomic publish performs two full-body serializations (materialize,
		// then commit), so the getter runs exactly twice and the persisted line
		// carries the second serialization's payload — a probe that reads the
		// key runs it four times and persists payload-4.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(calls).toBe(2);
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"content":"payload-2"');
	});

	it("rewrites a session whose details is a Number-prototype object without latching a persistence failure", async () => {
		// `Object.create(Number.prototype)` passes `instanceof Number` (the
		// prototype chain check) but carries no [[NumberData]] slot, so
		// `Number.prototype.valueOf` throws on it while `JSON.stringify`
		// serializes it as `{}`. The stamp must answer the unbox question with
		// an intrinsic brand check and fall back to the object walk — never
		// throw on data the serializer accepts.
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-brandless",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: Object.create(Number.prototype),
			isError: false,
			timestamp: Date.now(),
		});

		// Full rewrite succeeds and the line carries `{}`, exactly what the
		// serializer emits — no latched failure, no truncated body.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"details":{}');
		expect(body).toContain('"toolName":"bash"');
	});

	it("strips jsonlEvents an overridden array iterator hides from the projector pre-scan", async () => {
		// `details` is the tool result's opaque slot, so an extension can hand
		// it an array whose iterator hides an indexed object carrying
		// `jsonlEvents`. The projector's pre-scan must walk indexed slots the
		// way `JSON.stringify` reads them: transient streaming events must
		// never reach a persisted line through an iterator-shaped hole.
		const details: unknown[] = [{ seq: 1, jsonlEvents: [{ event: "hidden" }] }];
		details[Symbol.iterator] = function* hiddenIterator(): ArrayIterator<unknown> {
			// Deliberately yields nothing: the indexed slot is invisible here.
		};
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-hidden-iterator",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// The persisted line drops the hidden transient key and keeps the
		// surviving fields — a pre-scan that trusts the iterator takes the
		// verbatim fast path and leaks the raw streaming events.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).not.toContain("jsonlEvents");
		expect(body).toContain('"seq":1');
	});

	it("never invokes a stateful prototype data getter while persisting an image block", async () => {
		// An extension can supply a class-backed image block whose `data` rides
		// a prototype getter that yields a fresh payload on every read. The
		// projector must answer its acceptance question through property
		// descriptors, never by reading the key: each acceptance read shifts
		// the sequence, so the persisted line carries bytes native
		// serialization alone never produces — and the memo must not cache a
		// line whose source no stamp can describe.
		let calls = 0;
		class PrototypeImage {
			readonly type = "image" as const;
			readonly mimeType = "image/png";
			get data(): string {
				calls++;
				return `payload-${calls}`;
			}
		}
		// The getter stays non-enumerable on the prototype, so the projector's
		// spread never copies an observed value into the projected line.
		Object.defineProperty(PrototypeImage.prototype, "data", { enumerable: false });
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "user" as const,
			content: [new PrototypeImage()],
			timestamp: Date.now(),
		});

		// One atomic publish performs two full-body serializations (materialize,
		// then commit). The acceptance checks read descriptors only — the
		// getter runs exactly zero times outside serialization, so the
		// persisted line carries no getter-shifted bytes.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(calls).toBe(0);
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"type":"image"');
		expect(body).not.toContain("payload-");
	});

	it("persists the current bytes of an inherited-data image payload mutated in place", async () => {
		// An extension can supply an image block whose `data` rides an
		// inherited string descriptor: the projector accepts it (its `in`
		// checks read through the chain) and externalizes the live bytes, so
		// the stamp must track those bytes — an own-enumerable-only stamp
		// compares equal after a mutation and reuses the old blob ref,
		// restoring the previous image on reload.
		const backing = { data: LARGE_BASE64 };
		const block = Object.create(backing);
		block.type = "image";
		block.mimeType = "image/png";
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage({
			role: "user" as const,
			content: [block],
			timestamp: Date.now(),
		});

		// First rewrite: the live bytes are externalized to a blob ref.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		const refsAfterFirst = persistedBlobRefs(bodyAfterFirst);
		expect(refsAfterFirst).toHaveLength(1);
		const originalRef = refsAfterFirst[0];
		if (!originalRef) throw new Error("Expected blob reference");
		expect(await blobBytesBase64(originalRef)).toBe(LARGE_BASE64);

		// Mutate the backing bytes behind the inherited descriptor: no own key
		// changes, so an own-enumerable stamp still matches the original line.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "user")
			throw new Error("Expected user message entry");
		const content = entry.message.content;
		if (!Array.isArray(content)) throw new Error("Expected array content");
		if (content[0] == null || typeof content[0] !== "object") throw new Error("Expected image block");
		expect("data" in content[0]).toBe(true);
		backing.data = "B".repeat(2048);

		// Second rewrite: the persisted line carries a new ref for the new
		// bytes — reloading restores the mutated image, not the previous one.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		const refsAfterSecond = persistedBlobRefs(bodyAfterSecond);
		expect(refsAfterSecond).toHaveLength(1);
		const mutatedRef = refsAfterSecond[0];
		if (!mutatedRef) throw new Error("Expected blob reference");
		expect(mutatedRef).not.toBe(originalRef);
		expect(await blobBytesBase64(mutatedRef)).toBe(backing.data);
		expect(bodyAfterSecond).not.toContain(originalRef);
	});
	it("persists a jsonlEvents mutation inside a typeless anthropicCompaction carrier", async () => {
		// The preserveData-style compaction carrier has no `type` marker of its
		// own (`{ content, jsonlEvents }` under the `anthropicCompaction`
		// key), yet `truncateForPersistence` returns it verbatim — so the
		// stamp must classify it atomic and walk the transient key whole. A
		// key-based check guarded on `"type" in obj` stamps the events as
		// presence-only, and a later in-place mutation compares equal and
		// reuses the old line although a fresh projection emits the new value.
		const carrier: Record<string, unknown> = { content: "summary", jsonlEvents: [{ seq: 1 }] };
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-compaction",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: { anthropicCompaction: carrier },
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: the verbatim carrier keeps its events on the line.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"seq":1');

		// Mutate the event in place: same carrier, same array, only the leaf changes.
		const events = carrier.jsonlEvents;
		if (!Array.isArray(events)) throw new Error("Expected events array");
		const event = events[0] as Record<string, unknown>;
		event.seq = 2;

		// Second rewrite: the persisted line carries the mutated event — a
		// presence-only stamp reuses the old line and a reload restores seq 1.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"seq":2');
		expect(bodyAfterSecond).not.toContain('"seq":1');
	});
	it("persists a stateful indexed getter's serialization-observed values instead of the probe-shifted ones", async () => {
		// The opaque `details` slot can hold a signed object with a nested
		// array whose slot resolves through a getter that yields a fresh
		// payload on every read. The hook pre-scan must answer through the
		// indexed property's descriptor, never by reading the slot: each probe
		// read shifts the sequence, so the persisted line carries values
		// native serialization alone never produces.
		let calls = 0;
		const slots: unknown[] = [];
		Object.defineProperty(slots, "0", {
			enumerable: true,
			configurable: true,
			get() {
				calls++;
				return `slot-payload-${calls}`;
			},
		});
		slots.length = 1;
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-indexed-getter",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: { type: "thinking", thinkingSignature: "sig-fix15222-indexed", items: slots },
			isError: false,
			timestamp: Date.now(),
		});

		// One atomic publish performs two full-body serializations (materialize,
		// then commit), so the getter runs exactly twice and the persisted line
		// carries the second serialization's payload — a probe that reads the
		// slot runs it four times and persists slot-payload-4.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(calls).toBe(2);
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"items":["slot-payload-2"]');
	});
	it("rewrites a spilled MCP tool result whose stripped structuredContent is cyclic", async () => {
		// An extension-created tool result with the MCP spill markers and a
		// cyclic `details.structuredContent` was previously persistable:
		// `stripSpilledMcpStructuredContent` removes the field before
		// serialization. The hook pre-scan must mirror that strip — walking
		// the original graph recurses into the cycle, overflows the stack, and
		// latches a persistence failure on every full rewrite.
		const structuredContent: Record<string, unknown> = { rows: [{ id: 1 }] };
		structuredContent.self = structuredContent;
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-cyclic-spill",
			toolName: "mcp-tool",
			content: [{ type: "text" as const, text: "ok" }],
			details: {
				serverName: "fix15222-server",
				mcpToolName: "fix15222-tool",
				structuredContent,
				meta: { truncation: { artifactId: "artifact-fix15222" } },
			},
			isError: false,
			timestamp: Date.now(),
		});

		// Full rewrite succeeds: the persisted line drops the stripped field
		// and carries the surviving markers — no latched failure, no truncated
		// body.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).not.toContain("structuredContent");
		expect(body).toContain('"mcpToolName":"fix15222-tool"');
	});
	it("persists the new value of a foreign-realm boxed-number detail changed in place", async () => {
		// A `node:vm`-created `Number` wrapper fails the local-realm
		// `instanceof` gate although `Number.prototype.valueOf` succeeds and
		// `JSON.stringify` emits the primitive. The stamp must answer the
		// unbox question with the intrinsic brand check alone: a realm-gated
		// stamp records both values as the same empty object and reuses the
		// line containing `1` after the swap to `2`.
		const foreignNumber = (source: string): unknown => vm.runInNewContext(source) as unknown;
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-foreign-number",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: foreignNumber("new Number(1)"),
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: the persisted body carries the original boxed value.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"details":1');

		// Swap the foreign-realm boxed value in place.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("Expected toolResult message entry");
		}
		entry.message.details = foreignNumber("new Number(2)");

		// Second rewrite: the persisted body carries `2`, not the stale `1`.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"details":2');
		expect(bodyAfterSecond).not.toContain('"details":1');
	});
	it("persists the current blob ref of a class-backed image_generation_call mutated in place", async () => {
		// An extension can supply a class-backed `image_generation_call`
		// whose oversized `result` rides an inherited data descriptor.
		// `truncateForPersistence` reads it via `"result" in obj` and rewrites
		// it into an own blob ref, but an own-key stamp cannot see the backing
		// field: mutating it leaves the stamp equal, so a rewrite reuses the
		// previous ref and reload restores the old generated image. The memo
		// leaves such nodes uncached so the line is always re-projected from
		// the live input.
		const backing = { result: LARGE_BASE64 };
		class GenerationCall {
			readonly type = "image_generation_call" as const;
		}
		Object.setPrototypeOf(GenerationCall.prototype, backing);
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-generation",
			toolName: "image",
			content: [{ type: "text" as const, text: "ok" }],
			details: { generation: new GenerationCall() },
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: the live result is externalized to a blob ref.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		const refsAfterFirst = persistedBlobRefs(bodyAfterFirst);
		expect(refsAfterFirst).toHaveLength(1);
		const originalRef = refsAfterFirst[0];
		if (!originalRef) throw new Error("Expected blob reference");
		expect(await blobBytesBase64(originalRef)).toBe(LARGE_BASE64);

		// Mutate the backing result behind the inherited descriptor: no own
		// key changes, so an own-key stamp still matches the original line.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("Expected toolResult message entry");
		}
		const mutatedBase64 = "C".repeat(2048);
		backing.result = mutatedBase64;

		// Second rewrite: the persisted line carries a new ref for the new
		// bytes — reloading restores the mutated image, not the previous one.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		const refsAfterSecond = persistedBlobRefs(bodyAfterSecond);
		expect(refsAfterSecond).toHaveLength(1);
		const mutatedRef = refsAfterSecond[0];
		if (!mutatedRef) throw new Error("Expected blob reference");
		expect(mutatedRef).not.toBe(originalRef);
		expect(await blobBytesBase64(mutatedRef)).toBe(mutatedBase64);
		expect(bodyAfterSecond).not.toContain(originalRef);
	});
	it("persists a custom message's marker-shaped structuredContent mutated in place", async () => {
		// A custom message's opaque `details` can carry the same MCP spill
		// markers a tool result's does — but `stripSpilledMcpStructuredContent`
		// strips only the top-level `details` of `role === "toolResult"`, so
		// the custom line keeps `structuredContent` in its persisted bytes. A
		// key-only stamp mirror skips the field for every role, so an in-place
		// change survives every cache check and the rewrite reuses stale JSONL.
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage({
			role: "custom" as const,
			customType: "fix15222-spill-custom",
			content: "spilled",
			display: false,
			details: {
				serverName: "fix15222-server",
				mcpToolName: "fix15222-tool",
				structuredContent: { marker: "original" },
				meta: { truncation: { artifactId: "artifact-fix15222" } },
			},
			timestamp: Date.now(),
		});

		// First rewrite: the persisted line keeps the custom message's
		// `structuredContent` — the projector strips only tool results.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"marker":"original"');

		// Mutate the kept field in place: the key-only mirror never walked
		// it, so its stamp still matches the original line.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "custom") {
			throw new Error("Expected custom message entry");
		}
		const details = entry.message.details;
		if (details === null || typeof details !== "object" || !("structuredContent" in details)) {
			throw new Error("Expected marker-shaped details");
		}
		const structuredContent = details.structuredContent;
		if (
			structuredContent === null ||
			typeof structuredContent !== "object" ||
			!("marker" in structuredContent) ||
			typeof structuredContent.marker !== "string"
		) {
			throw new Error("Expected structuredContent marker");
		}
		structuredContent.marker = "mutated";

		// Second rewrite: the persisted line carries the mutated marker, not
		// the stale original reused from the cache.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"marker":"mutated"');
		expect(bodyAfterSecond).not.toContain('"marker":"original"');
	});
	it("rewrites a session whose details defines a throwing Symbol.toStringTag getter without latching a persistence failure", async () => {
		// The opaque `details` slot can define a `Symbol.toStringTag` getter —
		// even a non-enumerable one — that `JSON.stringify` never consults
		// (symbol-keyed fields are invisible to serialization). The brand
		// check must answer with the intrinsic `valueOf` calls alone: reading
		// the tag runs user code the serializer ignores, so a throwing getter
		// fails the probe over a value that serializes normally and latches a
		// persistence failure on every full rewrite.
		const details: Record<string, unknown> = { payload: "fix15222-tag" };
		Object.defineProperty(details, Symbol.toStringTag, {
			enumerable: false,
			configurable: true,
			get(): string {
				throw new Error("boom-fix15222-tag");
			},
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-tag",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// Full rewrite succeeds and the line carries the payload, exactly
		// what the serializer emits — no latched failure, no truncated body.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"payload":"fix15222-tag"');
		expect(body).toContain('"toolName":"bash"');
	});
	it("never reuses a line for a bigint detail whose BigInt.prototype serializer is stateful", async () => {
		// `details` is the tool result's opaque slot, so an extension can hand
		// it a bigint — and a runtime can install `BigInt.prototype.toJSON`,
		// which `JSON.stringify` invokes even though the value is primitive.
		// The hook's output is a function call, not a field value: this one
		// emits a fresh revision on every call, while no field is ever
		// written. The probe must detect the prototype hook and leave the
		// graph uncached; a stamp taken from one call cannot describe the
		// bytes another call produces.
		let revision = 0;
		const previousBigIntToJSON = Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON");
		Object.defineProperty(BigInt.prototype, "toJSON", {
			enumerable: false,
			configurable: true,
			value(this: bigint): string {
				revision++;
				return `bigint-rev-${revision}`;
			},
		});
		try {
			const session = SessionManager.create(process.cwd(), sessionDir, storage);
			session.appendMessage({
				role: "toolResult" as const,
				toolCallId: "call-fix15222-bigint-hook",
				toolName: "bash",
				content: [{ type: "text" as const, text: "ok" }],
				details: { count: 42n },
				isError: false,
				timestamp: Date.now(),
			});

			// Every rewrite re-projects through the serializer: each published
			// body carries the output of the serialization that produced it —
			// here the second serialization's revision, since one atomic
			// publish serializes the body twice (materialize, then commit).
			await session.appendEntriesAtomically(() => {});
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file");
			const bodyAfterFirst = storage.readTextSync(sessionFile);
			expect(bodyAfterFirst).toContain('"count":"bigint-rev-2"');

			// Second rewrite: a fresh revision again — the first call's output
			// restored from a reused line would pin `bigint-rev-2` forever.
			// (The no-op second publish serializes the untouched body once
			// more rather than twice, so the counter advances by one.)
			await session.appendEntriesAtomically(() => {});
			const bodyAfterSecond = storage.readTextSync(sessionFile);
			expect(bodyAfterSecond).toContain('"count":"bigint-rev-3"');
			expect(bodyAfterSecond).not.toContain('"count":"bigint-rev-2"');
		} finally {
			// A runtime, an extension shim, or another test file in this worker can
			// have a `BigInt.prototype.toJSON` of its own installed before this test
			// runs. Put back exactly what this test found — reinstalling a saved
			// descriptor, or deleting the own property when there was none — so a
			// hook owned elsewhere survives this file.
			if (previousBigIntToJSON === undefined) {
				Reflect.deleteProperty(BigInt.prototype, "toJSON");
			} else {
				Object.defineProperty(BigInt.prototype, "toJSON", previousBigIntToJSON);
			}
		}
	});

	// Another owner can install a `BigInt.prototype.toJSON` hook before any
	// test in this describe runs — a sibling file's describe-scope setup, an
	// extension shim, a runtime the worker booted with. It stands in for every
	// such owner: the bigint test above replaces whatever it finds with its
	// own stateful hook, so its cleanup has to put back what it found instead
	// of deleting the key.
	const SENTINEL_BIGINT_TO_JSON = "fix15222-sentinel-bigint-tojson";
	const originalBigIntToJSON = Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON");
	const sentinelBigIntToJSON = function sentinelBigIntToJSON(): string {
		return SENTINEL_BIGINT_TO_JSON;
	};
	let sentinelInstalled = false;
	beforeAll(() => {
		Object.defineProperty(BigInt.prototype, "toJSON", {
			enumerable: false,
			configurable: true,
			value: sentinelBigIntToJSON,
		});
		sentinelInstalled = true;
	});
	afterAll(() => {
		// Same save/restore discipline this describe holds the bigint test to:
		// the sentinel must not outlive the describe either.
		if (originalBigIntToJSON === undefined) {
			Reflect.deleteProperty(BigInt.prototype, "toJSON");
			return;
		}
		Object.defineProperty(BigInt.prototype, "toJSON", originalBigIntToJSON);
	});

	it("restores a BigInt.prototype serializer another owner installed before it", async () => {
		// The unconditional `Reflect.deleteProperty` in the bigint test above
		// destroyed any pre-installed `BigInt.prototype.toJSON` for the rest of
		// the worker: a later file that serializes a bigint through the hook
		// it installed saw `undefined` output or a TypeError instead, with
		// nothing in this file failing to point at it. What survives here is
		// exactly the sentinel `beforeAll` installed — same function, still
		// callable.
		expect(sentinelInstalled).toBe(true);
		// The very hook `beforeAll` installed — not a stand-in left behind by
		// the test above.
		expect(Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON")?.value).toBe(sentinelBigIntToJSON);
		// And the serializer still consults it: an owner that installed the
		// hook before this file ran keeps the projection it relied on.
		expect(JSON.stringify({ count: 42n })).toBe('{"count":"fix15222-sentinel-bigint-tojson"}');
	});

	it("persists a details payload nested deeper than the recursive hook probe could walk", async () => {
		// `details` is the tool result's opaque slot, and it can hold a graph
		// nested far deeper than JS recursion reaches — an opaque extension
		// payload wrapped once per nesting level, with a serializer hook at the
		// bottom. Persistence keeps a signed details object verbatim, so a
		// payload like this serialized fine before the memo landed; the memo's
		// hook probe then walked it one stack frame per level and overflowed
		// (~14k levels) before ever reaching the leaf, so every full rewrite
		// latched a persistence failure on it. The probe must reach the hook
		// however deep it sits and leave the graph uncached, and the publish
		// must still carry all of the payload.
		const depth = 25_000;
		let nested: unknown = { toJSON: () => "fix15222-deep-hook" };
		for (let level = 0; level < depth; level++) nested = { child: nested };
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-deep-hook",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			// Signed: `truncateForPersistence` returns the whole object before its
			// key-stripping loop, so the nested payload reaches the line.
			details: {
				type: "thinking",
				thinking: "opaque extension payload",
				thinkingSignature: "sig-fix15222-deep",
				nested,
			},
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: every level reaches the line, hook leaf included.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst.match(/"child":/g)).toHaveLength(depth);
		expect(bodyAfterFirst).toContain('"child":"fix15222-deep-hook"');

		// Second rewrite: byte-identical body — the hook-backed line is
		// re-projected from the same serialization on every publish rather than
		// reused from a stamp of the first one.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toBe(bodyAfterFirst);
	}, 60_000);
});
