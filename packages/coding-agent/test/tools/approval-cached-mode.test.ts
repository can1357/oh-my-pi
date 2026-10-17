/**
 * `tools.approvalMode: always-ask-cached` — resolver semantics, the on-disk
 * grant store, and the wrapper's approve-then-remember cycle.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, ToolTier } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type ApprovalGrantStore,
	APPROVAL_ALWAYS_FILE_LABEL,
	APPROVAL_APPROVE_FILE_LABEL,
	APPROVAL_APPROVE_LABEL,
	APPROVAL_DENY_LABEL,
	APPROVAL_ONCE_LABEL,
	approvalFolderCandidate,
	approvalGrantKey,
	approvalToolKey,
	recordApprovalCacheTargets,
	resolveApproval,
	resolveApprovalFromContext,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	ApprovalCache,
	ApprovalGrants,
	APPROVAL_CACHE_FILENAME,
	approvalAncestorDirectoryKeys,
	approvalDirectoryCovers,
	approvalDirectoryKey,
	commonApprovalDirectoryKey,
	clearApprovalGrants,
	getApprovalCache,
	getApprovalGrants,
	SessionApprovals,
	__resetSessionApprovalsForTests,
} from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { approvalTargetKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { getAgentDir, isRecord, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

/** Minimal tool session for directly exercising a tool's approval-cache keys. */
function createToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

/** Check-only store for resolution tests: knows exactly the given keys. */
function testGrants(keys: string[] = []): ApprovalGrantStore {
	const grants = new Set(keys);
	return { has: key => grants.has(key) };
}

/** A real two-tier store over a temp agent directory, for recording tests. */
function recordingGrants(agentDir: string): ApprovalGrants {
	return new ApprovalGrants(new SessionApprovals(), new ApprovalCache(agentDir));
}

/** Tool that declares `approvalTargetKey` targets from `args.path`, like read/write/edit. */
function pathTool(name: string, tier: ToolTier, cwd: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: tier,
		approvalCacheTargets: (args: unknown) =>
			isRecord(args) && typeof args.path === "string" ? [approvalTargetKey(cwd, args.path)!] : undefined,
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

/** Tool that declares cache targets from `args.path`, mirroring read/write/edit. */
function targetTool(name: string, tier: ToolTier): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: tier,
		approvalCacheTargets: (args: unknown) => {
			if (!isRecord(args) || typeof args.path !== "string") return undefined;
			return [`target:${args.path}`];
		},
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

describe("always-ask-cached resolution", () => {
	it("prompts once per target and capability, then resolves cached targets silently", () => {
		const read = targetTool("read", "read");
		const write = targetTool("write", "write");
		const grants = testGrants();

		const firstRead = resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}, grants);
		expect(firstRead).toMatchObject({ policy: "prompt", tier: "read", source: "mode" });
		expect(firstRead.reason).toBeTruthy();

		expect(resolveApproval(write, { path: "notes.txt" }, "always-ask-cached", {}, grants).policy).toBe("prompt");

		// Recording lands in the session tier by default, keyed by the capability the approval
		// covered: the read grant answers later reads of that target and nothing more.
		const dir = TempDir.createSync("@pi-approval-record-");
		try {
			const store = recordingGrants(dir.path());
			recordApprovalCacheTargets(read, { path: "notes.txt" }, store, "read");
			expect(store.session.has(approvalGrantKey("read", "target:notes.txt"))).toBe(true);
			expect(store.global.size).toBe(0);
			expect(resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}, store).policy).toBe("allow");
			expect(resolveApproval(write, { path: "notes.txt" }, "always-ask-cached", {}, store).policy).toBe("prompt");
			// A different target is still unknown.
			expect(resolveApproval(read, { path: "other.txt" }, "always-ask-cached", {}, store).policy).toBe("prompt");
			// Approving the write instead covers writes and the lower read tier of that target.
			recordApprovalCacheTargets(write, { path: "notes.txt" }, store, "write");
			expect(resolveApproval(write, { path: "notes.txt" }, "always-ask-cached", {}, store).policy).toBe("allow");
			expect(resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}, store).policy).toBe("allow");
		} finally {
			dir.removeSync();
		}
	});

	it("auto-approves read-tier tools without targets and keeps prompting write-tier ones", () => {
		const plainRead = { name: "glob", approval: "read" as const } as AgentTool;
		const plainWrite = { name: "mcp__filesystem_write", approval: "write" as const } as AgentTool;
		const grants = testGrants();
		expect(resolveApproval(plainRead, {}, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "allow",
			source: "mode",
		});
		expect(resolveApproval(plainWrite, {}, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "prompt",
			source: "mode",
		});
	});

	it("uses folder scopes, never command text, to cover exec calls", () => {
		const cwd = path.resolve("/work/project");
		const bash: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "command tool",
			parameters: {} as never,
			approval: "exec",
			approvalCacheScopes: () => [approvalDirectoryKey(path.join(cwd, "TestDir"))],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const uncovered = testGrants();
		expect(resolveApproval(bash, { command: "npm test" }, "always-ask-cached", {}, uncovered)).toMatchObject({
			policy: "prompt",
			tier: "exec",
			reason: "folder not yet approved",
		});
		// A granted folder covers the call, whatever the command.
		const covered = testGrants([approvalGrantKey("exec", approvalDirectoryKey(path.join(cwd, "TestDir")))]);
		expect(resolveApproval(bash, { command: "npm test" }, "always-ask-cached", {}, covered).policy).toBe("allow");
		expect(resolveApproval(bash, { command: "rm -rf build" }, "always-ask-cached", {}, covered).policy).toBe("allow");
		// A grant on the parent folder never covers a call scoped to a subfolder.
		const ancestor = testGrants([approvalGrantKey("exec", approvalDirectoryKey(cwd))]);
		expect(
			resolveApproval(
				bash,
				{ command: "npm test", cwd: path.join(cwd, "TestDir", "sub") },
				"always-ask-cached",
				{},
				ancestor,
			).policy,
		).toBe("prompt");
	});

	it("keeps prompting exec tools that declare no scope or target", () => {
		const evalTool = { name: "eval", approval: "exec" as const } as AgentTool;
		const grants = testGrants([approvalGrantKey("exec", "target:anything")]);
		expect(resolveApproval(evalTool, { code: "1 + 1" }, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "prompt",
			tier: "exec",
			reason: "target not yet approved",
		});
	});

	it("covers a read-granted folder's own entries, nothing below a subfolder, and never writes", () => {
		const cwd = path.resolve("/work/project");
		const key = (target: string) => approvalTargetKey(cwd, target)!;
		const granted = testGrants([approvalGrantKey("read", approvalDirectoryKey(path.join(cwd, "TestDir")))]);
		const read = targetTool("read", "read");
		const write = targetTool("write", "write");
		// The tool reports keys, so feed it pre-derived ones through a wrapper.
		const direct: AgentTool = { ...read, approvalCacheTargets: () => [key("TestDir/TestFile.exe")] };
		expect(resolveApproval(direct, {}, "always-ask-cached", {}, granted).policy).toBe("allow");
		// A subfolder is its own grant: neither it nor anything below it rides on the parent's.
		const subfolder: AgentTool = {
			...read,
			approvalCacheTargets: () => [approvalDirectoryKey(path.join(cwd, "TestDir", "sub"))],
		};
		expect(resolveApproval(subfolder, {}, "always-ask-cached", {}, granted).policy).toBe("prompt");
		const nested: AgentTool = { ...read, approvalCacheTargets: () => [key("TestDir/sub/deep/file.ts")] };
		expect(resolveApproval(nested, {}, "always-ask-cached", {}, granted).policy).toBe("prompt");
		const subGranted = testGrants([approvalGrantKey("read", approvalDirectoryKey(path.join(cwd, "TestDir", "sub")))]);
		const inSub: AgentTool = { ...read, approvalCacheTargets: () => [key("TestDir/sub/entry.ts")] };
		expect(resolveApproval(inSub, {}, "always-ask-cached", {}, subGranted).policy).toBe("allow");
		expect(resolveApproval(nested, {}, "always-ask-cached", {}, subGranted).policy).toBe("prompt");
		// Outside the granted folder it still asks, and the read grant never covers a write below it.
		const outside: AgentTool = { ...read, approvalCacheTargets: () => [key("OtherDir/file.ts")] };
		expect(resolveApproval(outside, {}, "always-ask-cached", {}, granted).policy).toBe("prompt");
		expect(resolveApproval(write, { path: "TestDir/x.txt" }, "always-ask-cached", {}, granted).policy).toBe("prompt");
	});

	it("covers an exec call scoped to the granted folder itself, not its subfolder", () => {
		const cwd = path.resolve("/work/project");
		const sub = approvalDirectoryKey(path.join(cwd, "TestDir", "sub"));
		const scoped: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "scoped command tool",
			parameters: {} as never,
			approval: "exec",
			approvalCacheTargets: () => ["bash: anything goes"],
			approvalCacheScopes: () => [sub],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const parentGranted = testGrants([approvalGrantKey("exec", approvalDirectoryKey(path.join(cwd, "TestDir")))]);
		expect(resolveApproval(scoped, {}, "always-ask-cached", {}, parentGranted).policy).toBe("prompt");
		const subGranted = testGrants([approvalGrantKey("exec", sub)]);
		expect(resolveApproval(scoped, {}, "always-ask-cached", {}, subGranted).policy).toBe("allow");
		const elsewhere: AgentTool = {
			...scoped,
			approvalCacheScopes: () => [approvalDirectoryKey(path.join(cwd, "Other"))],
		};
		expect(resolveApproval(elsewhere, {}, "always-ask-cached", {}, subGranted).policy).toBe("prompt");
	});

	it("offers the shared folder as the approval candidate", () => {
		const cwd = path.resolve("/work/project");
		const single: AgentTool = {
			name: "write",
			label: "Write",
			description: "single",
			parameters: {} as never,
			approval: "write",
			approvalCacheTargets: () => [approvalTargetKey(cwd, "TestDir/TestFile.exe")!],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		expect(approvalFolderCandidate(single, {})).toEqual({
			key: approvalDirectoryKey(path.join(cwd, "TestDir")),
			label: shortenPath(approvalDirectoryKey(path.join(cwd, "TestDir")).replace(/[\\/]+$/, "")),
		});
		const command: AgentTool = {
			...single,
			approvalCacheScopes: () => [approvalDirectoryKey(path.join(cwd, "TestDir"))],
		};
		expect(approvalFolderCandidate(command, {})).toBeDefined();
		// A filesystem root keeps its own name: stripping the separator would leave an empty label.
		const rootKey = approvalDirectoryKey(path.parse(cwd).root);
		const atRoot: AgentTool = { ...single, approvalCacheTargets: () => [path.parse(cwd).root] };
		expect(approvalFolderCandidate(atRoot, {})).toEqual({ key: rootKey, label: rootKey });
		const urls: AgentTool = {
			...single,
			approvalCacheTargets: () => ["xd://todo"],
			approvalCacheScopes: () => undefined,
		};
		expect(approvalFolderCandidate(urls, {})).toBeUndefined();
	});

	it("requires every target of a multi-target call to be approved", () => {
		const edit: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "multi-target test tool",
			parameters: {} as never,
			approval: "write",
			approvalCacheTargets: () => ["target:a.ts", "target:b.ts"],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		expect(
			resolveApproval(edit, {}, "always-ask-cached", {}, testGrants([approvalGrantKey("write", "target:a.ts")]))
				.policy,
		).toBe("prompt");
		expect(
			resolveApproval(
				edit,
				{},
				"always-ask-cached",
				{},
				testGrants([approvalGrantKey("write", "target:a.ts"), approvalGrantKey("write", "target:b.ts")]),
			).policy,
		).toBe("allow");
	});

	it("never lets a read grant cover an exec-tier call of the same target", () => {
		const pdf: AgentTool = {
			name: "read_pdf",
			label: "Read PDF",
			description: "exec-tier read of an image member",
			parameters: {} as never,
			approval: "exec",
			approvalCacheTargets: () => ["pdf:notes.pdf"],
			execute: async () => ({ content: [{ type: "text" as const, text: "page" }] }),
		};
		expect(
			resolveApproval(pdf, {}, "always-ask-cached", {}, testGrants([approvalGrantKey("read", "pdf:notes.pdf")]))
				.policy,
		).toBe("prompt");
		expect(
			resolveApproval(pdf, {}, "always-ask-cached", {}, testGrants([approvalGrantKey("exec", "pdf:notes.pdf")]))
				.policy,
		).toBe("allow");
	});

	it("keeps tool and user policies authoritative over the cache", () => {
		const write = targetTool("write", "write");
		const approved = testGrants([approvalGrantKey("write", "target:notes.txt")]);
		// A user `prompt` policy outranks the cached allow.
		expect(
			resolveApproval(write, { path: "notes.txt" }, "always-ask-cached", { write: "prompt" }, approved),
		).toMatchObject({ policy: "prompt", source: "user" });
		// A user `allow` policy outranks the missing cache entry.
		expect(
			resolveApproval(write, { path: "fresh.txt" }, "always-ask-cached", { write: "allow" }, approved),
		).toMatchObject({ policy: "allow", source: "user" });
		// A tool-owned prompt (safety override) stays per-call.
		const overridden: AgentTool = {
			name: "write",
			label: "Write",
			description: "override test tool",
			parameters: {} as never,
			approval: () => ({ tier: "write", override: true, reason: "guarded" }),
			approvalCacheTargets: () => ["target:notes.txt"],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		expect(resolveApproval(overridden, { path: "notes.txt" }, "always-ask-cached", {}, approved)).toMatchObject({
			policy: "prompt",
			source: "tool",
			reason: "guarded",
		});
	});

	it("is accepted by the settings schema and reaches resolveApprovalFromContext", () => {
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask-cached" });
		expect(resolveApprovalFromContext({ settings }).approvalMode).toBe("always-ask-cached");
	});
});

/** Reads the raw grant rows of a test database, ordered by key. */
function readGrants(dir: string): Array<{ key: string; tool: string; approvedAt: string; scope: string | null }> {
	const db = new Database(path.join(dir, APPROVAL_CACHE_FILENAME), { readonly: true });
	try {
		return db
			.query<{ key: string; tool: string; approved_at: string; scope: string | null }, []>(
				"SELECT key, tool, approved_at, scope FROM grants ORDER BY key",
			)
			.all()
			.map(row => ({ key: row.key, tool: row.tool, approvedAt: row.approved_at, scope: row.scope }));
	} finally {
		db.close();
	}
}

describe("approval cache store", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-approval-cache-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("leaves no file behind until a grant is recorded", () => {
		const cache = new ApprovalCache(tempDir.path());
		expect(cache.has("C:/work/notes.txt")).toBe(false);
		expect(cache.size).toBe(0);
		expect(fs.existsSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME))).toBe(false);
	});

	it("persists granted targets as database rows and reads them back in a fresh instance", () => {
		const cache = new ApprovalCache(tempDir.path());
		const key = approvalGrantKey("read", "C:/work/notes.txt");
		cache.record(key, "read");
		expect(cache.has(key)).toBe(true);
		expect(cache.has(approvalGrantKey("read", "C:/work/other.txt"))).toBe(false);
		expect(cache.size).toBe(1);

		const [row] = readGrants(tempDir.path());
		expect(row).toMatchObject({ key, tool: "read", scope: null });
		expect(Number.isNaN(Date.parse(row!.approvedAt))).toBe(false);

		expect(new ApprovalCache(tempDir.path()).has(key)).toBe(true);
	});

	it("keeps grants from another writer and never rewrites an existing key", () => {
		const cache = new ApprovalCache(tempDir.path());
		cache.record(approvalGrantKey("read", "first.txt"), "read");
		new ApprovalCache(tempDir.path()).record(approvalGrantKey("write", "second.txt"), "write");
		cache.record(approvalGrantKey("read", "first.txt"), "edit");
		expect(readGrants(tempDir.path()).map(row => row.key)).toEqual([
			approvalGrantKey("read", "first.txt"),
			approvalGrantKey("write", "second.txt"),
		]);
		expect(readGrants(tempDir.path())[0]!.tool).toBe("read");
	});

	it("drops grants when the database is deleted, so revocation does not need a restart", () => {
		const cache = new ApprovalCache(tempDir.path());
		cache.record(approvalGrantKey("read", "first.txt"));
		fs.rmSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME));
		expect(cache.has(approvalGrantKey("read", "first.txt"))).toBe(false);
		cache.record(approvalGrantKey("read", "second.txt"));
		expect(readGrants(tempDir.path()).map(row => row.key)).toEqual([approvalGrantKey("read", "second.txt")]);
	});

	it("persists a directory grant with its scope marker", () => {
		const cache = new ApprovalCache(tempDir.path());
		const key = approvalGrantKey("read", "c:\\testdir\\");
		cache.record(key, "read", "directory");
		expect(cache.has(key)).toBe(true);
		expect(readGrants(tempDir.path())).toEqual([
			{ key, tool: "read", approvedAt: expect.any(String), scope: "directory" },
		]);
	});

	it("quarantines an unusable database and starts a fresh one", () => {
		fs.mkdirSync(tempDir.path(), { recursive: true });
		fs.writeFileSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME), "{not a database");
		const cache = new ApprovalCache(tempDir.path());
		expect(cache.has("anything")).toBe(false);
		cache.record(approvalGrantKey("read", "fresh.txt"));
		expect(readGrants(tempDir.path()).map(row => row.key)).toEqual([approvalGrantKey("read", "fresh.txt")]);
		expect(fs.existsSync(`${path.join(tempDir.path(), APPROVAL_CACHE_FILENAME)}.corrupt`)).toBe(true);
	});

	it("imports a legacy JSON cache once and leaves only the database behind", () => {
		fs.mkdirSync(tempDir.path(), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir.path(), "approval-cache.json"),
			JSON.stringify({
				version: 1,
				paths: {
					"c:\\testdir\\notes.txt": { tool: "read", approvedAt: "2026-10-15T00:00:00.000Z" },
					"c:\\testdir\\": { tool: "read", approvedAt: "2026-10-15T00:00:00.000Z", scope: "directory" },
				},
			}),
		);
		const cache = new ApprovalCache(tempDir.path());
		expect(cache.has(approvalGrantKey("read", "c:\\testdir\\notes.txt"))).toBe(true);
		expect(readGrants(tempDir.path())).toEqual([
			{
				key: approvalGrantKey("read", "c:\\testdir\\"),
				tool: "read",
				approvedAt: "2026-10-15T00:00:00.000Z",
				scope: "directory",
			},
			{
				key: approvalGrantKey("read", "c:\\testdir\\notes.txt"),
				tool: "read",
				approvedAt: "2026-10-15T00:00:00.000Z",
				scope: null,
			},
		]);
		// The legacy file is gone: the database is the only cache on disk.
		expect(fs.existsSync(path.join(tempDir.path(), "approval-cache.json"))).toBe(false);
		expect(fs.existsSync(path.join(tempDir.path(), "approval-cache.json.bak"))).toBe(false);
		expect(fs.existsSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME))).toBe(true);
	});

	it("keeps an unreadable legacy JSON as a .bak instead of dropping it", () => {
		fs.mkdirSync(tempDir.path(), { recursive: true });
		fs.writeFileSync(path.join(tempDir.path(), "approval-cache.json"), "{not json");
		const cache = new ApprovalCache(tempDir.path());
		expect(cache.has("anything")).toBe(false);
		expect(fs.existsSync(path.join(tempDir.path(), "approval-cache.json"))).toBe(false);
		expect(fs.existsSync(path.join(tempDir.path(), "approval-cache.json.bak"))).toBe(true);
	});

	it("keeps session grants in memory only, so a fresh instance starts clean", () => {
		const session = new SessionApprovals();
		session.record("C:/work/notes.txt", "read");
		expect(session.has("C:/work/notes.txt")).toBe(true);
		expect(session.size).toBe(1);
		// The in-memory record is the same shape a global row answers.
		expect(session.get("C:/work/notes.txt")).toEqual({
			key: "C:/work/notes.txt",
			tool: "read",
			approvedAt: expect.any(String),
		});
		// Nothing reached the global database, so a new instance (or a restarted one) sees no file.
		expect(fs.existsSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME))).toBe(false);
		expect(new ApprovalCache(tempDir.path()).has("C:/work/notes.txt")).toBe(false);
		session.clear();
		expect(session.has("C:/work/notes.txt")).toBe(false);
	});

	it("stores one grant in the same record shape in memory and in the database", () => {
		const session = new SessionApprovals();
		const global = new ApprovalCache(tempDir.path());
		const key = approvalGrantKey("write", "C:/work/dir/");
		for (const store of [session, global]) store.record(key, "write", "directory");
		const inMemory = session.get(key)!;
		const inDatabase = global.get(key)!;
		expect(inDatabase).toEqual({ ...inMemory, approvedAt: expect.any(String) });
		expect(inDatabase.scope).toBe("directory");
		// A key no tier holds answers undefined in both.
		expect(session.get("C:/work/other")).toBeUndefined();
		expect(global.get("C:/work/other")).toBeUndefined();
	});

	it("allows a key from either tier through the composite store", () => {
		const session = new SessionApprovals();
		const global = new ApprovalCache(tempDir.path());
		const grants = new ApprovalGrants(session, global);
		const sessionKey = approvalGrantKey("read", "session-key");
		const globalKey = approvalGrantKey("read", "global-key");
		grants.record(sessionKey, "read");
		grants.record(globalKey, "read", undefined, "global");
		expect(session.has(sessionKey)).toBe(true);
		expect(global.has(sessionKey)).toBe(false);
		expect(grants.has(sessionKey)).toBe(true);
		expect(grants.has(globalKey)).toBe(true);
		expect(readGrants(tempDir.path())).toEqual([expect.objectContaining({ key: globalKey, scope: null })]);
	});

	it("keeps a conversation's session grants out of another conversation", () => {
		const dir = tempDir.path();
		const first = getApprovalGrants(dir, "session-one");
		first.record(approvalGrantKey("read", "target:x"), "read");
		expect(getApprovalGrants(dir, "session-one").has(approvalGrantKey("read", "target:x"))).toBe(true);
		// Another conversation in the same process, and the anonymous scope, start without it.
		expect(getApprovalGrants(dir, "session-two").has(approvalGrantKey("read", "target:x"))).toBe(false);
		expect(getApprovalGrants(dir).has(approvalGrantKey("read", "target:x"))).toBe(false);
		// "Always …" grants stay shared by every conversation under the directory.
		getApprovalGrants(dir, "session-two").record(approvalGrantKey("read", "target:y"), "read", undefined, "global");
		expect(getApprovalGrants(dir, "session-one").has(approvalGrantKey("read", "target:y"))).toBe(true);
	});

	it("returns one shared store per agent directory", () => {
		expect(getApprovalCache(tempDir.path())).toBe(getApprovalCache(tempDir.path()));
		expect(getApprovalCache(path.join(tempDir.path(), "nested-other"))).not.toBe(getApprovalCache(tempDir.path()));
		expect(getApprovalGrants(tempDir.path())).toBe(getApprovalGrants(tempDir.path()));
		expect(getApprovalGrants(tempDir.path()).global).toBe(getApprovalCache(tempDir.path()));
		expect(getApprovalGrants(path.join(tempDir.path(), "nested-other"))).not.toBe(getApprovalGrants(tempDir.path()));
	});

	it("forgets every row when cleared, and clearing an absent cache is a no-op", () => {
		const cache = new ApprovalCache(tempDir.path());
		const notes = approvalGrantKey("read", "C:/work/notes.txt");
		const dir = approvalGrantKey("read", "c:\\testdir\\");
		cache.record(notes, "read");
		cache.record(dir, "read", "directory");
		expect(cache.size).toBe(2);

		cache.clear();

		expect(cache.size).toBe(0);
		expect(readGrants(tempDir.path())).toEqual([]);
		// A fresh instance (and a later check through the same store) sees nothing either.
		expect(new ApprovalCache(tempDir.path()).has(notes)).toBe(false);
		expect(cache.has(dir)).toBe(false);
		cache.clear();
		expect(cache.size).toBe(0);
		// The file stays: grants recorded after a clear persist as usual.
		cache.record(approvalGrantKey("read", "after-clear.txt"), "read");
		expect(readGrants(tempDir.path()).map(row => row.key)).toEqual([approvalGrantKey("read", "after-clear.txt")]);
	});

	it("clears both tiers through clearApprovalGrants, the settings action", () => {
		const grants = getApprovalGrants(tempDir.path());
		const sessionKey = approvalGrantKey("read", "session-key");
		const globalKey = approvalGrantKey("read", "global-key");
		grants.record(sessionKey, "read");
		grants.record(globalKey, "read", undefined, "global");
		expect(grants.has(sessionKey)).toBe(true);
		expect(grants.has(globalKey)).toBe(true);
		expect(readGrants(tempDir.path())).toEqual([expect.objectContaining({ key: globalKey })]);

		clearApprovalGrants(tempDir.path());

		expect(grants.has(sessionKey)).toBe(false);
		expect(grants.has(globalKey)).toBe(false);
		expect(getApprovalCache(tempDir.path()).size).toBe(0);
		expect(readGrants(tempDir.path())).toEqual([]);
		__resetSessionApprovalsForTests();
	});
});

describe("approval target keys", () => {
	const cwd = path.resolve("/work/project");

	it("resolves local targets to one absolute key across spellings", () => {
		expect(approvalTargetKey(cwd, "./sub/../notes.txt")).toBe(approvalTargetKey(cwd, "notes.txt"));
		expect(approvalTargetKey(cwd, "notes.txt")).toBe(
			process.platform === "win32" ? approvalTargetKey(cwd, "NOTES.TXT") : approvalTargetKey(cwd, "notes.txt"),
		);
		expect(approvalTargetKey(cwd, "   ")).toBeUndefined();
		expect(approvalTargetKey(cwd, "")).toBeUndefined();
	});

	it("keeps significant whitespace in one target key", () => {
		// Leading and trailing spaces are real filename bytes: two distinct files must not share a key.
		expect(approvalTargetKey(cwd, " secret ")).not.toBe(approvalTargetKey(cwd, "secret"));
		expect(approvalTargetKey(cwd, " secret ")).toBe(approvalTargetKey(cwd, " secret "));
	});

	it("keeps URL targets in their normalized form", () => {
		expect(approvalTargetKey(cwd, "xd://todo")).toBe("xd://todo");
		expect(approvalTargetKey(cwd, "local:/notes.md")).toBe("local://notes.md");
		expect(approvalTargetKey(cwd, "https://example.com/a.txt")).toBe("https://example.com/a.txt");
	});

	it("reports no cache key for public web URLs, so the cached mode never asks", () => {
		const read = new ReadTool(createToolSession(cwd));
		// Web URLs (and `www.` hosts) are public: nothing to approve, nothing to remember.
		expect(read.approvalCacheTargets?.({ path: "https://example.com/a.txt" })).toBeUndefined();
		expect(read.approvalCacheTargets?.({ path: "https://example.com/a.txt:10-20" })).toBeUndefined();
		expect(read.approvalCacheTargets?.({ path: "www.example.com/docs" })).toBeUndefined();
		// Local files keep their key, and the resolver still prompts once for them.
		expect(read.approvalCacheTargets?.({ path: "notes.txt" })).toEqual([approvalTargetKey(cwd, "notes.txt")!]);

		const grants = testGrants();
		expect(
			resolveApproval(read, { path: "https://example.com/a.txt" }, "always-ask-cached", {}, grants),
		).toMatchObject({ policy: "allow", tier: "read", source: "mode" });
		expect(resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "prompt",
			tier: "read",
			source: "mode",
		});
	});

	it("covers a read-granted folder's own entries, never a subfolder's contents", () => {
		const root = TempDir.createSync("@pi-approval-folder-depth-");
		try {
			const desktop = path.join(root.path(), "Desktop");
			const nested = path.join(desktop, "TestFolder");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(desktop, "notes.txt"), "x");
			fs.writeFileSync(path.join(nested, "inner.txt"), "x");
			const read = new ReadTool(createToolSession(root.path()));
			const granted = testGrants([approvalGrantKey("read", approvalDirectoryKey(desktop))]);
			// A file directly inside the granted folder is covered.
			expect(resolveApproval(read, { path: "Desktop/notes.txt" }, "always-ask-cached", {}, granted).policy).toBe(
				"allow",
			);
			// The subfolder and its contents are not: they need the subfolder's own grant.
			expect(resolveApproval(read, { path: "Desktop/TestFolder" }, "always-ask-cached", {}, granted).policy).toBe(
				"prompt",
			);
			expect(
				resolveApproval(read, { path: "Desktop/TestFolder/inner.txt" }, "always-ask-cached", {}, granted).policy,
			).toBe("prompt");
			// Approving the subfolder covers it and its own entries, and nothing back up the tree.
			const subGranted = testGrants([approvalGrantKey("read", approvalDirectoryKey(nested))]);
			expect(resolveApproval(read, { path: "Desktop/TestFolder" }, "always-ask-cached", {}, subGranted).policy).toBe(
				"allow",
			);
			expect(
				resolveApproval(read, { path: "Desktop/TestFolder/inner.txt" }, "always-ask-cached", {}, subGranted).policy,
			).toBe("allow");
		} finally {
			root.removeSync();
		}
	});

	it("shares one key between read selectors and write hashline headers", () => {
		const session = createToolSession(cwd);
		const read = new ReadTool(session);
		const write = new WriteTool(session);
		const readKey = read.approvalCacheTargets?.({ path: "notes.txt:120-140" });
		expect(readKey).toEqual(read.approvalCacheTargets?.({ path: "notes.txt:raw" }));
		expect(write.approvalCacheTargets?.({ path: "[notes.txt#ABCD]" })).toEqual(readKey);
		expect(write.approvalCacheTargets?.({ path: "" })).toBeUndefined();
		expect(read.approvalCacheTargets?.({})).toBeUndefined();
	});

	it("leaves the shell approved by name alone, with no folder to cover its commands", () => {
		const bash = new BashTool(createToolSession(cwd));
		// Neither a cache target nor a directory scope: a folder grant never covers a command,
		// and command text is never remembered — the prompt offers the shell's own by-name grant.
		expect("approvalCacheTargets" in bash).toBe(false);
		expect("approvalCacheScopes" in bash).toBe(false);
		const folderGranted = testGrants([approvalDirectoryKey(cwd)]);
		expect(resolveApproval(bash, { command: "git status" }, "always-ask-cached", {}, folderGranted)).toMatchObject({
			policy: "prompt",
			tier: "exec",
			source: "mode",
		});
		const toolGranted = testGrants([approvalGrantKey("exec", approvalToolKey("bash"))]);
		expect(resolveApproval(bash, { command: "git status" }, "always-ask-cached", {}, toolGranted)).toMatchObject({
			policy: "allow",
			tier: "exec",
			source: "mode",
		});
	});

	it("derives directory keys, ancestors, and shared folders", () => {
		const notes = approvalTargetKey(cwd, "sub/notes.txt")!;
		const directory = approvalDirectoryKey(path.join(cwd, "sub"));
		expect(approvalDirectoryCovers(directory, notes)).toBe(true);
		expect(approvalDirectoryCovers(approvalDirectoryKey(cwd), notes)).toBe(true);
		expect(approvalDirectoryCovers(approvalDirectoryKey(path.resolve("/elsewhere")), notes)).toBe(false);
		expect(approvalAncestorDirectoryKeys(notes)[0]).toBe(directory);
		expect(approvalAncestorDirectoryKeys("bash: npm test")).toEqual([]);
		expect(approvalAncestorDirectoryKeys("xd://todo")).toEqual([]);

		expect(commonApprovalDirectoryKey([path.join(cwd, "a"), path.join(cwd, "b")])).toBe(approvalDirectoryKey(cwd));
		expect(commonApprovalDirectoryKey([path.join(cwd, "a")])).toBe(approvalDirectoryKey(path.join(cwd, "a")));
		expect(commonApprovalDirectoryKey([])).toBeUndefined();
	});
});

describe("always-ask-cached wrapper cycle", () => {
	let tempDir: TempDir;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;
	let originalAgentDir: string;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-approval-cached-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		originalAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		// Grants are per agent directory (and the session tier is process-wide); start each case clean.
		fs.rmSync(path.join(tempDir.path(), APPROVAL_CACHE_FILENAME), { force: true });
		__resetSessionApprovalsForTests();
		sessionManager = SessionManager.inMemory(path.join(tempDir.path(), "cwd"));
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
	});

	const initializeRunner = (
		runner: ExtensionRunner,
		select: (title: string, options: string[]) => Promise<string | undefined>,
	) => {
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
			undefined,
			{
				select,
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
				onTerminalInput: () => () => {},
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWidget: () => {},
				setFooter: () => {},
				setHeader: () => {},
				setTitle: () => {},
				custom: async <T>() => undefined as T,
				pasteToEditor: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
				editor: async () => undefined,
				addAutocompleteProvider: () => {},
				setEditorComponent: () => {},
				getEditorComponent: () => undefined,
				get theme() {
					return {} as never;
				},
				getAllThemes: async () => [],
				getTheme: async () => undefined,
				setTheme: async () => ({ success: false, error: "not implemented" }),
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
			} satisfies ExtensionUIContext,
		);
	};

	function context(settings: Settings): AgentToolContext {
		return {
			sessionManager,
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings,
		} as AgentToolContext;
	}

	function cachedSettings(): Settings {
		return Settings.isolated({ "tools.approvalMode": "always-ask-cached" });
	}

	it("prompts on the first write, records the target, and runs later writes without asking", async () => {
		const select = vi.fn(async _title => APPROVAL_APPROVE_FILE_LABEL);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const tool = targetTool("write_probe", "write");
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute("cached-first", { path: "notes.txt" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);

		const grants = getApprovalGrants(settings.getAgentDir(), runner.sessionId);
		expect(grants.session.has(approvalGrantKey("write", "target:notes.txt"))).toBe(true);
		// A plain approval stays in this instance's memory: nothing reached the global database.
		expect(grants.global.size).toBe(0);

		const secondRunner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const secondSelect = vi.fn(async _title => APPROVAL_APPROVE_FILE_LABEL);
		initializeRunner(secondRunner, secondSelect);
		const secondWrapper = new ExtensionToolWrapper(tool, secondRunner);
		await secondWrapper.execute("cached-second", { path: "notes.txt" }, undefined, undefined, context(settings));
		expect(secondSelect).not.toHaveBeenCalled();
	});

	it("remembers a folder when the folder answer approves the call", async () => {
		const select = vi.fn(async _title => APPROVAL_APPROVE_FILE_LABEL);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		// The dialog host answers with the folder scope.
		const approve = vi.fn(async () => ({ approved: true, scope: "folder" }) as const);
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
			undefined,
			{
				select,
				approve,
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
				onTerminalInput: () => () => {},
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWidget: () => {},
				setFooter: () => {},
				setHeader: () => {},
				setTitle: () => {},
				custom: async <T>() => undefined as T,
				pasteToEditor: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
				editor: async () => undefined,
				addAutocompleteProvider: () => {},
				setEditorComponent: () => {},
				getEditorComponent: () => undefined,
				get theme() {
					return {} as never;
				},
				getAllThemes: async () => [],
				getTheme: async () => undefined,
				setTheme: async () => ({ success: false, error: "not implemented" }),
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
			} satisfies ExtensionUIContext,
		);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "TestDir");
		const write = (toolName: string): AgentTool => ({
			name: toolName,
			label: toolName,
			description: "file tool",
			parameters: {} as never,
			approval: "write",
			approvalCacheTargets: (args: unknown) =>
				isRecord(args) && typeof args.path === "string"
					? [approvalTargetKey(tempDir.path(), args.path)!]
					: undefined,
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		});
		const first = new ExtensionToolWrapper(write("write"), runner);
		await first.execute(
			"folder-first",
			{ path: path.join(dir, "TestFile.exe") },
			undefined,
			undefined,
			context(settings),
		);
		expect(approve).toHaveBeenCalledTimes(1);
		const [prompt] = approve.mock.calls[0] as unknown as [{ folderLabel?: string }];
		expect(prompt.folderLabel).toBe(shortenPath(approvalDirectoryKey(dir).replace(/[\\/]+$/, "")));
		expect(
			getApprovalGrants(settings.getAgentDir(), runner.sessionId).session.has(
				approvalGrantKey("write", approvalDirectoryKey(dir)),
			),
		).toBe(true);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);

		// A different file in the folder runs without asking; a file in a subfolder is its own folder.
		const second = new ExtensionToolWrapper(write("write"), runner);
		await second.execute(
			"folder-second",
			{ path: path.join(dir, "Other.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(approve).toHaveBeenCalledTimes(1);
		const third = new ExtensionToolWrapper(write("write"), runner);
		await third.execute(
			"folder-third",
			{ path: path.join(dir, "sub", "deep.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(approve).toHaveBeenCalledTimes(2);
		const [nestedPrompt] = (approve.mock.calls[1] ?? []) as unknown as [{ folderLabel?: string }];
		expect(nestedPrompt?.folderLabel).toBe(
			shortenPath(approvalDirectoryKey(path.join(dir, "sub")).replace(/[\\/]+$/, "")),
		);
		expect(
			getApprovalGrants(settings.getAgentDir(), runner.sessionId).session.has(
				approvalGrantKey("write", approvalDirectoryKey(path.join(dir, "sub"))),
			),
		).toBe(true);
		expect(select).not.toHaveBeenCalled();
	});

	it("remembers a tool by name for the session when the tool answer approves it", async () => {
		const select = vi.fn(async (_title: string, options: string[]) =>
			options.find(
				option => option === "Approve exec_scope for session" || option === "Approve other_exec for session",
			),
		);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask-cached" });
		const execTool: AgentTool = {
			name: "exec_scope",
			label: "Exec",
			description: "exec call with nothing to cache",
			parameters: {} as never,
			approval: "exec",
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(execTool, runner);

		await wrapper.execute("tool-first", {}, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
		// The answer names the tool the prompt proposed; the name alone is the key, so a later
		// call of that tool skips whatever its arguments.
		expect(select.mock.calls[0]?.[1]).toContain("Approve exec_scope for session");
		await wrapper.execute("tool-second", { command: "anything else" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
		expect(
			getApprovalGrants(settings.getAgentDir(), runner.sessionId).session.has(
				approvalGrantKey("exec", "tool:exec_scope"),
			),
		).toBe(true);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);

		// A sibling tool offers its own answer and is not covered by the first grant.
		const other: AgentTool = { ...execTool, name: "other_exec" };
		await new ExtensionToolWrapper(other, runner).execute("tool-other", {}, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(2);
		expect(select.mock.calls[1]?.[1]).toContain("Approve other_exec for session");
	});

	it("offers only the directory and once answers when the call names just a directory", async () => {
		const select = vi.fn(async (_title: string, options: string[]) =>
			options.find(option => option.startsWith("Approve Directory")),
		);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "ListedDir");
		fs.mkdirSync(dir, { recursive: true });
		const tool: AgentTool = {
			name: "read_dir",
			label: "Read",
			description: "directory listing",
			parameters: {} as never,
			approval: "read",
			approvalCacheTargets: (args: unknown) =>
				isRecord(args) && typeof args.path === "string"
					? [approvalTargetKey(tempDir.path(), args.path)!]
					: undefined,
			execute: async () => ({ content: [{ type: "text" as const, text: "listed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute("list-dir", { path: dir }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
		// The exact answer would only repeat the directory grant, so the folder answers and the
		// one-shot are all the prompt offers (hosts without the checkbox spell both lifetimes out).
		expect(select.mock.calls[0]![1]).toEqual([
			`Approve Directory: ${shortenPath(approvalDirectoryKey(dir).replace(/[\\/]+$/, ""))}`,
			`Always Approve Directory: ${shortenPath(approvalDirectoryKey(dir).replace(/[\\/]+$/, ""))}`,
			APPROVAL_ONCE_LABEL,
			APPROVAL_DENY_LABEL,
		]);
		// The directory read grants its own directory, never the parent that holds every sibling.
		expect(
			getApprovalGrants(settings.getAgentDir(), runner.sessionId).session.has(
				approvalGrantKey("read", approvalDirectoryKey(dir)),
			),
		).toBe(true);
	});

	it("records nothing when the once answer approves the call", async () => {
		const select = vi.fn(async (_title: string, options: string[]) => {
			expect(options).toContain(APPROVAL_ONCE_LABEL);
			return APPROVAL_ONCE_LABEL;
		});
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const wrapper = new ExtensionToolWrapper(pathTool("write", "write", tempDir.path()), runner);
		const key = approvalTargetKey(tempDir.path(), path.join(tempDir.path(), "once.txt"))!;

		await wrapper.execute("once-first", { path: "once.txt" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
		expect(
			getApprovalGrants(settings.getAgentDir(), runner.sessionId).session.has(approvalGrantKey("write", key)),
		).toBe(false);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);
		// Nothing was remembered, so the same call asks again.
		await wrapper.execute("once-again", { path: "once.txt" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("keeps provider safety checks per-call: their prompts offer no grant answers", async () => {
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const wrapper = new ExtensionToolWrapper(pathTool("safety_write", "write", tempDir.path()), runner);
		const safetyContext = {
			...context(settings),
			toolCall: {
				batchId: "safety-batch",
				index: 0,
				total: 1,
				toolCalls: [],
				providerMetadata: {
					type: "computer",
					providerItemId: "computer-call",
					actions: [],
					pendingSafetyChecks: [{ id: "safety-check" }],
				},
			},
		} as unknown as AgentToolContext;

		await wrapper.execute("safety-first", { path: "notes.txt" }, undefined, undefined, safetyContext);
		expect(select).toHaveBeenCalledTimes(1);
		// A safety check is per-call: the prompt keeps plain Approve/Deny and records nothing.
		expect(select.mock.calls[0]![1]).toEqual(["Approve", "Deny"]);
		expect(getApprovalGrants(settings.getAgentDir(), runner.sessionId).session.size).toBe(0);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);
	});

	it("forgets session grants when a fresh instance starts, but keeps 'Always …' ones", async () => {
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		// Answer by option label: the session-scoped file answer for the first call, the
		// cross-instance one for the second.
		const picks = [APPROVAL_APPROVE_FILE_LABEL, APPROVAL_ALWAYS_FILE_LABEL];
		const select = vi.fn(async (_title: string, options: string[]) => {
			const pick = picks.shift() ?? APPROVAL_APPROVE_FILE_LABEL;
			expect(options).toContain(pick);
			return pick;
		});
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const wrapper = new ExtensionToolWrapper(pathTool("write", "write", tempDir.path()), runner);
		const dir = path.join(tempDir.path(), "TierDir");

		await wrapper.execute(
			"tier-session",
			{ path: path.join(dir, "Session.txt") },
			undefined,
			undefined,
			context(settings),
		);
		const grants = getApprovalGrants(settings.getAgentDir(), runner.sessionId);
		const sessionKey = approvalGrantKey("write", approvalTargetKey(tempDir.path(), path.join(dir, "Session.txt"))!);
		expect(grants.session.has(sessionKey)).toBe(true);

		await wrapper.execute(
			"tier-global",
			{ path: path.join(dir, "Global.txt") },
			undefined,
			undefined,
			context(settings),
		);
		const globalKey = approvalGrantKey("write", approvalTargetKey(tempDir.path(), path.join(dir, "Global.txt"))!);
		expect(readGrants(tempDir.path())).toEqual([expect.objectContaining({ key: globalKey, scope: null })]);

		// A new instance: session grants are gone, the global one still covers its file.
		__resetSessionApprovalsForTests();
		expect(grants.session.size).toBe(0);
		expect(grants.has(globalKey)).toBe(true);
		await wrapper.execute(
			"tier-global-again",
			{ path: path.join(dir, "Global.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(select).toHaveBeenCalledTimes(2);
		await wrapper.execute(
			"tier-session-again",
			{ path: path.join(dir, "Session.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(select).toHaveBeenCalledTimes(3);
	});

	it("records a directory for every session when the cross-instance directory answer is picked", async () => {
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		const select = vi.fn(async (_title: string, options: string[]) => options[2]);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "AlwaysDir");
		const wrapper = new ExtensionToolWrapper(pathTool("write", "write", tempDir.path()), runner);

		await wrapper.execute("always-dir", { path: path.join(dir, "One.txt") }, undefined, undefined, context(settings));
		expect(select.mock.calls[0]![1][2]).toBe(
			`Always Approve Directory: ${shortenPath(approvalDirectoryKey(dir).replace(/[\\/]+$/, ""))}`,
		);
		expect(readGrants(tempDir.path())).toEqual([
			expect.objectContaining({ key: approvalGrantKey("write", approvalDirectoryKey(dir)), scope: "directory" }),
		]);
		__resetSessionApprovalsForTests();
		await wrapper.execute(
			"always-dir-sibling",
			{ path: path.join(dir, "Two.txt") },
			undefined,
			undefined,
			context(settings),
		);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("leaves no grant behind when the user denies, so the next call asks again", async () => {
		const select = vi.fn(async () => "Deny");
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const wrapper = new ExtensionToolWrapper(targetTool("write_probe", "write"), runner);

		await expect(
			wrapper.execute("cached-denied", { path: "blocked.txt" }, undefined, undefined, context(settings)),
		).rejects.toThrow("denied by user");
		expect(getApprovalCache(settings.getAgentDir()).has("target:blocked.txt")).toBe(false);

		await expect(
			wrapper.execute("cached-denied-again", { path: "blocked.txt" }, undefined, undefined, context(settings)),
		).rejects.toThrow("denied by user");
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("never remembers a command by its text; only the folder answer covers exec calls", async () => {
		const select = vi.fn(async _title => APPROVAL_APPROVE_LABEL);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "ExecDir");
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "command tool",
			parameters: {} as never,
			approval: "exec",
			approvalCacheScopes: () => [approvalDirectoryKey(dir)],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);

		// A plain approval of a command records nothing: the same command asks again.
		await wrapper.execute("exec-first", { command: "npm test" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);
		await wrapper.execute("exec-again", { command: "npm test" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("lets the folder answer cover exec calls, whatever command runs there", async () => {
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		// Select hosts (RPC/ACP) answer with the option label; the first option is the folder answer.
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "ExecDir");
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "command tool",
			parameters: {} as never,
			approval: "exec",
			approvalCacheScopes: () => [approvalDirectoryKey(dir)],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute("exec-folder-answer", { command: "npm test" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]![1][0]).toBe(
			`Approve Directory: ${shortenPath(approvalDirectoryKey(dir).replace(/[\\/]+$/, ""))}`,
		);
		expect(
			getApprovalGrants(settings.getAgentDir(), runner.sessionId).session.has(
				approvalGrantKey("exec", approvalDirectoryKey(dir)),
			),
		).toBe(true);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);

		await wrapper.execute("exec-sibling", { command: "npm run build" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("does not remember a guarded command even when its folder is granted", async () => {
		const select = vi.fn(async _title => APPROVAL_APPROVE_LABEL);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		initializeRunner(runner, select);
		const settings = cachedSettings();
		const dir = path.join(tempDir.path(), "GuardedDir");
		const tool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "guarded command tool",
			parameters: {} as never,
			approval: () => ({ tier: "exec", override: true, reason: "critical pattern detected" }),
			approvalCacheScopes: () => [approvalDirectoryKey(dir)],
			execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
		};
		const wrapper = new ExtensionToolWrapper(tool, runner);

		await wrapper.execute("guarded-first", { command: "rm -rf /" }, undefined, undefined, context(settings));
		await wrapper.execute("guarded-second", { command: "rm -rf /" }, undefined, undefined, context(settings));
		expect(select).toHaveBeenCalledTimes(2);
		expect(getApprovalCache(settings.getAgentDir()).size).toBe(0);
		const [title] = select.mock.calls[0] as unknown as [string, string[]];
		expect(title).toContain("critical pattern detected");
	});
});
