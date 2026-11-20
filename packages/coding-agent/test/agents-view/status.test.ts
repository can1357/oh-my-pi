import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type AgentSessionRow,
	type AgentStatusPublisher,
	type AgentStatusSource,
	collapseSessionDuplicates,
	listAgentSessions,
	resolveAgentStatus,
	startAgentStatusPublisher,
} from "@oh-my-pi/pi-coding-agent/agents-view/status";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/daemon/client";
import { processStartTime } from "@oh-my-pi/pi-coding-agent/daemon/children";
import type { DaemonClient } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { holdBlockedStatus } from "@oh-my-pi/pi-coding-agent/utils/run-status";

const cleanupDirs: string[] = [];
const publishers: AgentStatusPublisher[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
	// Tests never reach a real daemon: each stubs `probeDaemon`.
	mock.restore();
	for (const release of releases.splice(0)) release();
	for (const publisher of publishers.splice(0)) await publisher.dispose();
	for (const dir of cleanupDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agents-status-"));
	cleanupDirs.push(dir);
	return dir;
}

function fakeSession(cwd: string) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const runListeners = new Set<(state: "running" | "idle") => void>();
	const identity: {
		sessionId: string;
		sessionFile: string;
		name: string | undefined;
		branch: SessionEntry[];
	} = { sessionId: "session-1", sessionFile: path.join(cwd, "session-1.jsonl"), name: "Fix the build", branch: [] };
	const source: AgentStatusSource = {
		sessionManager: {
			getCwd: () => cwd,
			getSessionId: () => identity.sessionId,
			getSessionFile: () => identity.sessionFile,
			getSessionName: () => identity.name,
			getBranch: () => identity.branch,
		},
		model: { id: "test-model" },
		runStartedAt: undefined,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		subscribeRunState(listener) {
			runListeners.add(listener);
			return () => runListeners.delete(listener);
		},
	};
	return {
		source,
		identity,
		emit(event: AgentSessionEvent): void {
			for (const listener of listeners) listener(event);
		},
		setRunState(state: "running" | "idle"): void {
			for (const listener of runListeners) listener(state);
		},
	};
}

async function publish(dir: string, source: AgentStatusSource): Promise<AgentStatusPublisher> {
	const publisher = startAgentStatusPublisher(source, { dir });
	publishers.push(publisher);
	await publisher.flush();
	return publisher;
}

/** The single row listed from `dir`, with the daemon reported absent. */
async function onlyRow(dir: string) {
	const rows = await listAgentSessions({ dir });
	expect(rows).toHaveLength(1);
	return rows[0];
}

function failedTurn(errorMessage: string): AgentMessage[] {
	return [{ role: "assistant", content: [], stopReason: "error", errorMessage } as unknown as AgentMessage];
}

describe("agent status", () => {
	function noDaemon(): void {
		spyOn(daemonClient, "probeDaemon").mockResolvedValue(undefined);
	}

	it("resolves waiting > compacting > error > running > idle", () => {
		const blocked = { state: "blocked", kind: "question", msg: "Some context\n\nWhich branch?" } as const;
		const all = { blocked, compacting: true, failed: true, errorText: "boom", running: true, tool: "bash" };
		expect(resolveAgentStatus(all)).toEqual({ status: "waiting", detail: "Which branch?" });
		expect(resolveAgentStatus({ ...all, blocked: undefined }).status).toBe("compacting");
		expect(resolveAgentStatus({ ...all, blocked: undefined, compacting: false })).toEqual({
			status: "error",
			detail: "boom",
		});
		expect(resolveAgentStatus({ ...all, blocked: undefined, compacting: false, failed: false })).toEqual({
			status: "running",
			detail: "bash",
		});
		expect(resolveAgentStatus({ compacting: false, failed: false, running: false }).status).toBe("idle");
		// Approvals name the tool from the prompt's title line, not the prompt body.
		const approval = { state: "blocked", kind: "permission", msg: "Allow tool: edit\nPath: a.ts" } as const;
		expect(resolveAgentStatus({ ...all, blocked: approval }).detail).toBe("approval: edit");
	});

	it("publishes a timed dialog as waiting while it is open", async () => {
		noDaemon();
		const dir = await tempDir();
		const fake = fakeSession(dir);
		const publisher = await publish(dir, fake.source);
		fake.setRunState("running");
		// A deadline-bound ask (`ask.timeout`) is presented through the same hold as any other dialog.
		const release = holdBlockedStatus({ state: "blocked", kind: "question", msg: "Deploy now? (30s)" });
		releases.push(release);
		await publisher.flush();
		expect(await onlyRow(dir)).toMatchObject({ status: "waiting", detail: "Deploy now? (30s)" });

		release();
		await publisher.flush();
		expect((await onlyRow(dir)).status).toBe("running");
	});

	it("sets error on a failed run end and clears it when the next run starts", async () => {
		noDaemon();
		const dir = await tempDir();
		const fake = fakeSession(dir);
		const publisher = await publish(dir, fake.source);
		fake.setRunState("running");
		fake.setRunState("idle");
		fake.emit({ type: "agent_end", messages: failedTurn("rate limited") });
		await publisher.flush();
		expect(await onlyRow(dir)).toMatchObject({ status: "error", detail: "rate limited" });

		fake.emit({ type: "agent_start" } as AgentSessionEvent);
		fake.setRunState("running");
		await publisher.flush();
		expect((await onlyRow(dir)).status).toBe("running");
	});

	it("rewrites the record's session identity after a session switch", async () => {
		noDaemon();
		const dir = await tempDir();
		const fake = fakeSession(dir);
		const publisher = await publish(dir, fake.source);
		expect((await onlyRow(dir)).sessionId).toBe("session-1");

		fake.identity.sessionId = "session-2";
		fake.identity.sessionFile = path.join(dir, "session-2.jsonl");
		fake.emit({ type: "queue_update", steering: [], followUp: [], liveSteered: 0 });
		await publisher.flush();
		expect(await onlyRow(dir)).toMatchObject({
			sessionId: "session-2",
			sessionFile: path.join(dir, "session-2.jsonl"),
		});
	});

	it("titles an unnamed session by its first prompt, then by its name once it has one", async () => {
		noDaemon();
		const dir = await tempDir();
		const fake = fakeSession(dir);
		fake.identity.name = undefined;
		const publisher = await publish(dir, fake.source);
		expect((await onlyRow(dir)).title).toStartWith("Untitled · ");

		fake.identity.branch = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "refactor\nthe parser", timestamp: Date.now() },
			} as SessionEntry,
		];
		fake.emit({ type: "queue_update", steering: [], followUp: [], liveSteered: 0 });
		await publisher.flush();
		expect((await onlyRow(dir)).title).toBe("refactor the parser");

		fake.identity.name = "Parser refactor";
		fake.emit({ type: "queue_update", steering: [], followUp: [], liveSteered: 0 });
		await publisher.flush();
		expect((await onlyRow(dir)).title).toBe("Parser refactor");
	});

	it("removes the record on dispose", async () => {
		noDaemon();
		const dir = await tempDir();
		const publisher = await publish(dir, fakeSession(dir).source);
		await publisher.dispose();
		expect(await fs.readdir(dir)).toEqual([]);
	});

	it("prunes records of exited processes and of reused pids", async () => {
		noDaemon();
		const dir = await tempDir();
		await fs.chmod(dir, 0o700);
		const exited = Bun.spawn(["true"]);
		await exited.exited;
		const startedAt = processStartTime(process.pid);
		if (startedAt === undefined) throw new Error("own process start time unavailable");
		const record = (instanceId: string, pid: number, pidStartedAt: number) => ({
			v: 1,
			instanceId,
			pid,
			pidStartedAt,
			sessionId: "s",
			title: "t",
			cwd: dir,
			status: "idle",
			lastActivityAt: 1,
			startedAt: 1,
			updatedAt: 1,
		});
		const dead = "a".repeat(32);
		const reused = "b".repeat(32);
		const live = "c".repeat(32);
		await Bun.write(path.join(dir, `${dead}.json`), JSON.stringify(record(dead, exited.pid, startedAt)));
		// Same pid as a live process, but started a minute earlier: the pid was reused.
		await Bun.write(
			path.join(dir, `${reused}.json`),
			JSON.stringify(record(reused, process.pid, startedAt - 60_000)),
		);
		await Bun.write(path.join(dir, `${live}.json`), JSON.stringify(record(live, process.pid, startedAt)));

		const rows = await listAgentSessions({ dir });
		expect(rows.map(row => row.instanceId)).toEqual([live]);
		expect(await fs.readdir(dir)).toEqual([`${live}.json`]);
	});

	it("lists hosted units without a record as starting and marks hosted records attachable", async () => {
		const dir = await tempDir();
		const fake = fakeSession(dir);
		const publisher = startAgentStatusPublisher(fake.source, { dir, hostKey: "agent-published" });
		publishers.push(publisher);
		await publisher.flush();
		const unit = (key: string, state: string) => ({
			id: key,
			kind: "proc",
			scope: { kind: "global" },
			key,
			label: key,
			generation: "1",
			state,
			pids: [1],
			createdAt: 5,
			startedAt: 5,
			restartCount: 0,
			outputBytes: 0,
			leases: 0,
			policy: {},
			cwd: dir,
			supervised: true,
		});
		const client = {
			request: async () => ({
				units: [unit("agent-published", "running"), unit("agent-new", "starting"), unit("agent-gone", "exited")],
			}),
			close: () => {},
		};
		spyOn(daemonClient, "probeDaemon").mockResolvedValue(client as unknown as DaemonClient);

		const rows = await listAgentSessions({ dir, cwd: dir });
		expect(rows.map(row => [row.hostKey, row.status, row.attachable])).toEqual([
			["agent-new", "starting", true],
			["agent-published", "idle", true],
		]);
		expect(await listAgentSessions({ dir, cwd: path.join(dir, "elsewhere") })).toEqual([]);
	});
});

describe("collapseSessionDuplicates", () => {
	const base = { title: "deneme", cwd: "/work", status: "idle" as const, startedAt: 1 };
	const sessionRow = (overrides: Partial<AgentSessionRow>): AgentSessionRow => ({
		...base,
		attachable: true,
		lastActivityAt: 0,
		...overrides,
	});

	it("shows one row per session: the attachable one wins over a fresher foreground one and carries the other units", () => {
		const fresherForeground = sessionRow({ instanceId: "a", sessionId: "s1", attachable: false, lastActivityAt: 900 });
		const olderHosted = sessionRow({ instanceId: "b", sessionId: "s1", hostKey: "agent-b", lastActivityAt: 100 });
		const newerHosted = sessionRow({ instanceId: "c", sessionId: "s1", hostKey: "agent-c", lastActivityAt: 500 });
		const unrelated = sessionRow({ instanceId: "d", sessionId: "s2", hostKey: "agent-d" });
		const starting = sessionRow({ hostKey: "agent-e", status: "starting" });

		const rows = collapseSessionDuplicates([fresherForeground, olderHosted, unrelated, newerHosted, starting]);

		expect(rows.map(row => row.instanceId ?? row.hostKey)).toEqual(["d", "c", "agent-e"]);
		expect(rows[1].duplicateHostKeys).toEqual(["agent-b"]);
		expect(rows[0].duplicateHostKeys).toBeUndefined();
	});

	it("among non-attachable duplicates keeps the most recently active one", () => {
		const older = sessionRow({ instanceId: "a", sessionId: "s1", attachable: false, lastActivityAt: 1 });
		const newer = sessionRow({ instanceId: "b", sessionId: "s1", attachable: false, lastActivityAt: 2 });
		expect(collapseSessionDuplicates([older, newer]).map(row => row.instanceId)).toEqual(["b"]);
	});
});
