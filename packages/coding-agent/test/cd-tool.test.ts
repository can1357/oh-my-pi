import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type CwdRelocationHost, relocateSessionCwd } from "@oh-my-pi/pi-coding-agent/session/cwd-relocation";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CdTool } from "@oh-my-pi/pi-coding-agent/tools/cd";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const cleanup: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
	process.chdir(originalCwd);
	for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

/** A ToolSession whose cwd change is the fake's own, so the tool's routing is under test. */
function makeToolSession(cwd: string, change?: (next: string) => Promise<string>): ToolSession {
	const state = { cwd };
	const session = {
		get cwd() {
			return state.cwd;
		},
		hasUI: false,
		settings: {} as Settings,
	} as ToolSession;
	if (change) {
		session.changeWorkingDirectory = async next => {
			state.cwd = await change(next);
			return state.cwd;
		};
	}
	return session;
}

describe("cd tool", () => {
	it("resolves a relative path against the session cwd and reports the new one", async () => {
		const root = await tempDir("omp-cd-");
		const child = path.join(root, "pkg");
		await fs.mkdir(child);
		const session = makeToolSession(root, async next => next);

		const result = await new CdTool(session).execute("call-1", { path: "pkg" });

		expect(result.isError).toBeUndefined();
		expect(result.details).toEqual({ cwd: child, previousCwd: root });
		expect(result.content[0]).toEqual({ type: "text", text: `Working directory: ${child}` });
	});

	it("rejects a missing directory without touching the session", async () => {
		const root = await tempDir("omp-cd-");
		const session = makeToolSession(root, async next => next);

		const result = await new CdTool(session).execute("call-1", { path: "nope" });

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: `No such directory: ${path.join(root, "nope")}` });
		expect(session.cwd).toBe(root);
	});

	it("rejects a path that is not a directory", async () => {
		const root = await tempDir("omp-cd-");
		await fs.writeFile(path.join(root, "file.txt"), "x");
		const session = makeToolSession(root, async next => next);

		const result = await new CdTool(session).execute("call-1", { path: "file.txt" });

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: `Not a directory: ${path.join(root, "file.txt")}` });
	});

	it("surfaces a failed relocation and keeps the previous cwd", async () => {
		const root = await tempDir("omp-cd-");
		const child = path.join(root, "pkg");
		await fs.mkdir(child);
		const session = makeToolSession(root, async () => {
			throw new Error("Cannot change working directory to /x: permission denied");
		});

		const result = await new CdTool(session).execute("call-1", { path: "pkg" });

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: "Cannot change working directory to /x: permission denied" });
		expect(session.cwd).toBe(root);
	});
});

interface FakeState {
	cwd: string;
	rollbackFails?: boolean;
	rescopeFails?: "move" | "reload";
	/** Directory whose reload throws; undefined fails every reload of the source cwd. */
	failReloadAt?: string;
}

function makeRelocationHost(state: FakeState, calls: string[]): CwdRelocationHost {
	const session = {
		get memoryEnabled() {
			return false;
		},
		async moveSession(next: string) {
			calls.push(`move:${next}`);
			if (state.rescopeFails === "move") throw new Error("move denied");
			state.cwd = next;
		},
		setTitleSystemPrompt() {},
		async refreshSkillsAndCommands() {},
		sessionManager: {
			getCwd: () => state.cwd,
			captureState: () => ({ cwd: state.cwd, sessionDir: state.cwd, sessionId: "s" }),
			async rollbackMove(snapshot: { cwd: string }) {
				calls.push(`rollback:${snapshot.cwd}`);
				if (state.rollbackFails) throw new Error("rollback denied");
				state.cwd = snapshot.cwd;
			},
		},
	};
	const settings = {
		async flush() {},
		async reloadForCwd(next: string) {
			calls.push(`reload:${next}`);
			if (state.rescopeFails === "reload" && next === state.failReloadAt) throw new Error("reload failed");
		},
	};
	return { session: session as unknown as AgentSession, settings: settings as unknown as Settings };
}

describe("relocateSessionCwd", () => {
	it("moves the session and re-scopes the process", async () => {
		const from = await tempDir("omp-cwd-");
		const to = await tempDir("omp-cwd-");
		const state: FakeState = { cwd: from };
		const calls: string[] = [];

		const result = await relocateSessionCwd(makeRelocationHost(state, calls), to);

		expect(result).toEqual({ ok: true, cwd: to, previousCwd: from, changed: true });
		expect(state.cwd).toBe(to);
		expect(process.cwd()).toBe(to);
		expect(calls).toEqual([`move:${to}`, `reload:${to}`]);
	});

	it("is a no-op when the directory is already current", async () => {
		const dir = await tempDir("omp-cwd-");
		const state: FakeState = { cwd: dir };
		const calls: string[] = [];

		const result = await relocateSessionCwd(makeRelocationHost(state, calls), path.join(dir, "."));

		expect(result).toEqual({ ok: true, cwd: dir, previousCwd: dir, changed: false });
		expect(calls).toEqual([]);
	});

	it("rolls the session and the process back when the re-scope fails", async () => {
		const from = await tempDir("omp-cwd-");
		const to = await tempDir("omp-cwd-");
		const state: FakeState = { cwd: from, rescopeFails: "reload", failReloadAt: to };
		const calls: string[] = [];

		const result = await relocateSessionCwd(makeRelocationHost(state, calls), to);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.fatal).toBe(false);
		expect(result.error).toBe(`Cannot change working directory to ${to}: reload failed`);
		expect(state.cwd).toBe(from);
		expect(process.cwd()).toBe(from);
		expect(calls).toEqual([`move:${to}`, `reload:${to}`, `rollback:${from}`, `reload:${from}`]);
	});

	it("reports a failed rollback as fatal", async () => {
		const from = await tempDir("omp-cwd-");
		const to = await tempDir("omp-cwd-");
		const state: FakeState = { cwd: from, rescopeFails: "reload", failReloadAt: to, rollbackFails: true };
		const calls: string[] = [];

		const result = await relocateSessionCwd(makeRelocationHost(state, calls), to);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.fatal).toBe(true);
		expect(result.error).toContain("rollback failed: rollback denied");
	});
});
