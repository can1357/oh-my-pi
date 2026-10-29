import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { borrowVmContext, disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { setSupersededKernelGraceMs } from "../../src/eval/superseded-reclaim";
import { AgentOutputManager } from "../../src/task/output-manager";
import type { ToolSession } from "../../src/tools";

// The reclaim is deliberately deferred, so these exercise a real timer. The
// grace is shortened to milliseconds, which is the behaviour under test.
const TEST_GRACE_MS = 50;

/** A session shaped as the executor consumes it: settings, jobs and a session file. */
function makeSession(cwd: string, sessionFile: string): ToolSession {
	const artifactsDir = sessionFile.slice(0, -6);
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false }),
		asyncJobManager: new AsyncJobManager({}),
		taskDepth: 0,
		enableLsp: false,
		agentOutputManager: new AgentOutputManager(() => artifactsDir),
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
	};
}

/**
 * Worker identity as the kernel itself sees it: a fresh context answers with a
 * new id, a retained one answers with the id it was given.
 */
async function contextId(cwd: string, sessionId: string, ownerId: string): Promise<string> {
	const sessionFile = path.join(cwd, "session.jsonl");
	const result = await executeJs(
		"globalThis.__contextMark ??= `ctx-${Math.random()}`; return globalThis.__contextMark;",
		{ cwd, sessionId, kernelOwnerId: ownerId, session: makeSession(cwd, sessionFile), timeoutMs: 30_000 },
	);
	if (result.exitCode !== 0) throw new Error(`cell failed: ${result.output}`);
	return result.output.trim();
}

describe("superseded JavaScript contexts", () => {
	afterEach(async () => {
		setSupersededKernelGraceMs();
		await disposeAllVmContexts();
	});

	it("drops the context a session leaves behind when its next cell runs under another key", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-superseded-a-");
		using secondDir = TempDir.createSync("@js-superseded-b-");
		const owner = "agent-session:js-superseded";
		const first = await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner);
		await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);

		// Past the grace, returning to the first key must answer from a fresh
		// context: the retained one was shut down rather than kept for the life
		// of the host process.
		await Bun.sleep(TEST_GRACE_MS * 8);
		expect(await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner)).not.toBe(first);
	}, 60_000);

	it("keeps the context and its globals when the session returns inside the grace", async () => {
		setSupersededKernelGraceMs(60_000);
		using firstDir = TempDir.createSync("@js-roundtrip-a-");
		using secondDir = TempDir.createSync("@js-roundtrip-b-");
		const owner = "agent-session:js-roundtrip";
		const first = await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner);
		await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);
		expect(await contextId(firstDir.path(), `js:cwd:${firstDir.path()}`, owner)).toBe(first);
	}, 60_000);

	it("keeps a context a second agent still holds", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using sharedDir = TempDir.createSync("@js-shared-a-");
		using otherDir = TempDir.createSync("@js-shared-b-");
		const sessionId = `js:cwd:${sharedDir.path()}`;
		const first = await contextId(sharedDir.path(), sessionId, "agent-session:js-one");
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-two")).toBe(first);

		await contextId(otherDir.path(), `js:cwd:${otherDir.path()}`, "agent-session:js-one");
		await Bun.sleep(TEST_GRACE_MS * 8);
		expect(await contextId(sharedDir.path(), sessionId, "agent-session:js-two")).toBe(first);
	}, 60_000);

	it("keeps a context a borrower still holds past the grace", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-borrow-a-");
		using secondDir = TempDir.createSync("@js-borrow-b-");
		const owner = "agent-session:js-borrow";
		const firstKey = `js:cwd:${firstDir.path()}`;
		const first = await contextId(firstDir.path(), firstKey, owner);

		// A subagent given this kernel's tools can call them between cells, so
		// it holds the context even while its owner runs elsewhere.
		const release = borrowVmContext(firstKey);
		await contextId(secondDir.path(), `js:cwd:${secondDir.path()}`, owner);
		await Bun.sleep(TEST_GRACE_MS * 8);
		expect(await contextId(firstDir.path(), firstKey, owner)).toBe(first);
		release();
	}, 60_000);
});
