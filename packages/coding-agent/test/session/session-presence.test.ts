/**
 * Session presence registry: publishing, liveness pruning, holder lookup, and
 * record lifecycle. Each test uses its own `dir` so nothing touches the real
 * agent directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	findSessionHolder,
	listLiveSessionPresence,
	type SessionPresence,
	SessionPresencePublisher,
	type SessionPresenceKind,
} from "@oh-my-pi/pi-coding-agent/session/session-presence";
import { processStartToken } from "@oh-my-pi/pi-coding-agent/utils/process-start-token";
import { __resetDirsFromEnvForTests, getSessionPresenceDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

interface RawPresenceRecord {
	version: number;
	pid: number;
	startToken: string | null;
	kind: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	sessionName: string | null;
	startedAt: number;
	updatedAt: number;
}

async function makeTempDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "omp-presence-"));
}

function rawRecord(over: Partial<RawPresenceRecord> = {}): RawPresenceRecord {
	return {
		version: 1,
		pid: process.pid,
		startToken: null,
		kind: "telegram",
		sessionId: "raw",
		sessionFile: "/tmp/raw.jsonl",
		cwd: "/tmp",
		sessionName: null,
		startedAt: 1,
		updatedAt: 2,
		...over,
	};
}

async function writeRecord(dir: string, name: string, record: RawPresenceRecord): Promise<void> {
	await fs.writeFile(path.join(dir, name), `${JSON.stringify(record)}\n`);
}

/** A pid that has definitely exited (no recycling window on a fresh spawn). */
async function exitedPid(): Promise<number> {
	const child = Bun.spawn(["true"]);
	await child.exited;
	return child.pid;
}

function publisherFor(
	dir: string,
	sessionFile: string,
	over: Partial<{ kind: SessionPresenceKind; sessionId: string; sessionName: string | null }> = {},
): SessionPresencePublisher {
	return new SessionPresencePublisher(
		{
			kind: over.kind ?? "interactive",
			sessionId: over.sessionId ?? "sess-1",
			sessionFile,
			cwd: "/work",
			sessionName: over.sessionName ?? null,
		},
		{ dir },
	);
}

describe("session presence publication", () => {
	it("lists a published session with an absolute file path, owner-only files, and removes it on dispose", async () => {
		const dir = await makeTempDir();
		await fs.chmod(dir, 0o755);
		const relativeFile = "relative-session.jsonl";
		const publisher = publisherFor(dir, relativeFile, { kind: "telegram", sessionName: "topic" });

		publisher.publish();
		await publisher.settled();

		const live = await listLiveSessionPresence({ dir });
		expect(live).toHaveLength(1);
		expect(live[0]).toMatchObject({
			pid: process.pid,
			kind: "telegram",
			sessionId: "sess-1",
			cwd: "/work",
			sessionName: "topic",
		});
		expect(live[0]!.sessionFile).toBe(path.resolve(relativeFile));
		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(publisher.file)).mode & 0o777).toBe(0o600);

		publisher.remove();
		await publisher.settled();

		expect(await listLiveSessionPresence({ dir })).toEqual([]);
		expect(await Bun.file(publisher.file).exists()).toBe(false);
	});

	it("moves the record on a session switch and rewrites it in place on rename", async () => {
		const dir = await makeTempDir();
		const firstFile = path.join(dir, "first.jsonl");
		const secondFile = path.join(dir, "second.jsonl");
		const publisher = publisherFor(dir, firstFile, { kind: "interactive", sessionName: "before" });
		publisher.publish();
		await publisher.settled();
		const firstRecord = publisher.file;

		publisher.update({ sessionId: "sess-2", sessionFile: secondFile, sessionName: "after" });
		await publisher.settled();

		const moved = await listLiveSessionPresence({ dir });
		expect(moved).toHaveLength(1);
		expect(moved[0]).toMatchObject({ sessionId: "sess-2", sessionFile: secondFile, sessionName: "after" });
		expect(await Bun.file(firstRecord).exists()).toBe(false);
		expect(publisher.file).not.toBe(firstRecord);

		// A rename keeps the same session identity: same record file, new name.
		const recordAfterMove = publisher.file;
		publisher.update({ sessionName: "renamed" });
		await publisher.settled();
		expect(publisher.file).toBe(recordAfterMove);
		expect((await listLiveSessionPresence({ dir }))[0]?.sessionName).toBe("renamed");

		publisher.remove();
		await publisher.settled();
		expect(await listLiveSessionPresence({ dir })).toEqual([]);
	});
});

describe("session presence liveness", () => {
	it("prunes a dead pid and keeps a live record", async () => {
		const dir = await makeTempDir();
		const dead = await exitedPid();
		await writeRecord(dir, "dead.json", rawRecord({ pid: dead, sessionId: "dead" }));
		await writeRecord(dir, "malformed.json", rawRecord({ kind: "bogus", sessionId: "bad" }));
		await writeRecord(dir, "live.json", rawRecord({ pid: process.pid, sessionId: "live" }));
		await Bun.write(path.join(dir, "leftover.tmp"), "partial");

		const live = await listLiveSessionPresence({ dir });

		expect(live.map(entry => entry.sessionId)).toEqual(["live"]);
		expect(await Bun.file(path.join(dir, "dead.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "malformed.json")).exists()).toBe(false);
		// A record still being written (temp suffix) is never parsed as a session.
		expect(await Bun.file(path.join(dir, "live.json")).exists()).toBe(true);
	});

	it("prunes a record whose start token no longer matches its pid", async () => {
		const realToken = await processStartToken(process.pid);
		if (realToken === null) return; // platform cannot report process start tokens

		const dir = await makeTempDir();
		const recordFile = path.join(dir, "recycled.json");
		await writeRecord(dir, "recycled.json", rawRecord({ pid: process.pid, startToken: `${realToken}-stale` }));

		expect(await listLiveSessionPresence({ dir })).toEqual([]);
		expect(await Bun.file(recordFile).exists()).toBe(false);
	});
});

describe("findSessionHolder", () => {
	it("matches by absolute session file and can exclude the caller's own process", async () => {
		const dir = await makeTempDir();
		const firstFile = path.join(dir, "first.jsonl");
		const secondFile = path.join(dir, "second.jsonl");
		const first = publisherFor(dir, firstFile, { sessionId: "first" });
		const second = publisherFor(dir, secondFile, { sessionId: "second" });
		first.publish();
		second.publish();
		await first.settled();
		await second.settled();

		expect(await findSessionHolder(firstFile, { dir })).toMatchObject({ sessionId: "first" });
		expect(await findSessionHolder(secondFile, { dir })).toMatchObject({ sessionId: "second" });
		expect(await findSessionHolder(path.join(dir, "nobody.jsonl"), { dir })).toBeNull();
		expect(await findSessionHolder(firstFile, { exceptPid: process.pid, dir })).toBeNull();
		expect(await findSessionHolder(firstFile, { exceptPid: 999_999, dir })).toMatchObject({ sessionId: "first" });

		first.remove();
		second.remove();
		await first.settled();
		await second.settled();
	});
});

describe("session presence directory errors", () => {
	it("treats a missing directory as empty and rejects when it cannot be read", async () => {
		const dir = await makeTempDir();
		expect(await listLiveSessionPresence({ dir: path.join(dir, "absent") })).toEqual([]);

		const filePath = path.join(dir, "not-a-directory");
		await fs.writeFile(filePath, "x");
		await expect(listLiveSessionPresence({ dir: filePath })).rejects.toThrow();
		await expect(findSessionHolder("/tmp/x.jsonl", { dir: filePath })).rejects.toThrow();
	});
});

/**
 * Publishing is opt-in at the SDK boundary: `createAgentSession` writes a
 * record only when the caller names a kind, so `omp -p`, ACP, RPC and
 * third-party embedders never touch the registry that the interactive TUI and
 * the Telegram bridge populate.
 */
describe("session presence is opt-in", () => {
	let root = "";
	let cwd = "";
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		root = await makeTempDir();
		cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		// The publisher resolves its directory from the global agent dir, so the
		// test points that at the temp root: nothing may reach `~/.omp`.
		setAgentDir(path.join(root, "agent"));
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		__resetDirsFromEnvForTests();
		await fs.rm(root, { recursive: true, force: true });
	});

	async function createSession(agentId: string, presenceKind?: SessionPresenceKind): Promise<AgentSession> {
		const options: CreateAgentSessionOptions = {
			cwd,
			agentDir: path.join(root, "agent"),
			authStorage,
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.create(cwd),
			agentRegistry: new AgentRegistry(),
			agentId,
			expectedAgentRef: null,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		};
		if (presenceKind !== undefined) options.presenceKind = presenceKind;
		const { session } = await createAgentSession(options);
		sessions.push(session);
		return session;
	}

	/**
	 * Live records once `done` accepts a listing, woken by the real filesystem
	 * event rather than a sleep: `publish()` is fire-and-forget, so there is no
	 * promise to await. The watcher is registered before the first listing, so a
	 * write landing in between still fires an event.
	 */
	async function livePresenceUntil(
		dir: string,
		done: (live: readonly SessionPresence[]) => boolean,
	): Promise<SessionPresence[]> {
		const waiters: Array<() => void> = [];
		const watcher = watch(dir, () => {
			for (const resolve of waiters.splice(0)) resolve();
		});
		try {
			for (;;) {
				const live = await listLiveSessionPresence({ dir });
				if (done(live)) return live;
				const { promise, resolve } = Promise.withResolvers<void>();
				waiters.push(resolve);
				await promise;
			}
		} finally {
			watcher.close();
		}
	}

	it("publishes only the session that passed a kind, and drops it on dispose", async () => {
		const dir = getSessionPresenceDir();
		// An existing, empty registry: the absence below is a record that was not
		// written, not a directory that does not exist.
		await fs.mkdir(dir, { recursive: true });

		const plain = await createSession("presence-plain");
		const telegram = await createSession("presence-telegram", "telegram");
		const plainFile = plain.sessionFile;
		const telegramFile = telegram.sessionFile;
		if (plainFile === undefined || telegramFile === undefined) throw new Error("expected file-backed sessions");

		// The Telegram record is the control: its publish was queued after the
		// plain session's would have been, so a plain session that published is on
		// disk by the time this returns. A fresh listing then settles the state.
		await livePresenceUntil(dir, entries => entries.some(entry => entry.sessionFile === telegramFile));
		const live = await listLiveSessionPresence({ dir });
		expect(live).toHaveLength(1);
		expect(live[0]).toMatchObject({ kind: "telegram", pid: process.pid });
		expect(live[0]!.sessionFile).toBe(telegramFile);
		expect(live[0]!.sessionFile).not.toBe(plainFile);
		expect(await findSessionHolder(plainFile, { dir })).toBeNull();

		await telegram.dispose();
		expect(await listLiveSessionPresence({ dir })).toEqual([]);
	});
});
