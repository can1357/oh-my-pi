import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import * as fs from "node:fs";
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
function blobBytesBase64(ref: string): string {
	const hash = parseBlobRef(ref);
	if (!hash) throw new Error(`Expected blob reference, got ${ref}`);
	return fs.readFileSync(path.join(getBlobsDir(), hash)).toString("base64");
}

function removeBlob(ref: string): void {
	const hash = parseBlobRef(ref);
	if (!hash) throw new Error(`Expected blob reference, got ${ref}`);
	fs.rmSync(path.join(getBlobsDir(), hash), { force: true });
	fs.rmSync(path.join(getBlobsDir(), `${hash}.png`), { force: true });
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
		expect(blobBytesBase64(originalRef)).toBe(LARGE_BASE64);
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
		expect(blobBytesBase64(mutatedRef)).toBe(mutatedBase64);
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
		expect(blobBytesBase64(originalRef)).toBe(LARGE_BASE64);

		// Second rewrite: storage rejects the write. The line that failed to land
		// leaves its blob unreferenced, so `omp gc` may collect it before the
		// recovery rewrite runs — remove it while the write is still in flight so
		// the recovery must re-mint the bytes rather than re-publish a ref whose
		// blob no longer exists.
		writeSpy.mockImplementationOnce(async () => {
			for (const ref of persistedBlobRefs(storage.readTextSync(sessionFile))) removeBlob(ref);
			throw new Error("disk full");
		});
		await expect(session.appendEntriesAtomically(() => {})).rejects.toThrow("disk full");

		// Recovery: the persisted body still references the same content-addressed
		// ref, and the blob bytes are back on disk holding the original image.
		await session.appendEntriesAtomically(() => {});
		const bodyAfterRecovery = storage.readTextSync(sessionFile);
		expect(persistedBlobRefs(bodyAfterRecovery)).toEqual([originalRef]);
		expect(blobBytesBase64(originalRef)).toBe(LARGE_BASE64);
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
});
