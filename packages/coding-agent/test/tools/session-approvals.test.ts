import { afterEach, describe, expect, it } from "bun:test";
import {
	addFileApprovals,
	addSimilarApproval,
	approvalIdentity,
	approvalSubject,
	approveToolForSession,
	clearSessionApprovals,
	getFileApprovals,
	getSimilarApprovals,
	hasSessionApprovalGrants,
	isFileApprovedForSession,
	isSessionGrantExcluded,
	isToolApprovedForSession,
	normalizeApprovalPath,
} from "@oh-my-pi/pi-coding-agent/tools/session-approvals";

/** Absolute cwd every path in this file resolves against; grant keys are absolute. */
const REPO = "/repo";

// The store is module-level and shared across the suite; each test gets fresh
// session ids and every id is released afterwards so later files see a clean map.
let idCounter = 0;
const usedSessionIds: string[] = [];

function newSessionId(): string {
	const id = `session-approvals-test-${++idCounter}`;
	usedSessionIds.push(id);
	return id;
}

afterEach(() => {
	for (const id of usedSessionIds) clearSessionApprovals(id);
	usedSessionIds.length = 0;
});

describe("session approval store", () => {
	it("whole-tool approval is visible immediately and scoped to its session", () => {
		const sid = newSessionId();
		const other = newSessionId();
		expect(isToolApprovedForSession(sid, "bash")).toBe(false);
		approveToolForSession(sid, "bash");
		expect(isToolApprovedForSession(sid, "bash")).toBe(true);
		// Approvals never leak into other sessions or other tools.
		expect(isToolApprovedForSession(other, "bash")).toBe(false);
		expect(isToolApprovedForSession(sid, "write")).toBe(false);
	});

	it("an empty session id records nothing — the feature stays inert", () => {
		approveToolForSession("", "bash");
		addSimilarApproval("", "bash", "echo hi", "id-1");
		addFileApprovals("", ["/repo/a.ts"]);
		expect(isToolApprovedForSession("", "bash")).toBe(false);
		expect(getSimilarApprovals("", "bash")).toEqual([]);
		expect(getFileApprovals("")).toEqual([]);
		expect(isFileApprovedForSession("", "/repo/a.ts")).toBe(false);
		expect(hasSessionApprovalGrants("", "bash")).toBe(false);
	});

	it("similar approvals are kept newest-first, deduped by identity, and capped at 10 per tool", () => {
		const sid = newSessionId();
		const subjects = () => getSimilarApprovals(sid, "bash").map(entry => entry.subject);
		for (let i = 1; i <= 12; i++) addSimilarApproval(sid, "bash", `cmd-${i}`, `id-${i}`);
		// The two oldest subjects fall off the back of the cap.
		expect(subjects()).toEqual([
			"cmd-12",
			"cmd-11",
			"cmd-10",
			"cmd-9",
			"cmd-8",
			"cmd-7",
			"cmd-6",
			"cmd-5",
			"cmd-4",
			"cmd-3",
		]);
		// Re-approving the same call refreshes it without duplicating.
		addSimilarApproval(sid, "bash", "cmd-5", "id-5");
		expect(subjects()).toEqual([
			"cmd-5",
			"cmd-12",
			"cmd-11",
			"cmd-10",
			"cmd-9",
			"cmd-8",
			"cmd-7",
			"cmd-6",
			"cmd-4",
			"cmd-3",
		]);
		// Same display text, different arguments: two grants, not one — the
		// display subject never merges distinct calls.
		addSimilarApproval(sid, "bash", "cmd-5", "id-5-other-args");
		expect(subjects().slice(0, 2)).toEqual(["cmd-5", "cmd-5"]);
		expect(
			getSimilarApprovals(sid, "bash")
				.map(entry => entry.identity)
				.slice(0, 2),
		).toEqual(["id-5-other-args", "id-5"]);
		// Subjects are recorded per tool, not per session-wide list.
		expect(getSimilarApprovals(sid, "write")).toEqual([]);
	});

	it("truncates a bulk subject for retention without merging calls that differ past the bound", () => {
		const sid = newSessionId();
		const head = `Path: src/a.ts\nContent: ${"x".repeat(200)}`;
		const bulk = `${head}${"y".repeat(64 * 1024)}`;
		addSimilarApproval(sid, "write", bulk, "id-safe");
		const [recorded, ...rest] = getSimilarApprovals(sid, "write");
		expect(rest).toEqual([]);
		// The bound cuts the tail and marks it, so the head that names the
		// target survives whatever the payload does.
		expect(recorded?.subject.length).toBe(4096);
		expect(recorded?.subject.startsWith(head)).toBe(true);
		expect(recorded?.subject.endsWith("…")).toBe(true);
		// Two calls whose subjects are identical after that bound stay two
		// grants: the identity, not the retained text, decides what repeats.
		addSimilarApproval(sid, "write", `${bulk}-different-tail`, "id-pwn");
		expect(getSimilarApprovals(sid, "write").map(entry => entry.identity)).toEqual(["id-pwn", "id-safe"]);
		expect(getSimilarApprovals(sid, "write")[0]?.subject).toBe(recorded?.subject);
	});

	it("whole-tool approval supersedes that tool's similar list but not other tools'", () => {
		const sid = newSessionId();
		addSimilarApproval(sid, "bash", "git status", "id-bash");
		addSimilarApproval(sid, "write", "src/a.ts", "id-write");
		approveToolForSession(sid, "bash");
		expect(getSimilarApprovals(sid, "bash")).toEqual([]);
		expect(isToolApprovedForSession(sid, "bash")).toBe(true);
		expect(getSimilarApprovals(sid, "write")).toEqual([{ identity: "id-write", subject: "src/a.ts" }]);
	});

	it("clearSessionApprovals wipes only the targeted session's state", () => {
		const sid = newSessionId();
		const other = newSessionId();
		approveToolForSession(sid, "bash");
		addSimilarApproval(sid, "write", "src/a.ts", "id-write");
		approveToolForSession(other, "bash");
		clearSessionApprovals(sid);
		expect(isToolApprovedForSession(sid, "bash")).toBe(false);
		expect(getSimilarApprovals(sid, "write")).toEqual([]);
		expect(isToolApprovedForSession(other, "bash")).toBe(true);
	});

	it("file grants are session-wide, newest-first, and capped at 64 by last use", () => {
		const sid = newSessionId();
		const other = newSessionId();
		addFileApprovals(sid, [`${REPO}/a.ts`, `${REPO}/b.ts`]);
		// One grant answers for every tool that reaches the file; the store keeps
		// no tool dimension at all.
		expect(isFileApprovedForSession(sid, `${REPO}/a.ts`)).toBe(true);
		expect(isFileApprovedForSession(sid, `${REPO}/c.ts`)).toBe(false);
		expect(isFileApprovedForSession(other, `${REPO}/a.ts`)).toBe(false);
		expect(getFileApprovals(sid)).toEqual([`${REPO}/b.ts`, `${REPO}/a.ts`]);

		for (let i = 0; i < 64; i++) addFileApprovals(sid, [`${REPO}/f-${i}.ts`]);
		// `a.ts` was re-approved after `b.ts`, so it outlives it under the cap.
		addFileApprovals(sid, [`${REPO}/a.ts`]);
		for (let i = 64; i < 70; i++) addFileApprovals(sid, [`${REPO}/f-${i}.ts`]);
		const files = getFileApprovals(sid);
		expect(files).toHaveLength(64);
		expect(files[0]).toBe(`${REPO}/f-69.ts`);
		expect(isFileApprovedForSession(sid, `${REPO}/a.ts`)).toBe(true);
		expect(isFileApprovedForSession(sid, `${REPO}/b.ts`)).toBe(false);
	});

	it("file grants survive a whole-tool approval and die with the session", () => {
		const sid = newSessionId();
		addFileApprovals(sid, [`${REPO}/a.ts`]);
		addSimilarApproval(sid, "bash", "git status", "id-bash");
		// Approving all of `bash` drops that tool's subjects, but a file grant is
		// not `bash`'s to lose: `write` and `edit` still hold it.
		approveToolForSession(sid, "bash");
		expect(isFileApprovedForSession(sid, `${REPO}/a.ts`)).toBe(true);
		clearSessionApprovals(sid);
		expect(getFileApprovals(sid)).toEqual([]);
	});

	it("reports whether anything recorded could cover a call, so the gate knows to classify", () => {
		const sid = newSessionId();
		expect(hasSessionApprovalGrants(sid, "bash")).toBe(false);
		addSimilarApproval(sid, "bash", "git status", "id-bash");
		// A recorded subject covers only the tool that earned it.
		expect(hasSessionApprovalGrants(sid, "bash")).toBe(true);
		expect(hasSessionApprovalGrants(sid, "write")).toBe(false);
		// A file grant is a reason to classify any tool's call.
		addFileApprovals(sid, [`${REPO}/a.ts`]);
		expect(hasSessionApprovalGrants(sid, "write")).toBe(true);
	});

	it("excludes task from every session grant", () => {
		// A subagent's prompt is free-form text with no bounded operation to
		// compare, and it runs its own tool calls behind its own gate.
		expect(isSessionGrantExcluded("task")).toBe(true);
		expect(isSessionGrantExcluded("bash")).toBe(false);
		expect(isSessionGrantExcluded("write")).toBe(false);
	});

	it("normalizes a grant key to an absolute path and refuses what it cannot pin down", () => {
		// A grant recorded from one call's relative path must match the next call's
		// absolute one, so every key resolves against that call's own cwd.
		expect(normalizeApprovalPath("src/a.ts", REPO)).toBe(`${REPO}/src/a.ts`);
		expect(normalizeApprovalPath("./src/../src/a.ts", REPO)).toBe(`${REPO}/src/a.ts`);
		expect(normalizeApprovalPath(`${REPO}/src/a.ts`, "/elsewhere")).toBe(`${REPO}/src/a.ts`);
		expect(normalizeApprovalPath("  src/a.ts  ", REPO)).toBe(`${REPO}/src/a.ts`);
		// A glob names a set that would silently widen with the filesystem, and a
		// `scheme://` target is handler-owned rather than a file.
		expect(normalizeApprovalPath("src/*.ts", REPO)).toBeUndefined();
		expect(normalizeApprovalPath("local://notes.md", REPO)).toBeUndefined();
		expect(normalizeApprovalPath("https://evil.example/x", REPO)).toBeUndefined();
		expect(normalizeApprovalPath("", REPO)).toBeUndefined();
	});
});

describe("approvalIdentity", () => {
	it("separates calls whose approval subjects are identical after truncation", () => {
		// Every tool cuts bulk payloads to 2000 chars for the prompt, and the store
		// bounds the result again at 4096, so these two writes are recorded as the
		// same text. Only the identity keeps them apart, and it must, or approving
		// the first auto-approves the second with no model and no prompt.
		const head = "x".repeat(8_000);
		expect(approvalIdentity({ content: `${head}SAFE`, path: "src/a.ts" })).not.toBe(
			approvalIdentity({ content: `${head}PWN!`, path: "src/a.ts" }),
		);
	});

	it("is independent of key insertion order so a true repeat matches itself", () => {
		expect(approvalIdentity({ content: "a", path: "src/a.ts" })).toBe(
			approvalIdentity({ path: "src/a.ts", content: "a" }),
		);
		expect(approvalIdentity({ nested: { b: 2, a: 1 } })).toBe(approvalIdentity({ nested: { a: 1, b: 2 } }));
	});
});

describe("approvalSubject", () => {
	/** A tool declaring no approval detail lines — the structural fallback path. */
	const plain = {};
	/** Shaped like the real `write` tool's formatter (`src/tools/write.ts`). */
	const writeLike = {
		formatApprovalDetails: (args: unknown): string[] => {
			const params = args as { path?: string; content?: string };
			return [`Path: ${params.path ?? "(missing)"}`, `Content:\n${params.content ?? ""}`];
		},
	};

	it("prefers the tool's approval detail lines so truncation cannot hide the target", () => {
		const content = 'import * as fs from "node:fs/promises";\n'.repeat(20);
		const subject = approvalSubject(writeLike, { content, path: "src/deep/module/handler.ts" });
		// The path leads the subject: what the user approved is identified by its
		// target, not by the payload that follows it.
		expect(subject.startsWith("Path: src/deep/module/handler.ts\nContent:\n")).toBe(true);
	});

	it("accepts a single detail string and drops empty detail lines", () => {
		expect(approvalSubject({ formatApprovalDetails: () => "Command: git status" }, { command: "ls" })).toBe(
			"Command: git status",
		);
		expect(approvalSubject({ formatApprovalDetails: () => ["", "Action: open"] }, {})).toBe("Action: open");
	});

	it("falls back to the raw command when details are absent, empty, or throw", () => {
		expect(approvalSubject(plain, { command: "git status", timeout: 30 })).toBe("git status");
		expect(approvalSubject({ formatApprovalDetails: () => [] }, { command: "git status" })).toBe("git status");
		// A third-party formatter that throws must not fail the tool call.
		const thrower = {
			formatApprovalDetails: (): string => {
				throw new Error("formatter exploded");
			},
		};
		expect(approvalSubject(thrower, { command: "git status" })).toBe("git status");
	});

	it("puts bulk payload fields last in the JSON fallback", () => {
		const content = "x".repeat(400);
		const subject = approvalSubject(plain, { content, path: "src/a.ts" });
		expect(subject.startsWith('{"path":"src/a.ts","content":')).toBe(true);
		// Key insertion order must not change the subject: it is the only text
		// describing an approved call to the classifier, so one call has to read
		// as one command however its args were assembled.
		expect(approvalSubject(plain, { path: "src/a.ts", content })).toBe(subject);
	});

	it("falls back to sorted-key JSON that is independent of key insertion order", () => {
		expect(approvalSubject(plain, { b: 2, a: 1 })).toBe('{"a":1,"b":2}');
		// Equivalent nested args must produce the identical subject, for the same
		// reason. (Exact repeats are matched on the args digest, not on this
		// text — see `approvalIdentity`.)
		const first = approvalSubject(plain, { x: { b: 2, a: 1 }, c: 3 });
		const second = approvalSubject(plain, { c: 3, x: { a: 1, b: 2 } });
		expect(first).toBe('{"c":3,"x":{"a":1,"b":2}}');
		expect(second).toBe(first);
	});

	it("treats a non-string or empty command field as absent", () => {
		expect(approvalSubject(plain, { command: 42, a: 1 })).toBe('{"a":1,"command":42}');
		expect(approvalSubject(plain, { command: "" })).toBe('{"command":""}');
	});

	it("stringifies non-object args deterministically", () => {
		expect(approvalSubject(plain, undefined)).toBe("null");
		expect(approvalSubject(plain, "echo hi")).toBe('"echo hi"');
		expect(approvalSubject(plain, [1, "a"])).toBe('[1,"a"]');
		// JSON.stringify drops undefined-valued properties; so does the subject.
		expect(approvalSubject(plain, { a: undefined, b: 1 })).toBe('{"b":1}');
	});
});
