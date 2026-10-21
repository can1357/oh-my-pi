import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import * as path from "node:path";
import * as vm from "node:vm";
import type { AssistantMessage, OpenAIResponsesHistoryPayload, UserMessage } from "@oh-my-pi/pi-ai";
import { TempDir, __resetDirsFromEnvForTests, getBlobsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { parseBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { makeAssistantMessage } from "./helpers";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

/**
 * The `BigInt.prototype.toJSON` the worker was running when this file loaded.
 * A test that swaps a hook on must leave exactly this descriptor behind:
 * another file in the same worker — or the runtime itself — can own it.
 */
const bigIntToJSONAtFileStart = Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON");

const SENTINEL_BIGINT_TO_JSON = "fix15222-sentinel-bigint-tojson";
// Identity is the contract, not the body: the tests assert the live
// `toJSON` descriptor's value is this very function, so it needs a stable
// named binding.
const sentinelBigIntToJSON = function sentinelBigIntToJSON(): string {
	return SENTINEL_BIGINT_TO_JSON;
};

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

	it("persists a message entry's runtime metadata changed in place", async () => {
		// Every entry carries the build identity that wrote it, and the identity
		// is an object: changing it in place keeps the same object, so a
		// shallow snapshot of the entry's own field values compares equal and
		// the rewrite reuses the line the change invalidated — a reload then
		// restores the old metadata.
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "user" as const,
			content: [{ type: "text" as const, text: "ok" }],
			timestamp: Date.now(),
		});
		const entry = session.getEntries().find(e => e.type === "message");
		if (!entry) throw new Error("Expected message entry");
		entry.runtime = { version: "fix15222-runtime-v1" };

		// First rewrite: the persisted body carries the original identity.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).toContain('"version":"fix15222-runtime-v1"');

		// Change the identity in place: the field keeps its object, so only a
		// value stamp notices.
		entry.runtime.version = "fix15222-runtime-v2";
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"version":"fix15222-runtime-v2"');
		expect(bodyAfterSecond).not.toContain('"version":"fix15222-runtime-v1"');
	});

	it("persists a custom entry's payload changed in place", async () => {
		// An extension stores its own payload on a custom entry, and the memo
		// now covers that entry type: a payload mutated in place must still
		// reach the line, so the entry's own fields need a value stamp rather
		// than a snapshot compared by identity.
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const payload = { rows: [{ id: 1 }] };
		const entryId = session.appendCustomEntry("fix15222-custom", payload);
		const entry = session.getEntries().find(e => e.id === entryId);
		if (!entry || entry.type !== "custom") throw new Error("Expected custom entry");

		// First rewrite: the persisted body carries the original payload.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).toContain('"id":1');

		// Change the payload in place: the field keeps its object, so only a
		// value stamp notices.
		payload.rows[0].id = 2;
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"id":2');
		expect(bodyAfterSecond).not.toContain('"id":1');
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

	it("does not run a stateful sibling getter the projector pre-scan reads before a dirty child", async () => {
		// The opaque `details` slot can hold a plain object whose first child
		// already requires a rewrite (a string over the persistence limit)
		// and whose later child is an own enumerable stateful getter. The
		// projector's pre-scan must not read every sibling before it tests
		// one: the later getter belongs to the rebuild serialization alone, so
		// a pre-scan that reads it too advances the payload twice and
		// persists a value no single serialization produced.
		let calls = 0;
		const details: Record<string, unknown> = { oversized: "x".repeat(500_001) };
		Object.defineProperty(details, "later", {
			enumerable: true,
			configurable: true,
			get() {
				calls++;
				return `sibling-${calls}`;
			},
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-lazy-scan",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// One atomic publish performs two full-body serializations (materialize,
		// then commit), so the getter runs exactly twice — once per rebuild. A
		// pre-scan that read every sibling first would run it four times and
		// persist the fourth payload.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(calls).toBe(2);
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"later":"sibling-2"');
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
	it("never reuses a line for a bigint detail whose BigInt.prototype serializer is stateful, and restores the hook it displaced", async () => {
		// `details` is the tool result's opaque slot, so an extension can hand
		// it a bigint — and a runtime can install `BigInt.prototype.toJSON`,
		// which `JSON.stringify` invokes even though the value is primitive.
		// The hook's output is a function call, not a field value: this one
		// emits a fresh revision on every call, while no field is ever
		// written. The probe must detect the prototype hook and leave the
		// graph uncached; a stamp taken from one call cannot describe the
		// bytes another call produces.
		//
		// Another owner can have installed a `BigInt.prototype.toJSON` of its
		// own before this test runs — a sibling file's describe-scope setup, an
		// extension shim, a runtime the worker booted with. The sentinel stands
		// in for that owner: it is installed for this test alone and put back
		// in the outer `finally` below. A describe-scope install instead left
		// the hook live for every test in between — every intervening bigint
		// serialization in the worker observed non-native output — and its
		// `afterAll` restore could clobber a hook another test installed later.
		let revision = 0;
		const originalBigIntToJSON = Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON");
		const sentinelDescriptor: PropertyDescriptor = {
			enumerable: false,
			configurable: true,
			value: sentinelBigIntToJSON,
		};
		Object.defineProperty(BigInt.prototype, "toJSON", sentinelDescriptor);
		try {
			// The stateful hook this test swaps in has to put back what it
			// found — the sentinel — rather than deleting the key.
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
				// Put back exactly what this test displaced: the sentinel stands
				// in for the owner whose hook was here first, and the
				// unconditional `Reflect.deleteProperty` an earlier revision used
				// destroyed that hook for the rest of the worker.
				Object.defineProperty(BigInt.prototype, "toJSON", sentinelDescriptor);
			}

			// What survived the stateful hook's own restore is exactly the
			// sentinel — same function, still callable — not a deleted key.
			expect(Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON")?.value).toBe(sentinelBigIntToJSON);
			// And the serializer still consults it: an owner that installed the
			// hook before this file ran keeps the projection it relied on.
			expect(JSON.stringify({ count: 42n })).toBe('{"count":"fix15222-sentinel-bigint-tojson"}');
		} finally {
			// The sentinel does not outlive this test either: put back the hook
			// this file found, or delete the own property when there was none.
			if (originalBigIntToJSON === undefined) {
				Reflect.deleteProperty(BigInt.prototype, "toJSON");
			} else {
				Object.defineProperty(BigInt.prototype, "toJSON", originalBigIntToJSON);
			}
		}
	});

	it("leaves the worker's BigInt serialization exactly as this file found it", () => {
		// The sentinel is installed and restored inside its own test, so
		// nothing this file swaps onto `BigInt.prototype` outlives it: the
		// tests that follow — and the sibling files in this worker — still
		// observe the serialization the runtime shipped. A describe-scope
		// install instead left the sentinel live for every test in between,
		// and its afterAll restore could clobber a hook a later test installed.
		expect(Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON")).toEqual(bigIntToJSONAtFileStart);
		// When the runtime started native — no hook of its own — serialization
		// still rejects a bigint exactly as the runtime ships it. A leaked
		// sentinel would have answered the call instead of throwing.
		if (bigIntToJSONAtFileStart === undefined) {
			expect(() => JSON.stringify({ count: 42n })).toThrow(TypeError);
		}
	});

	it("rewrites a deep acyclic details chain without a quadratic ancestor scan", async () => {
		// The cycle check walked the whole ancestor chain, so a deep acyclic
		// graph spent O(depth) per node: quadratic in the hook probe and in the
		// projector's pre-scan alike. The active path answers the question in
		// constant time, so the rewrite stays linear — four 25k-deep chains
		// publish in a couple of seconds instead of running into the tens of
		// seconds, and the budget below is what keeps that true.
		const depth = 25_000;
		const branches: Record<string, unknown> = {};
		for (let branch = 0; branch < 4; branch++) {
			let nested: unknown = { leaf: "fix15222-deep-chain" };
			for (let level = 0; level < depth; level++) nested = { child: nested };
			branches[`branch${branch}`] = nested;
		}
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-deep-chain",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: branches,
			isError: false,
			timestamp: Date.now(),
		});

		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body.match(/"leaf":"fix15222-deep-chain"/g)).toHaveLength(4);
		// The budget separates the linear walk from the quadratic one, and
		// wall-clock on a shared box swings about 2x run to run: the linear
		// implementations measure 8.5-17.7 s here, while the ancestor-chain
		// walk this guard exists for measures 39-45 s. 20 s keeps the
		// discrimination and stops the guard from failing a linear
		// implementation on a loaded box.
	}, 20_000);

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

	it("persists a hook-free details payload nested deeper than the recursive stamp could walk", async () => {
		// `details` is the tool result's opaque slot, so it can hold a plain,
		// hook-free JSON graph nested far deeper than JS recursion reaches —
		// an opaque extension payload wrapped once per nesting level, with a
		// leaf at the bottom. Persistence kept a payload like this verbatim
		// before the entry-line memo landed (only native `JSON.stringify`
		// bounded the walk, ~40k levels); the memo then walked it one JS stack
		// frame per level and overflowed — `messageValueStamp` at ~13k levels,
		// the projector's pre-scan at ~20k — so every full rewrite latched a
		// persistence failure on a graph that used to persist. The stamp, its
		// matcher, and the pre-scan must reach the leaf however deep it sits,
		// and a mutation at the bottom must still invalidate the stamped line.
		const depth = 22_000;
		let nested: unknown = { leaf: "fix15222-deep-bottom" };
		for (let level = 0; level < depth; level++) nested = { child: nested };
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-deep-clean",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			// Unsigned, not a signed block: an atomic node stops the projector's
			// pre-scan at the `details` object, so this payload instead walks
			// the whole graph through the pre-scan and both memo walks.
			details: nested,
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: every level reaches the line, leaf included.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst.match(/"child":/g)).toHaveLength(depth);
		expect(bodyAfterFirst).toContain('"leaf":"fix15222-deep-bottom"');

		// Second rewrite: byte-identical body — the stamped line still describes
		// the unchanged deep graph, so the rewrite reuses it instead of
		// churning, and the matcher's own deep walk does not overflow.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toBe(bodyAfterFirst);

		// Third rewrite after an in-place mutation at the very bottom of the
		// graph: every object identity above the leaf is unchanged, so only a
		// deep value stamp can see it — the line must be re-projected with the
		// new value instead of restoring the stale one.
		let cursor: Record<string, unknown> = nested as Record<string, unknown>;
		while (typeof cursor.child === "object" && cursor.child !== null) {
			cursor = cursor.child as Record<string, unknown>;
		}
		cursor.leaf = "fix15222-deep-mutated";
		await session.appendEntriesAtomically(() => {});
		const bodyAfterThird = storage.readTextSync(sessionFile);
		expect(bodyAfterThird).toContain('"leaf":"fix15222-deep-mutated"');
		expect(bodyAfterThird).not.toBe(bodyAfterSecond);
	}, 90_000);

	it("persists the current bytes of an image block whose classifiers ride an inherited descriptor", async () => {
		// `isImageBlock`/`isImageDataPayload` classify through the prototype
		// chain, so a content block whose `type` and `mimeType` ride inherited
		// descriptors is projector-accepted and its oversized `data` externalized
		// to a blob ref — while the own-key stamp records only `data`. Flipping
		// the inherited classifiers from `image/png` to `text/plain` turns
		// externalization off, so a fresh projection swaps the blob ref for the
		// raw base64; a stamp that cannot see the classifiers compares equal and
		// reuses the stale ref, so a reload restores the previous image.
		const backing: Record<string, unknown> = { type: "image", mimeType: "image/png" };
		const block = Object.create(backing);
		block.data = LARGE_BASE64;
		block.detail = "auto";
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "user" as const,
			content: [block],
			timestamp: Date.now(),
		});

		// First rewrite: the accepted payload is externalized to a blob ref.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		const refsAfterFirst = persistedBlobRefs(bodyAfterFirst);
		expect(refsAfterFirst).toHaveLength(1);
		const originalRef = refsAfterFirst[0];
		if (!originalRef) throw new Error("Expected blob reference");
		expect(await blobBytesBase64(originalRef)).toBe(LARGE_BASE64);
		expect(bodyAfterFirst).toContain('"detail":"auto"');
		expect(bodyAfterFirst).not.toContain(LARGE_BASE64);

		// Flip both inherited classifiers: no own key moves, so an own-key stamp
		// still matches the original line while the projector stops accepting
		// the payload and keeps its base64 inline.
		backing.type = "text";
		backing.mimeType = "text/plain";

		// Second rewrite: the persisted line carries the live base64 and the
		// ref is gone — reloading restores the block as it now stands.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(persistedBlobRefs(bodyAfterSecond)).toHaveLength(0);
		expect(bodyAfterSecond).toContain(LARGE_BASE64);
		expect(bodyAfterSecond).not.toContain(originalRef);
	});

	it("persists a jsonlEvents mutation inside a typeless anthropicCompaction carrier nested in an array", async () => {
		// The preserveData-style compaction carrier has no `type` marker of its
		// own, so `truncateForPersistence` classifies it atomic by the caller's
		// key — and its array branch hands that key to every element. A carrier
		// nested inside an array therefore persists verbatim, `jsonlEvents`
		// included. A stamp that drops the parent key at the array boundary
		// instead records the events presence-only, so a later mutation compares
		// equal and the rewrite reuses the stale JSONL line.
		const carrier: Record<string, unknown> = { content: "summary", jsonlEvents: [{ seq: 1 }] };
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-array-carrier",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: { anthropicCompaction: [carrier] },
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

	it("persists the current signature strip of an assistant turn whose payload items ride an inherited descriptor", async () => {
		// `stripReplayedReasoningSignatures` reads `providerPayload.items` by
		// key, so an items array on an inherited link reaches the projector while
		// the own-key stamp never walks it. Dropping the item turns the
		// signature-stripping decision off, so a fresh projection keeps the
		// duplicate signature; a stamp blind to the payload compares equal and
		// reuses the stripped line, losing the signature on reload.
		const reasoningItem = { type: "reasoning", id: "resp-fix15222-items", encrypted_content: "enc-fix15222-items" };
		const items: Array<Record<string, unknown>> = [reasoningItem];
		const payload = Object.create({ type: "openaiResponsesHistory", items });
		const thinkingSignature = JSON.stringify(reasoningItem);
		// The persisted line is JSON, so the signature's own quotes arrive
		// escaped: the bytes to look for are the escaped form of the text.
		const persistedSignature = JSON.stringify(thinkingSignature).slice(1, -1);
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "thinking" as const, thinking: "reason", thinkingSignature }],
			providerPayload: payload,
		});

		// First rewrite: the payload covers the signature, so the projected line
		// drops the duplicate.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).not.toContain(persistedSignature);

		// Empty the backing items: the projector no longer covers the signature,
		// so the line must keep it.
		items.length = 0;

		// Second rewrite: the persisted line carries the signature — a stamp that
		// cannot see the payload reuses the stripped line instead.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain(persistedSignature);
	});

	it("persists the current signature strip of an assistant turn whose payload items hide behind an overridden iterator", async () => {
		// The stamp reads an array's indexed slots the way `JSON.stringify`
		// does, but `stripReplayedReasoningSignatures` iterates
		// `providerPayload.items` with `for..of`. An items array whose iterator
		// yields the reasoning item later than its slots do therefore changes
		// the projected line without moving a single stamped leaf.
		const reasoningItem = { type: "reasoning", id: "resp-fix15222-iter", encrypted_content: "enc-fix15222-iter" };
		const items: Array<Record<string, unknown>> = [reasoningItem];
		items[Symbol.iterator] = function* emptyIterator(): ArrayIterator<Record<string, unknown>> {
			// Yields nothing: the reasoning item is invisible to the projector.
		};
		const payload = { type: "openaiResponsesHistory" as const, items };
		const thinkingSignature = JSON.stringify(reasoningItem);
		// The persisted line is JSON, so the signature's own quotes arrive
		// escaped: the bytes to look for are the escaped form of the text.
		const persistedSignature = JSON.stringify(thinkingSignature).slice(1, -1);
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "thinking" as const, thinking: "reason", thinkingSignature }],
			providerPayload: payload,
		});

		// First rewrite: the iterator hides the item, so the signature is kept.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain(persistedSignature);

		// Reveal the item to the iterator: the indexed slots never moved, so only
		// the projector's view of the array changed.
		items[Symbol.iterator] = function* revealingIterator(): ArrayIterator<Record<string, unknown>> {
			yield reasoningItem;
		};

		// Second rewrite: the persisted line drops the now-covered signature —
		// a slot-only stamp reuses the line that kept it.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).not.toContain(persistedSignature);
	});

	it("persists a session whose details is a proxy with a throwing descriptor trap without latching a persistence failure", async () => {
		// `projectorImageField` answers its acceptance question with
		// `Object.getOwnPropertyDescriptor` on every prototype link — a call a
		// proxy trap controls. `JSON.stringify` consults descriptors only for
		// keys `ownKeys` reported, so a proxy whose descriptor trap throws while
		// `ownKeys` stays quiet serializes as `{}`; the projector's direct
		// lookup threw instead, and that throw escaped
		// `prepareEntryForPersistence` and latched a persistence failure on
		// every rewrite.
		const details = new Proxy({} as Record<string, unknown>, {
			ownKeys: () => [],
			getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
				throw new Error("boom-fix15222-descriptor-trap");
			},
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-descriptor-trap",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// The rewrite succeeds: the proxy contributes `{}` to the line and the
		// rest of the message is persisted in full.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"details":{}');
		expect(body).toContain('"toolName":"bash"');
		expect(body).toContain('"role":"toolResult"');
	});

	it("persists a session whose providerPayload is a proxy with a throwing descriptor trap without latching a persistence failure", async () => {
		// The message-level projection-input check reaches `providerPayload`
		// and answers through `Object.getOwnPropertyDescriptor`, which the same
		// proxy trap controls. The projector itself never touches a descriptor
		// of that payload (`ownKeys` reports nothing, so both `for..in` and
		// `JSON.stringify` skip it), so a probe that lets the trap throw fails a
		// rewrite the projection completes — the read has to answer "unstampable"
		// and leave the line uncached instead.
		const payload = new Proxy({} as OpenAIResponsesHistoryPayload, {
			ownKeys: () => [],
			getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
				throw new Error("boom-fix15222-payload-trap");
			},
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "thinking" as const, thinking: "reason" }],
			providerPayload: payload,
		});

		// The rewrite succeeds: the payload contributes `{}` and the turn is
		// persisted in full, with no latched failure.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"providerPayload":{}');
		expect(body).toContain('"role":"assistant"');
		expect(body).toContain('"thinking":"reason"');
	});

	it("persists a session whose content is a proxy with a throwing descriptor trap without latching a persistence failure", async () => {
		// The same message-level check iterates `content` to compare its
		// iterator against the array default, so the throwing trap reaches it
		// through that array instead of a payload field. `Array.isArray` holds
		// for a proxy of an array and `JSON.stringify` skips the hidden keys, so
		// the projection completes — the iterator comparison has to report
		// "non-default" and leave the line uncached rather than throw.
		const content = new Proxy([] as AssistantMessage["content"], {
			ownKeys: () => [],
			getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
				throw new Error("boom-fix15222-content-trap");
			},
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content,
		});

		// The rewrite succeeds: the hidden blocks contribute `[]` and the turn
		// is persisted in full, with no latched failure.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"content":[]');
		expect(body).toContain('"role":"assistant"');
	});

	it("persists a sibling mutation after an unchanged boxed-primitive leaf in the same details object", async () => {
		// `details` is the tool result's opaque slot, so a wrapper leaf can sit
		// beside a mutable sibling. The stamp records the wrapper as its
		// unboxed value, and the matcher answered for the whole graph the
		// moment that one leaf compared equal: the sibling queued behind it
		// was never visited, so a full rewrite restored the old line and a
		// reload showed the stale sibling.
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-boxed-sibling",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: { boxed: new Number(1), status: "fix15222-boxed-before" },
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: the line carries the original sibling value.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"status":"fix15222-boxed-before"');

		// Move the sibling in place: the wrapper leaf never changes and no key
		// moves, so only the walk past the leaf sees the difference.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("Expected toolResult message entry");
		}
		const details = entry.message.details;
		if (details === null || typeof details !== "object") throw new Error("Expected object details");
		(details as Record<string, unknown>).status = "fix15222-boxed-after";

		// Second rewrite: the line carries the moved sibling, not the stale one.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"status":"fix15222-boxed-after"');
		expect(bodyAfterSecond).not.toContain('"status":"fix15222-boxed-before"');
	});

	it("persists a sibling mutation after an unchanged JSON.rawJSON leaf in the same details object", async () => {
		if (!("rawJSON" in JSON) || typeof JSON.rawJSON !== "function") {
			throw new Error("Expected JSON.rawJSON support");
		}
		// A rawJSON node is stamped as its brand, its payload, and its closing
		// marker, and the matcher returned the whole-graph verdict as soon as
		// those three compared equal — the sibling queued behind the node was
		// never visited, so its in-place change restored a stale line.
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-rawjson-sibling",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: { payload: JSON.rawJSON("1"), status: "fix15222-raw-before" },
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: the branded node serializes as its payload verbatim and
		// the line carries the original sibling value.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"payload":1');
		expect(bodyAfterFirst).toContain('"status":"fix15222-raw-before"');

		// Move the sibling in place: the rawJSON node never changes and no key
		// moves, so only the walk past the node sees the difference.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("Expected toolResult message entry");
		}
		const details = entry.message.details;
		if (details === null || typeof details !== "object") throw new Error("Expected object details");
		(details as Record<string, unknown>).status = "fix15222-raw-after";

		// Second rewrite: the line carries the moved sibling, not the stale one.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"status":"fix15222-raw-after"');
		expect(bodyAfterSecond).not.toContain('"status":"fix15222-raw-before"');
	});

	it("persists the current signature strip of an assistant turn whose content overrides its own some", async () => {
		// `stripReplayedReasoningSignatures` gates the strip on
		// `message.content.some(...)`, which reads the blocks through the
		// method, not through the iterator the cacheability guard watches —
		// and `JSON.stringify` and the stamp both ignore non-index array
		// properties, so the override moves the projected strip without moving
		// a single stamped leaf. A matcher that cannot see the method reuses
		// the line an earlier strip decision produced, and the signature a
		// later projection would keep is lost on reload.
		const reasoningItem = { type: "reasoning", id: "resp-fix15222-some", encrypted_content: "enc-fix15222-some" };
		const content: AssistantMessage["content"] = [
			{ type: "thinking" as const, thinking: "reason", thinkingSignature: JSON.stringify(reasoningItem) },
		];
		const payload = { type: "openaiResponsesHistory" as const, items: [reasoningItem] };
		const thinkingSignature = JSON.stringify(reasoningItem);
		// The persisted line is JSON, so the signature's own quotes arrive
		// escaped: the bytes to look for are the escaped form of the text.
		const persistedSignature = JSON.stringify(thinkingSignature).slice(1, -1);
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content,
			providerPayload: payload,
		});

		// First rewrite: the gate sees the signed block and the payload covers
		// it, so the projected line drops the duplicate signature.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).not.toContain(persistedSignature);

		// Give the array its own `some` in place: no indexed slot moves and no
		// key changes, so the stamp still describes the array — but the strip
		// gate now sees nothing and the projector keeps the signature.
		Object.defineProperty(content, "some", {
			enumerable: false,
			configurable: true,
			writable: true,
			value: (): boolean => false,
		});

		// Second rewrite: the persisted line carries the signature.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain(persistedSignature);
	});

	it("persists the current signature strip of an assistant turn whose content overrides its own map", async () => {
		// The strip itself is computed with `message.content.map(...)`, which
		// reads the blocks through that method — again invisible to the
		// iterator guard, to `JSON.stringify`, and to the stamp. An array whose
		// `map` rebuilds the blocks unchanged changes the projected line
		// without moving a stamped leaf, so a reused line restores the earlier
		// strip decision.
		const reasoningItem = { type: "reasoning", id: "resp-fix15222-map", encrypted_content: "enc-fix15222-map" };
		const content: AssistantMessage["content"] = [
			{ type: "thinking" as const, thinking: "reason", thinkingSignature: JSON.stringify(reasoningItem) },
		];
		const payload = { type: "openaiResponsesHistory" as const, items: [reasoningItem] };
		const thinkingSignature = JSON.stringify(reasoningItem);
		// The persisted line is JSON, so the signature's own quotes arrive
		// escaped: the bytes to look for are the escaped form of the text.
		const persistedSignature = JSON.stringify(thinkingSignature).slice(1, -1);
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content,
			providerPayload: payload,
		});

		// First rewrite: the default `map` runs the strip and the line drops
		// the duplicate signature.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).not.toContain(persistedSignature);

		// Give the array its own `map` in place: the slots it reads are the
		// ones the stamp recorded, but the strip never runs.
		Object.defineProperty(content, "map", {
			enumerable: false,
			configurable: true,
			writable: true,
			value: (): AssistantMessage["content"] => content.slice(),
		});

		// Second rewrite: the persisted line carries the signature.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain(persistedSignature);
	});

	it("persists a session whose details is a proxy with a throwing getPrototypeOf trap without latching a persistence failure", async () => {
		// The image-classifier lookup answers through a prototype-chain walk,
		// and `Object.getPrototypeOf` is the one step a proxy trap controls: a
		// proxy whose descriptor answers stay quiet — `JSON.stringify`
		// serializes it as `{}` — can still throw on the prototype step. That
		// throw escaped `prepareEntryForPersistence` and latched a persistence
		// failure on a write the projection completes.
		const details = new Proxy({} as Record<string, unknown>, {
			getPrototypeOf(): object | null {
				throw new Error("boom-fix15222-proto-trap");
			},
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-proto-trap",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// The rewrite succeeds: the proxy contributes `{}` to the line and the
		// rest of the message is persisted in full.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"details":{}');
		expect(body).toContain('"toolName":"bash"');
		expect(body).toContain('"role":"toolResult"');
	});

	it("persists a session whose providerPayload is a proxy with a throwing getPrototypeOf trap without latching a persistence failure", async () => {
		// The message-level projection-input check walks `providerPayload`'s
		// prototype chain looking for the Responses fields by key, so the
		// throwing prototype trap reaches it through that payload. The
		// projector never touches a descriptor or the prototype of the payload
		// (`ownKeys` reports nothing, so both `for..in` and `JSON.stringify`
		// skip it) and the write completes — the walk has to report the field
		// hidden and leave the line uncached rather than throw.
		const payload = new Proxy({} as OpenAIResponsesHistoryPayload, {
			getPrototypeOf(): object | null {
				throw new Error("boom-fix15222-payload-proto-trap");
			},
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "thinking" as const, thinking: "reason" }],
			providerPayload: payload,
		});

		// The rewrite succeeds: the payload contributes `{}` and the turn is
		// persisted in full, with no latched failure.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"providerPayload":{}');
		expect(body).toContain('"role":"assistant"');
		expect(body).toContain('"thinking":"reason"');
	});

	it("persists a session whose content is a proxy with a throwing getPrototypeOf trap without latching a persistence failure", async () => {
		// The same message-level check compares `content`'s iterator against
		// the array default by walking the prototype chain, so the throwing
		// trap reaches it through that array. `Array.isArray` holds for a proxy
		// of an array and `JSON.stringify` writes it as `[]`, so the
		// comparison has to report "non-default" — leaving the line uncached —
		// rather than throw.
		const content = new Proxy([] as AssistantMessage["content"], {
			getPrototypeOf(): object | null {
				throw new Error("boom-fix15222-content-proto-trap");
			},
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content,
		});

		// The rewrite succeeds: the hidden blocks contribute `[]` and the turn
		// is persisted in full, with no latched failure.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"content":[]');
		expect(body).toContain('"role":"assistant"');
	});

	it("surfaces a serialization error for an unstripped back-reference instead of hanging the write", async () => {
		// `jsonlEvents` and the spilled `structuredContent` are stripped before
		// serialization, so their cycles never reach the projector. An ordinary
		// back-reference under `details` is NOT stripped: `JSON.stringify`
		// rejects the graph, which the write surfaces as a persistence failure.
		// The memo's walks must not re-enqueue the same object forever on the
		// way there — an earlier revision spun the event loop instead.
		const details: Record<string, unknown> = { status: "old" };
		details.self = details;
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-unstripped-cycle",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		await expect(session.appendEntriesAtomically(() => {})).rejects.toThrow(/cyclic/i);
	}, 8_000);

	it("surfaces a serialization error for a cycle that appears after the line was cached", async () => {
		// The same back-reference, but it appears after the memo already holds
		// the line. The matcher walks the stamp, which is bounded, so the cyclic
		// graph fails the match instead of looping on it — and the projection
		// then surfaces the serialization error rather than the write hanging.
		const details: Record<string, unknown> = { status: "old" };
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-cached-cycle",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		// First rewrite: the acyclic details are persisted and the line is cached.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).toContain('"status":"old"');

		// The details now reference themselves.
		details.self = details;

		// Second rewrite: the cached line cannot be reused, and the projection
		// surfaces the serialization error.
		await expect(session.appendEntriesAtomically(() => {})).rejects.toThrow(/cyclic/i);
	}, 8_000);

	it("leaves a function-valued detail with a toJSON hook uncached", async () => {
		// `JSON.stringify` invokes a `toJSON` on a callable value, so a function
		// detail whose hook changes must not reuse a line stamped from an
		// earlier call's output.
		let revision = 0;
		const hookable = () => "never-called";
		(hookable as unknown as Record<string, unknown>).toJSON = () => `fn-rev-${++revision}`;
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-fn-hook",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: { hookable },
			isError: false,
			timestamp: Date.now(),
		});

		// One atomic publish serializes the body twice (materialize, then
		// commit), so the hook has run twice by the time the line lands.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).toContain('"hookable":"fn-rev-2"');

		// A second rewrite re-serializes the hook: a reused line would still
		// carry the first call's output.
		await session.appendEntriesAtomically(() => {});
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"hookable":"fn-rev-3"');
		expect(body).not.toContain('"hookable":"fn-rev-2"');
	});

	it("leaves a boxed detail with a custom coercion override uncached", async () => {
		// A box serializes through `ToPrimitive`, so an own `valueOf` override
		// changes the emitted number while the intrinsic brand check (which must
		// not run user code) still reports the boxed value.
		const boxed = new Number(1) as Number & { valueOf(): number };
		boxed.valueOf = () => 41;
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-boxed-coercion",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: boxed,
			isError: false,
			timestamp: Date.now(),
		});

		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).toContain('"details":41');

		// Change the coercion in place: a reused line would still say 41.
		boxed.valueOf = () => 42;
		await session.appendEntriesAtomically(() => {});
		const body = storage.readTextSync(sessionFile);
		expect(body).toContain('"details":42');
		expect(body).not.toContain('"details":41');
	});

	it("leaves an assistant turn whose role rides a hidden descriptor uncached", async () => {
		// `stripReplayedReasoningSignatures` gates on `message.role`, read by key
		// through the prototype chain, while the stamp records own enumerable
		// keys only. A hidden `role` can therefore flip whether the projection
		// strips a `thinkingSignature` without moving a stamped leaf.
		const reasoningItem = { type: "reasoning", id: "resp-fix15222-role", encrypted_content: "enc-fix15222-role" };
		const content: AssistantMessage["content"] = [
			{ type: "thinking" as const, thinking: "reason", thinkingSignature: JSON.stringify(reasoningItem) },
		];
		const payload = { type: "openaiResponsesHistory" as const, items: [reasoningItem] };
		const persistedSignature = JSON.stringify(JSON.stringify(reasoningItem)).slice(1, -1);
		const message = { ...makeAssistantMessage(), content, providerPayload: payload };
		// The role sits on a non-enumerable own descriptor, so the projector's
		// by-key read sees it while the stamp's own-enumerable walk does not.
		Object.defineProperty(message, "role", {
			value: "assistant",
			enumerable: false,
			configurable: true,
			writable: true,
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage(message);

		// First rewrite: the strip applies, so the line has no signature.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).not.toContain(persistedSignature);

		// Flip the hidden role in place: the strip no longer applies, so the
		// signature must come back. A reused line would still omit it.
		Object.defineProperty(message, "role", {
			value: "user",
			enumerable: false,
			configurable: true,
			writable: true,
		});
		await session.appendEntriesAtomically(() => {});
		expect(storage.readTextSync(sessionFile)).toContain(persistedSignature);
	});

	it("does not walk a cyclic structuredContent the projection strips through inherited MCP markers", async () => {
		// The MCP spill strip reads its marker fields by key, so it follows the
		// prototype chain: markers a prototype carries strip `structuredContent`
		// exactly like own ones. The memo's mirror has to reach the same verdict
		// — when it does not, it walks the live cycle the line never contains,
		// and the rewrite never returns.
		const structuredContent: Record<string, unknown> = { kind: "payload" };
		structuredContent.self = structuredContent;
		const details = Object.create({
			serverName: "mcp",
			mcpToolName: "search",
			meta: { truncation: { artifactId: "artifact-fix15222" } },
		}) as Record<string, unknown>;
		details.structuredContent = structuredContent;

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-mcp",
			toolName: "search",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});

		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		// The stripped field is gone, so the cycle never reaches the line.
		expect(body).not.toContain("structuredContent");
	});

	it("terminates the projection for a proxy whose prototype chain is its own", async () => {
		// A proxy may fabricate its own ancestors: `getPrototypeOf` answers the
		// proxy itself, so a prototype walk that follows the chain never ends.
		// The target carries no `data`, so the image-classifier walk has to step
		// up the chain to look for it.
		const looping: Record<string, unknown> = new Proxy(
			{ type: "text", text: "hi" },
			{ getPrototypeOf: () => looping },
		);

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "user" as const,
			content: [looping as unknown as { type: "text"; text: string }],
			timestamp: Date.now(),
		});

		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).toContain('"type":"text"');
	});

	it("externalizes an own enumerable accessor-backed image payload instead of truncating it", async () => {
		// An own enumerable `data` getter is part of the serialized graph —
		// `JSON.stringify` reads it — so the projector may read it too, and must
		// externalize the bytes instead of leaving a truncated copy inline: a
		// resumed session would replay a broken image.
		const payload = "A".repeat(600_000);
		let calls = 0;
		const block = {
			type: "image" as const,
			mimeType: "image/png",
			get data(): string {
				calls++;
				return payload;
			},
		};

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({ role: "user" as const, content: [block], timestamp: Date.now() });
		await session.appendEntriesAtomically(() => {});

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		const refs = persistedBlobRefs(body);
		expect(refs).toHaveLength(1);
		const ref = refs[0];
		if (!ref) throw new Error("Expected blob reference");
		// The blob holds the whole payload: the line carries no truncated copy.
		expect(await blobBytesBase64(ref)).toBe(payload);
		expect(body).not.toContain("Session persistence truncated large content");
		expect(calls).toBeGreaterThan(0);
	});

	it("re-projects a message when a replaced Number.prototype.valueOf hides a nested change", async () => {
		// The boxed-primitive brand check must not read `Number.prototype.valueOf`
		// at call time: a replacement would be called for every object the probe
		// walks, and its answer would be stamped as the object's value — hiding
		// every change beneath it.
		const originalValueOf = Number.prototype.valueOf;
		Number.prototype.valueOf = function replacementValueOf(): number {
			return 42;
		};
		try {
			const details = { nested: { count: 1 } };
			const session = SessionManager.create(process.cwd(), sessionDir, storage);
			session.appendMessage({
				role: "toolResult" as const,
				toolCallId: "call-fix15222-valueof",
				toolName: "bash",
				content: [{ type: "text" as const, text: "ok" }],
				details,
				isError: false,
				timestamp: Date.now(),
			});
			await session.appendEntriesAtomically(() => {});

			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file");
			expect(storage.readTextSync(sessionFile)).toContain('"count":1');

			details.nested.count = 2;
			await session.appendEntriesAtomically(() => {});
			expect(storage.readTextSync(sessionFile)).toContain('"count":2');
		} finally {
			Number.prototype.valueOf = originalValueOf;
		}
	});

	it("does not read a transient key's value while projecting the message", async () => {
		// `jsonlEvents` never reaches the line, so reading it would run a getter
		// the persisted bytes do not depend on — and a stateful one would shift
		// the sibling fields the line does record.
		let calls = 0;
		const details = {
			kept: "value",
			get jsonlEvents(): unknown[] {
				calls++;
				return [{ type: "stream" }];
			},
		};

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-transient",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});
		await session.appendEntriesAtomically(() => {});

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).not.toContain("jsonlEvents");
		expect(calls).toBe(0);
	});

	it("keeps a prototype whose descriptor trap throws out of the persistence failure path", async () => {
		// The serializer hook probe walks the prototype chain, and a proxy in
		// that chain can throw from its descriptor trap. The probe answers
		// "unknown" there; an exception escaping it fails a write the
		// serializer itself completes.
		const hostile = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					throw new Error("descriptor trap");
				},
			},
		);
		const nested = Object.create(hostile) as Record<string, unknown>;
		nested.kept = "value";

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "toolResult" as const,
			toolCallId: "call-fix15222-prototype",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			details: nested,
			isError: false,
			timestamp: Date.now(),
		});
		await session.appendEntriesAtomically(() => {});

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).toContain('"kept":"value"');
	});

	it("persists the truncated text of a block whose hidden signature stops signing it", async () => {
		// The atomic classification reads the block's `textSignature` by key, so
		// a hidden one still signs the block — and the projector then keeps its
		// long text verbatim. The stamp enumerates own enumerable keys, so it
		// never sees the hidden field: the atomic verdict flips while the stamp
		// compares equal, and the memo reuses the line that kept the
		// untruncated text.
		const longText = "x".repeat(500_001);
		const block: Record<string, unknown> = { type: "text", text: longText };
		Object.defineProperty(block, "textSignature", {
			value: "sig-hidden-fix15222",
			enumerable: false,
			writable: true,
			configurable: true,
		});

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [block] as unknown as AssistantMessage["content"],
		});

		// First rewrite: the block is signed, so the long text is preserved.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain(longText);

		// The signature stops signing the block: the projector truncates the
		// long text now, while a stamp blind to the hidden field still matches.
		block.textSignature = "";

		// Second rewrite: the persisted line carries the truncated text.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).not.toContain(longText);
		expect(bodyAfterSecond).toContain("Session persistence truncated large content");
	});

	it("never consumes a stateful signature getter while probing the message", async () => {
		// `isAtomicPersistenceNode` reads the block's `textSignature` by key, so
		// a stateful getter would be consumed by the memo's probe — and the
		// projection would then read a different value than the probe saw. The
		// probe must answer through the property descriptor, never by reading the
		// key.
		let reads = 0;
		const block: Record<string, unknown> = { type: "text", text: "kept" };
		Object.defineProperty(block, "textSignature", {
			get(): string {
				reads += 1;
				return "sig-stateful-fix15222";
			},
			enumerable: true,
			configurable: true,
		});

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [block] as unknown as AssistantMessage["content"],
		});

		// One atomic publish performs two full-body serializations (materialize,
		// then commit), and each one reads the carrier twice — once in the
		// projector's own scan, once in the serializer. A probe that reads the
		// carrier adds a read per serialization.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(reads).toBe(4);
		expect(storage.readTextSync(sessionFile)).toContain("sig-stateful-fix15222");
	});

	it("persists the current signature strip of an assistant turn whose reasoning item hides its encrypted content", async () => {
		// `readReasoningItem` reads the item's `encrypted_content` by key, so a
		// hidden one still covers the signature — while the stamp, which walks
		// own enumerable keys only, never sees it. Dropping the hidden field
		// turns the strip off without moving a stamped leaf.
		const reasoningItem: Record<string, unknown> = { type: "reasoning", id: "resp-fix15222-hidden-enc" };
		Object.defineProperty(reasoningItem, "encrypted_content", {
			value: "enc-fix15222-hidden",
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const items = [reasoningItem];
		const payload = { type: "openaiResponsesHistory" as const, items };
		// The signature carries only the encrypted content, so the item's `id`
		// cannot cover it once the hidden field is gone.
		const thinkingSignature = JSON.stringify({ type: "reasoning", encrypted_content: "enc-fix15222-hidden" });
		const persistedSignature = JSON.stringify(thinkingSignature).slice(1, -1);

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "thinking" as const, thinking: "reason", thinkingSignature }],
			providerPayload: payload,
		});

		// First rewrite: the payload covers the signature, so the line drops it.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).not.toContain(persistedSignature);

		// The hidden encrypted content is gone: the payload no longer covers the
		// signature, so the line must keep it.
		delete reasoningItem.encrypted_content;
		await session.appendEntriesAtomically(() => {});
		expect(storage.readTextSync(sessionFile)).toContain(persistedSignature);
	});

	it("persists the current signature strip of an assistant turn whose reasoning item hides its id", async () => {
		// The same hole on the fallback carrier: `readReasoningItem` reads the
		// item's `id` by key, so a hidden one still matches the signature while
		// the stamp never sees it.
		const reasoningItem: Record<string, unknown> = { type: "reasoning", encrypted_content: "enc-fix15222-hidden-id" };
		Object.defineProperty(reasoningItem, "id", {
			value: "resp-fix15222-hidden-id",
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const items = [reasoningItem];
		const payload = { type: "openaiResponsesHistory" as const, items };
		const thinkingSignature = JSON.stringify({ type: "reasoning", id: "resp-fix15222-hidden-id" });
		const persistedSignature = JSON.stringify(thinkingSignature).slice(1, -1);

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "thinking" as const, thinking: "reason", thinkingSignature }],
			providerPayload: payload,
		});

		// First rewrite: the payload covers the signature, so the line drops it.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).not.toContain(persistedSignature);

		// The hidden id is gone: the payload no longer covers the signature, so
		// the line must keep it.
		delete reasoningItem.id;
		await session.appendEntriesAtomically(() => {});
		expect(storage.readTextSync(sessionFile)).toContain(persistedSignature);
	});

	it("persists the current value of a snapcompact archive's own field", async () => {
		// The snapcompact archive is rebuilt by `persistSnapcompactArchive`,
		// which keeps every field but its frames verbatim — including a field
		// the generic path strips — and reads the frames by key. The stamp
		// records the archive whole, so a transient-named field inside it is
		// recorded by value rather than by presence: a change behind it must
		// reach the line.
		const archive: Record<string, unknown> = {
			frames: [],
			jsonlEvents: [{ seq: 1 }],
			marker: "fix15222-snapcompact",
		};
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "text" as const, text: "ok" }],
			preserveData: { snapcompact: archive },
		} as unknown as AssistantMessage);

		// First rewrite: the archive's own field reaches the line.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain('"seq":1');

		// The archive's own field changes in place: the persisted line must
		// follow it.
		archive.jsonlEvents = [{ seq: 2 }];
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain('"seq":2');
		expect(bodyAfterSecond).not.toContain('"seq":1');
	});

	it("persists the current bytes of a snapcompact archive's frames", async () => {
		// The archive's frames are externalized to the blob store, so the
		// persisted line carries a ref whose bytes are the frames' payload. The
		// stamp records the frames, so a payload changed in place mints a new
		// ref and a reload restores the current frames.
		const frames = [{ data: LARGE_BASE64, mimeType: "image/png" }];
		const archive: Record<string, unknown> = { frames, marker: "fix15222-archive-frames" };
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "text" as const, text: "ok" }],
			preserveData: { snapcompact: archive },
		} as unknown as AssistantMessage);

		// First rewrite: the frames are externalized into the blob store.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const refsAfterFirst = persistedBlobRefs(storage.readTextSync(sessionFile));
		expect(refsAfterFirst).toHaveLength(1);
		const originalRef = refsAfterFirst[0];
		if (!originalRef) throw new Error("Expected blob reference");
		expect(await blobBytesBase64(originalRef)).toBe(LARGE_BASE64);

		// The frames' payload changes in place: the persisted line must carry a
		// new ref, and a reload must restore the new bytes.
		frames[0].data = "B".repeat(2048);
		await session.appendEntriesAtomically(() => {});
		const refsAfterSecond = persistedBlobRefs(storage.readTextSync(sessionFile));
		expect(refsAfterSecond).toHaveLength(1);
		const mutatedRef = refsAfterSecond[0];
		if (!mutatedRef) throw new Error("Expected blob reference");
		expect(mutatedRef).not.toBe(originalRef);
		expect(await blobBytesBase64(mutatedRef)).toBe("B".repeat(2048));
	});

	it("persists the current bytes of a snapcompact archive whose frames hide behind a hidden field", async () => {
		// The archive rebuild reads the frames by key, so a frames field that is
		// an own non-enumerable data property still decides the persisted bytes
		// — while the own-key stamp never sees it. Such an archive must stay
		// uncached, so the line is always re-projected from the live archive.
		const frames = [{ data: LARGE_BASE64, mimeType: "image/png" }];
		const archive: Record<string, unknown> = { marker: "fix15222-hidden-frames" };
		Object.defineProperty(archive, "frames", {
			value: frames,
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "text" as const, text: "ok" }],
			preserveData: { snapcompact: archive },
		} as unknown as AssistantMessage);

		// First rewrite: the hidden frames are externalized into the blob store.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const refsAfterFirst = persistedBlobRefs(storage.readTextSync(sessionFile));
		expect(refsAfterFirst).toHaveLength(1);
		const originalRef = refsAfterFirst[0];
		if (!originalRef) throw new Error("Expected blob reference");

		// The hidden frames' payload changes in place: the persisted line must
		// carry a new ref — a stamp that cannot see the frames would compare
		// equal and reuse the line the change invalidated.
		frames[0].data = "B".repeat(2048);
		await session.appendEntriesAtomically(() => {});
		const refsAfterSecond = persistedBlobRefs(storage.readTextSync(sessionFile));
		expect(refsAfterSecond).toHaveLength(1);
		const mutatedRef = refsAfterSecond[0];
		if (!mutatedRef) throw new Error("Expected blob reference");
		expect(mutatedRef).not.toBe(originalRef);
		expect(await blobBytesBase64(mutatedRef)).toBe("B".repeat(2048));
	});

	it("persists the current output of an entry-level serializer hook", async () => {
		// The cacheability gate probed the message, not the entry wrapper — so an
		// entry-level `toJSON` went undetected, and the memo reused the line
		// the previous hook call produced.
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "user" as const,
			content: [{ type: "text" as const, text: "ok" }],
			timestamp: Date.now(),
		});
		const entry = session.getEntries().find(e => e.type === "message");
		if (!entry) throw new Error("Expected message entry");
		let output = "hook-first-fix15222";
		Object.defineProperty(entry, "toJSON", {
			value: () => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text: output }] } }),
			enumerable: false,
			configurable: true,
		});

		// First rewrite: the persisted line is the hook's output.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).toContain("hook-first-fix15222");

		// The hook now returns something else: the persisted line must follow.
		output = "hook-second-fix15222";
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).toContain("hook-second-fix15222");
		expect(bodyAfterSecond).not.toContain("hook-first-fix15222");
	});

	it("persists the current shape of a content array that carries its own signature", async () => {
		// The projector reads an array's own fields by key — the atomic
		// classification among them — while the stamp records an array's indexed
		// slots only. The array's own signature therefore decides whether its
		// payload is persisted verbatim, without moving a stamped leaf.
		const content: unknown[] = [{ type: "image", data: LARGE_BASE64, mimeType: "image/png" }];
		Object.defineProperty(content, "type", {
			value: "thinking",
			enumerable: true,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(content, "thinkingSignature", {
			value: "sig-array-fix15222",
			enumerable: true,
			writable: true,
			configurable: true,
		});

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "user" as const,
			content: content as unknown as UserMessage["content"],
			timestamp: Date.now(),
		});

		// First rewrite: the array is signed, so it persists verbatim and its
		// payload is not externalized.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const bodyAfterFirst = storage.readTextSync(sessionFile);
		expect(bodyAfterFirst).toContain(LARGE_BASE64);
		expect(persistedBlobRefs(bodyAfterFirst)).toHaveLength(0);

		// The signature stops signing the array: the projector now rebuilds it,
		// and its payload is externalized.
		Object.defineProperty(content, "thinkingSignature", {
			value: "",
			enumerable: true,
			writable: true,
			configurable: true,
		});
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(persistedBlobRefs(bodyAfterSecond)).toHaveLength(1);
		expect(bodyAfterSecond).not.toContain(LARGE_BASE64);
	});

	it("persists the shape a replaced array species produces", async () => {
		// `Array.prototype.map` builds its result through `ArraySpeciesCreate`,
		// which reads `constructor[Symbol.species]` — so a replaced constructor
		// changes the shape of the array the projection produces, while the
		// stamp keeps recording the source array's indexed slots.
		const reasoningItem = { type: "reasoning", encrypted_content: "enc-fix15222-species" };
		const items = [reasoningItem];
		const payload = { type: "openaiResponsesHistory" as const, items };
		const thinkingSignature = JSON.stringify(reasoningItem);

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "thinking" as const, thinking: "reason", thinkingSignature }],
			providerPayload: payload,
		});

		// First rewrite: the strip rebuilds the content array.
		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(storage.readTextSync(sessionFile)).toContain('"content":[');

		// Replace the array's species: the rebuilt content is no longer an
		// array, so the projected line changes shape.
		const entry = session.getEntries().find(e => e.type === "message");
		if (!entry || entry.type !== "message") throw new Error("Expected message entry");
		if (entry.message.role !== "assistant") throw new Error("Expected assistant message");
		const content = entry.message.content;
		if (!Array.isArray(content)) throw new Error("Expected array content");
		function SpeciesArray(this: unknown, length: number): { length: number } {
			return { length };
		}
		Object.defineProperty(content, "constructor", {
			value: { [Symbol.species]: SpeciesArray },
			enumerable: false,
			writable: true,
			configurable: true,
		});

		// Second rewrite: the persisted line follows the new shape.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterSecond = storage.readTextSync(sessionFile);
		expect(bodyAfterSecond).not.toContain('"content":[');
		expect(bodyAfterSecond).toContain('"content":{"0":');
	});

	it("externalizes a content image whose type is an accessor", async () => {
		// An own enumerable `type` getter may yield `"image"`, and the projector
		// cannot know without running it. Treating the block as a generic
		// payload truncates its base64, and the resumed session then carries an
		// undecodable image.
		const base64 = "A".repeat(500_004);
		const block: Record<string, unknown> = { data: base64, mimeType: "image/png" };
		Object.defineProperty(block, "type", {
			get: () => "image",
			enumerable: true,
			configurable: true,
		});

		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage({
			role: "user" as const,
			content: [block] as unknown as UserMessage["content"],
			timestamp: Date.now(),
		});

		await session.appendEntriesAtomically(() => {});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const body = storage.readTextSync(sessionFile);
		const refs = persistedBlobRefs(body);
		expect(refs).toHaveLength(1);
		const ref = refs[0];
		if (!ref) throw new Error("Expected blob reference");
		expect(await blobBytesBase64(ref)).toBe(base64);
		expect(body).not.toContain("Session persistence truncated large content");
	});
});
