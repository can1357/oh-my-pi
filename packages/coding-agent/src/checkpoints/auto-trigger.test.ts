import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import * as lspClient from "../lsp/client";
import {
	countEditFiles,
	emitInternalBeforeToolCall,
	matchDestructiveGit,
	RISKY_EDIT_FILE_THRESHOLD,
	registerAutoCheckpoints,
} from "./auto-trigger";
import { emitWorkspaceRolledBack, onWorkspaceRolledBack } from "./notify";
import type { WorkspaceCheckpointService } from "./service";
import type { CheckpointMeta } from "./types";

// ── spy seams (namespace-import + spyOn; never vi.mock — it leaks across files) ─

interface AutoTriggerTestMocks {
	invalidateFsScanCache?: Mock<(path?: string | null) => void>;
	notifyWorkspaceWatchedFiles?: Mock<
		(cwd: string, changes: readonly lspClient.WatchedFileChange[], signal?: AbortSignal) => Promise<void>
	>;
	settingsStore?: Record<string, unknown>;
	settingsInitialized?: boolean;
}

function mocks(): AutoTriggerTestMocks {
	const g = globalThis as unknown as { __autoTriggerTest?: AutoTriggerTestMocks };
	g.__autoTriggerTest ??= {};
	return g.__autoTriggerTest;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const fakeMeta = {
	id: "abc12",
	sessionId: "s1",
	createdAt: new Date().toISOString(),
	reason: "pre-rollback",
	identity: { repoRoot: "/wt", worktreePath: "/wt", headSha: "x", branch: "main" },
	treeSha: "t",
	headShaAtCapture: "x",
	refName: "refs/omp/checkpoints/s1/abc12",
	metaPath: "/wt/meta",
	bytesCaptured: 0,
	skippedFiles: [],
} as unknown as CheckpointMeta;

function makeFakeService(
	overrides: { create?: () => Promise<CheckpointMeta>; latest?: () => Promise<CheckpointMeta | undefined> } = {},
): WorkspaceCheckpointService {
	return {
		create: vi.fn(overrides.create ?? (async () => fakeMeta)),
		latest: vi.fn(overrides.latest ?? (async () => undefined)),
	} as unknown as WorkspaceCheckpointService;
}

const patchWithFiles = (n: number): string =>
	`*** Begin Patch\n` +
	Array.from({ length: n }, (_, i) => `*** Update File: file${i}.ts\n@@\n-x\n+y\n`).join("") +
	`*** End Patch`;

const unsubs: (() => void)[] = [];
afterEach(() => {
	for (const u of unsubs) u();
	unsubs.length = 0;
	vi.restoreAllMocks();
});

beforeEach(() => {
	const store = mocks();
	store.invalidateFsScanCache = vi.spyOn(natives, "invalidateFsScanCache").mockImplementation(async () => {});
	store.notifyWorkspaceWatchedFiles = vi
		.spyOn(lspClient, "notifyWorkspaceWatchedFiles")
		.mockImplementation(async () => {});
});

// ── destructive git matcher ───────────────────────────────────────────────────

describe("matchDestructiveGit", () => {
	test("matches the documented destructive shapes", () => {
		expect(matchDestructiveGit("git reset --hard")?.verb).toBe("reset");
		expect(matchDestructiveGit("git reset --hard HEAD~1")?.verb).toBe("reset");
		expect(matchDestructiveGit("git clean -f")?.verb).toBe("clean");
		expect(matchDestructiveGit("git clean -fd")?.verb).toBe("clean");
		expect(matchDestructiveGit("git clean -fdx")?.verb).toBe("clean");
		expect(matchDestructiveGit("git restore .")?.verb).toBe("restore");
		expect(matchDestructiveGit("git restore --staged .")?.verb).toBe("restore");
		expect(matchDestructiveGit("git checkout -- .")?.verb).toBe("checkout");
		expect(matchDestructiveGit("git checkout .")?.verb).toBe("checkout");
		expect(matchDestructiveGit("git push --force")?.verb).toBe("push");
		expect(matchDestructiveGit("git branch -D stale")?.verb).toBe("branch");
		expect(matchDestructiveGit("git rebase main")?.verb).toBe("rebase");
		expect(matchDestructiveGit("git rebase -i main")?.verb).toBe("rebase");
	});

	test("does NOT match safe or scoped variants (false-positive guards)", () => {
		expect(matchDestructiveGit("git reset --soft HEAD")).toBeUndefined();
		expect(matchDestructiveGit("git reset HEAD file.ts")).toBeUndefined();
		expect(matchDestructiveGit("git clean -n")).toBeUndefined();
		expect(matchDestructiveGit("git clean -nf")).toBeUndefined();
		expect(matchDestructiveGit("git restore --staged file.ts")).toBeUndefined();
		expect(matchDestructiveGit("git restore file.ts")).toBeUndefined();
		expect(matchDestructiveGit("git checkout -- file.ts")).toBeUndefined();
		expect(matchDestructiveGit("git checkout main")).toBeUndefined();
		expect(matchDestructiveGit("git checkout a1b2c3d4")).toBeUndefined();
		expect(matchDestructiveGit("git push --force-with-lease")).toBeUndefined();
		expect(matchDestructiveGit("git push --force-with-lease origin main")).toBeUndefined();
		expect(matchDestructiveGit("git branch -d stale")).toBeUndefined();
		expect(matchDestructiveGit("git rebase --abort")).toBeUndefined();
		expect(matchDestructiveGit("git rebase --continue")).toBeUndefined();
		expect(matchDestructiveGit("rm -rf build")).toBeUndefined();
		expect(matchDestructiveGit("")).toBeUndefined();
	});
});

// ── risky-edit file counter ───────────────────────────────────────────────────

describe("countEditFiles", () => {
	test("counts apply_patch file markers, treats other modes as single-file", () => {
		expect(countEditFiles("edit", { input: patchWithFiles(5) })).toBe(5);
		expect(countEditFiles("edit", { input: patchWithFiles(1) })).toBe(1);
		expect(countEditFiles("edit", { input: "no markers here" })).toBe(0);
		expect(countEditFiles("edit", { path: "src/a.ts", edits: [{ op: "update" }] })).toBe(1);
		expect(countEditFiles("read", { input: patchWithFiles(9) })).toBe(0);
		expect(countEditFiles("edit", null)).toBe(0);
	});
});

// ── gitOperations + riskyEdits triggers ───────────────────────────────────────

describe("auto-checkpoint before-tool triggers", () => {
	test("gitOperations captures a reason='auto' checkpoint BEFORE the command proceeds", async () => {
		const order: string[] = [];
		const service = makeFakeService({
			create: async () => {
				order.push("create");
				return fakeMeta;
			},
		});
		unsubs.push(
			registerAutoCheckpoints({
				getService: () => service,
				flags: { enabled: () => true, gitOperations: () => true },
			}),
		);

		await emitInternalBeforeToolCall({
			toolName: "bash",
			args: { command: "git reset --hard" },
			cwd: "/wt",
			sessionId: "s1",
		});
		order.push("proceed");

		expect(order).toEqual(["create", "proceed"]);
		expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ reason: "auto", label: "before reset" }));
	});

	test("gates off produce zero service calls", async () => {
		const service = makeFakeService();
		unsubs.push(
			registerAutoCheckpoints({
				getService: () => service,
				flags: { enabled: () => false, gitOperations: () => true },
			}),
		);
		await emitInternalBeforeToolCall({
			toolName: "bash",
			args: { command: "git reset --hard" },
			cwd: "/wt",
			sessionId: "s1",
		});
		expect(service.create).not.toHaveBeenCalled();

		unsubs.pop()?.();
		unsubs.push(
			registerAutoCheckpoints({
				getService: () => service,
				flags: { enabled: () => true, gitOperations: () => false },
			}),
		);
		await emitInternalBeforeToolCall({
			toolName: "bash",
			args: { command: "git clean -f" },
			cwd: "/wt",
			sessionId: "s1",
		});
		expect(service.create).not.toHaveBeenCalled();
	});

	test("a capture failure does not throw out of the hook path", async () => {
		const service = makeFakeService({
			create: async () => {
				throw new Error("disk full");
			},
		});
		unsubs.push(
			registerAutoCheckpoints({
				getService: () => service,
				flags: { enabled: () => true, gitOperations: () => true },
			}),
		);

		await expect(
			emitInternalBeforeToolCall({
				toolName: "bash",
				args: { command: "git reset --hard" },
				cwd: "/wt",
				sessionId: "s1",
			}),
		).resolves.toBeUndefined();
		expect(service.create).toHaveBeenCalled();
	});

	test("debounce: a recent auto checkpoint suppresses a new capture; an old one does not", async () => {
		const recent = makeFakeService({
			latest: async () => ({ ...fakeMeta, reason: "auto", createdAt: new Date().toISOString() }),
		});
		unsubs.push(
			registerAutoCheckpoints({
				getSessionId: () => "s1",
				getCwd: () => "/wt",
				getService: () => recent,
				flags: { enabled: () => true, gitOperations: () => true },
			}),
		);
		await emitInternalBeforeToolCall({
			toolName: "bash",
			args: { command: "git reset --hard" },
			cwd: "/wt",
			sessionId: "s1",
		});
		expect(recent.create).not.toHaveBeenCalled();
		unsubs.pop()?.();

		const old = makeFakeService({
			latest: async () => ({ ...fakeMeta, reason: "auto", createdAt: new Date(Date.now() - 120_000).toISOString() }),
		});
		unsubs.push(
			registerAutoCheckpoints({ getService: () => old, flags: { enabled: () => true, gitOperations: () => true } }),
		);
		await emitInternalBeforeToolCall({
			toolName: "bash",
			args: { command: "git reset --hard" },
			cwd: "/wt",
			sessionId: "s1",
		});
		expect(old.create).toHaveBeenCalled();
	});

	test("riskyEdits fires at the boundary: 4 files no, 5 files yes", async () => {
		const service = makeFakeService();
		unsubs.push(
			registerAutoCheckpoints({ getService: () => service, flags: { enabled: () => true, riskyEdits: () => true } }),
		);

		await emitInternalBeforeToolCall({
			toolName: "edit",
			args: { input: patchWithFiles(4) },
			cwd: "/wt",
			sessionId: "s1",
		});
		expect(service.create).not.toHaveBeenCalled();

		await emitInternalBeforeToolCall({
			toolName: "edit",
			args: { input: patchWithFiles(5) },
			cwd: "/wt",
			sessionId: "s1",
		});
		expect(service.create).toHaveBeenCalledTimes(1);
		expect(service.create).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "auto", label: `before ${RISKY_EDIT_FILE_THRESHOLD}-file edit` }),
		);
	});

	test("riskyEdits does not fire without the flag, even for many files", async () => {
		const service = makeFakeService();
		unsubs.push(
			registerAutoCheckpoints({
				getService: () => service,
				flags: { enabled: () => false, riskyEdits: () => true },
			}),
		);

		await emitInternalBeforeToolCall({
			toolName: "edit",
			args: { input: patchWithFiles(8) },
			cwd: "/wt",
			sessionId: "s1",
		});
		expect(service.create).not.toHaveBeenCalled();
	});
});

// ── post-rollback invalidation fan-out ────────────────────────────────────────

describe("post-rollback cache/LSP invalidation", () => {
	test("fans out to fs-cache invalidate and LSP refresh for the workspace root", () => {
		unsubs.push(
			registerAutoCheckpoints({
				getSessionId: () => "s1",
				getCwd: () => "/wt",
				getService: () => makeFakeService(),
			}),
		);

		emitWorkspaceRolledBack(undefined, fakeMeta);

		expect(mocks().invalidateFsScanCache).toHaveBeenCalledWith("/wt");
		expect(mocks().notifyWorkspaceWatchedFiles).toHaveBeenCalledWith(
			"/wt",
			expect.arrayContaining([{ filePath: "/wt", type: 2 }]),
		);
	});

	test("a throwing listener is isolated and does not prevent other listeners", () => {
		// Register the throwing listener BEFORE the auto-checkpoint one to prove
		// order independence: notify isolates every listener.
		unsubs.push(
			onWorkspaceRolledBack(() => {
				throw new Error("boom");
			}),
		);
		unsubs.push(
			registerAutoCheckpoints({
				getSessionId: () => "s1",
				getCwd: () => "/wt",
				getService: () => makeFakeService(),
			}),
		);

		expect(() => emitWorkspaceRolledBack(undefined, fakeMeta)).not.toThrow();
		expect(mocks().invalidateFsScanCache).toHaveBeenCalledWith("/wt");
		expect(mocks().notifyWorkspaceWatchedFiles).toHaveBeenCalled();
	});
});
