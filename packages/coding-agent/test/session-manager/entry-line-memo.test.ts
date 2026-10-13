import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from "bun:test";
import * as path from "node:path";
import { TempDir, __resetDirsFromEnvForTests, getBlobsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import * as sessionPersistence from "@oh-my-pi/pi-coding-agent/session/session-persistence";
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
	let prepareSpy: Mock<typeof sessionPersistence.prepareEntryForPersistence>;
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
		prepareSpy = spyOn(sessionPersistence, "prepareEntryForPersistence");
		writeSpy = spyOn(MemorySessionStorage.prototype, "writeTextAtomic");
	});

	afterEach(() => {
		prepareSpy.mockRestore();
		writeSpy.mockRestore();
		restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
		restoreEnv("OMP_PROFILE", originalOmpProfile);
		restoreEnv("PI_PROFILE", originalPiProfile);
		__resetDirsFromEnvForTests();
		for (const dir of tempDirs) dir.removeSync();
		tempDirs = [];
	});

	it("reuses a memoized line when the entry is unchanged, and re-projects when a nested image payload is mutated in place", async () => {
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage(makeUserMessageWithImage());

		// First rewrite: memo miss — header + entry are projected.
		await session.appendEntriesAtomically(() => {});
		const afterFirst = prepareSpy.mock.calls.length;
		expect(afterFirst).toBeGreaterThan(0);

		// The first rewrite externalized the oversized image into the blob store the
		// session resolved from the agent dir. That store must be this test's temp
		// root: without the redirect above it is the developer's real blob
		// directory, which the temp-dir cleanup below never reaches.
		expect(getBlobsDir()).toBe(path.join(sessionDir, "agent", "blobs"));

		// Second rewrite with no changes: memo hit — only the header is re-projected.
		await session.appendEntriesAtomically(() => {});
		expect(prepareSpy.mock.calls.length - afterFirst).toBe(1);

		// Mutate the nested image payload in place: same content array, same block object,
		// only the base64 leaf changes. Identity checks at any depth still compare equal.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "user")
			throw new Error("Expected user message entry");
		const content = entry.message.content;
		if (!Array.isArray(content)) throw new Error("Expected array content");
		const imageBlock = content[0];
		if (typeof imageBlock === "string" || imageBlock.type !== "image") throw new Error("Expected image block");
		imageBlock.data = "B".repeat(2048);

		// Third rewrite: the value stamp must miss on the changed leaf, re-projecting the line.
		await session.appendEntriesAtomically(() => {});
		expect(prepareSpy.mock.calls.length - afterFirst).toBe(3);
	});

	it("clears the memo after a disk failure so the recovery rewrite re-projects every entry", async () => {
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		session.appendMessage(makeUserMessageWithImage());

		// First rewrite: succeeds, memo is populated.
		await session.appendEntriesAtomically(() => {});
		const afterFirst = prepareSpy.mock.calls.length;
		expect(afterFirst).toBeGreaterThan(0);

		// Second rewrite: storage rejects the write. The failure handler's recovery
		// rewrite must re-project the entry — the memo was cleared by the failure.
		writeSpy.mockImplementationOnce(async () => {
			throw new Error("disk full");
		});
		await expect(session.appendEntriesAtomically(() => {})).rejects.toThrow("disk full");
		expect(prepareSpy.mock.calls.length - afterFirst).toBe(3);

		// Third rewrite: recovery — the memo was repopulated by the failure handler's
		// rewrite, so this batch is a memo hit (header only).
		await session.appendEntriesAtomically(() => {});
		expect(prepareSpy.mock.calls.length - afterFirst).toBe(4);
	});

	it("does not cache non-message entries", async () => {
		const session = SessionManager.create(process.cwd(), sessionDir, storage);

		// Append a non-message entry (model change).
		const entryId = session.appendModelChange("claude-sonnet-4-5");

		// First rewrite: serializes the header + model change entry.
		await session.appendEntriesAtomically(() => {});
		const baseline = prepareSpy.mock.calls.length;
		expect(baseline).toBeGreaterThan(0);

		// Mutate the entry in place.
		const entry = session.getEntries().find(e => e.id === entryId);
		if (!entry || entry.type !== "model_change") throw new Error("Expected model_change entry");
		entry.model = "gpt-5-mini";

		// Second rewrite: non-message entries are never cached, so both the header
		// and the mutated entry are re-projected.
		await session.appendEntriesAtomically(() => {});
		expect(prepareSpy.mock.calls.length - baseline).toBe(2);
		const secondWrite = writeSpy.mock.calls.at(-1)?.[1] as string | undefined;
		expect(secondWrite).toBeDefined();
		expect(secondWrite).toContain("gpt-5-mini");
		expect(secondWrite).not.toContain("claude-sonnet-4-5");
	});

	it("re-projects a message whose boxed-primitive detail changed value in place", async () => {
		const session = SessionManager.create(process.cwd(), sessionDir, storage);
		const messageId = session.appendMessage(makeToolResultWithBoxedDetails());

		// First rewrite: memo miss — header + entry are projected.
		await session.appendEntriesAtomically(() => {});
		const afterFirst = prepareSpy.mock.calls.length;
		expect(afterFirst).toBeGreaterThan(0);

		// Swap the boxed value in place: a `Number` wrapper has no enumerable own
		// keys and no `toJSON`, so a stamp taken from its container shape treats
		// `new Number(1)` and `new Number(2)` as the same empty object — while
		// `stringifyJson` projects `1` and then `2` into the line.
		const entry = session.getEntries().find(e => e.id === messageId);
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("Expected toolResult message entry");
		}
		entry.message.details = new Number(2);

		// Second rewrite: the stamp must compare unboxed values, so the entry's line
		// is re-projected and the persisted body carries `2`, not the stale `1`.
		await session.appendEntriesAtomically(() => {});
		expect(prepareSpy.mock.calls.length - afterFirst).toBe(2);
		const secondWrite = writeSpy.mock.calls.at(-1)?.[1] as string | undefined;
		expect(secondWrite).toBeDefined();
		expect(secondWrite).toContain('"details":2');
		expect(secondWrite).not.toContain('"details":1');
	});
});
