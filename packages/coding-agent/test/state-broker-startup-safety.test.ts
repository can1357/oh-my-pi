/**
 * Regressions for the three boundaries where replication meets process
 * lifecycle: the launch path reading replicated state before it has arrived, a
 * peer-supplied index row naming a path outside the sessions dir, and detached
 * blob uploads abandoned by a failure or an exit.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { deletePickedSession } from "@oh-my-pi/pi-coding-agent/cli/session-picker";
import { ProjectsConfigFile, getProjectsConfigPath, saveProjects } from "@oh-my-pi/pi-coding-agent/config/projects-config";
import { drainBlobUploads } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { mergeRemoteOnlySessions, resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { sessionDirNameForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { StateBrokerClient } from "@oh-my-pi/pi-coding-agent/state-broker/client";
import { createSessionsDomain, readRemoteSessionIndex } from "@oh-my-pi/pi-coding-agent/state-broker/domains/sessions";
import type { ObjectStore } from "@oh-my-pi/pi-coding-agent/state-broker/object-store";
import { invalidateProjectScope } from "@oh-my-pi/pi-coding-agent/state-broker/project-scope";
import type { ReplicatedDomain } from "@oh-my-pi/pi-coding-agent/state-broker/replica";
import { StateSyncStore } from "@oh-my-pi/pi-coding-agent/state-broker/replica";
import { createStateBrokerRoutes } from "@oh-my-pi/pi-coding-agent/state-broker/server";
import { invalidateSessionOwnerCache } from "@oh-my-pi/pi-coding-agent/state-broker/session-files";
import { StateBrokerStore } from "@oh-my-pi/pi-coding-agent/state-broker/store";
import { StateSyncEngine } from "@oh-my-pi/pi-coding-agent/state-broker/sync";
import type { StateDomainId, StateEntry } from "@oh-my-pi/pi-coding-agent/state-broker/wire";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

// This file's throwaway agent dir. `project-scope` and `loadProjects()` read the
// process-wide agent dir with no injection seam, so it is set in `beforeEach`
// and restored in `afterEach` rather than at module scope, so it never
// redirects a later test file.
const AGENT_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-agent-")));
const SAVED_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

const cleanupRoots: string[] = [];
let homedirSpy: { mockRestore: () => void } | undefined;

beforeEach(() => {
	setAgentDir(AGENT_DIR);
	fs.rmSync(getProjectsConfigPath(AGENT_DIR), { force: true });
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
	invalidateSessionOwnerCache();
});

afterEach(async () => {
	homedirSpy?.mockRestore();
	homedirSpy = undefined;
	fs.rmSync(getProjectsConfigPath(AGENT_DIR), { force: true });
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
	invalidateSessionOwnerCache();
	for (const root of cleanupRoots.splice(0)) await removeWithRetries(root);
	if (SAVED_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = SAVED_AGENT_DIR;
	__resetDirsFromEnvForTests();
});

function makeDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	cleanupRoots.push(dir);
	return dir;
}

/** Build a physical session body: real fixed-width title slot + JSON header. */
function writeSessionBody(dir: string, file: string, cwd: string, title: string): void {
	const slot = serializeTitleSlot({ title, source: "user", updatedAt: new Date().toISOString() });
	const header = JSON.stringify({ type: "session", version: 1, id: file.replace(/\.jsonl$/, ""), cwd });
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, file), `${slot}${header}\n${JSON.stringify({ type: "message" })}\n`);
}

/** Register a project mapping, invalidating every cache that reads it. */
function registerProject(entries: Array<{ id: string; path: string; sync: boolean }>): void {
	saveProjects(entries, AGENT_DIR);
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
	invalidateSessionOwnerCache();
}

/** Write a remote-session index exactly where `readRemoteSessionIndex` looks. */
function writeIndex(sessionsDir: string, rels: string[], projectId = "proj:foo"): void {
	const entries: Record<string, unknown> = {};
	for (const rel of rels) {
		entries[rel] = { rel, projectId, relCwd: "", size: 10, mtimeMs: 1000 };
	}
	fs.writeFileSync(
		path.join(path.dirname(sessionsDir), "remote-session-index.json"),
		JSON.stringify({ version: 1, entries }),
	);
}

describe("remote-only session stubs", () => {
	/**
	 * Trust-boundary regression at the CONSUMING end. The index is written from
	 * peer-supplied values, and this is the last point before a row becomes a
	 * `path` the resume path opens (and creates). An index file written by an
	 * older build never saw the domain's inbound validation, so containment has
	 * to be re-established here rather than assumed.
	 */
	test("a row whose rel escapes the sessions dir is ignored", () => {
		const root = makeDir("omp-stub-root-");
		const sessionsDir = path.join(root, "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		// A stub is only offered for a mapped, sync-enabled project, so the
		// containment check has something to reject in the first place.
		registerProject([{ id: "proj:foo", path: makeDir("omp-stub-proj-"), sync: true }]);
		writeIndex(sessionsDir, ["-projects-foo/../../../../tmp/evil.jsonl", "-projects-foo/ok_1111.jsonl"]);

		const stubs = mergeRemoteOnlySessions([], sessionsDir);

		expect(stubs.map(s => path.basename(s.path))).toEqual(["ok_1111.jsonl"]);
		// Nothing survived that points outside the sessions dir.
		for (const stub of stubs) {
			expect(path.resolve(stub.path).startsWith(path.resolve(sessionsDir) + path.sep)).toBe(true);
		}
	});

	/**
	 * A project switched to `sync: false` (or unregistered) keeps its cached
	 * index rows: inbound application skips the project rather than deleting
	 * anything, because absence is not deletion. But `ensureLocal` refuses to
	 * download a body for a project that is not synced here, so offering those
	 * rows puts sessions in the picker that fail the moment they are selected.
	 */
	test("a cached row for a project whose sync was turned off is not offered", () => {
		const root = makeDir("omp-stub-root-");
		const sessionsDir = path.join(root, "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const project = makeDir("omp-stub-proj-");
		writeIndex(sessionsDir, ["-projects-foo/gone_3333.jsonl"]);

		registerProject([{ id: "proj:foo", path: project, sync: true }]);
		expect(mergeRemoteOnlySessions([], sessionsDir)).toHaveLength(1);

		// Same rows on disk, sync turned off: nothing openable is offered.
		registerProject([{ id: "proj:foo", path: project, sync: false }]);
		expect(mergeRemoteOnlySessions([], sessionsDir)).toHaveLength(0);

		// Unregistering the project entirely is the same story.
		registerProject([]);
		expect(mergeRemoteOnlySessions([], sessionsDir)).toHaveLength(0);
	});

	test("an existing local session is not duplicated as a remote stub", () => {
		const root = makeDir("omp-stub-root-");
		const sessionsDir = path.join(root, "sessions");
		const dir = path.join(sessionsDir, "-projects-foo");
		fs.mkdirSync(dir, { recursive: true });
		// Registered and synced, so the row is eligible: what suppresses the stub
		// has to be the existing local file, not a missing project mapping.
		registerProject([{ id: "proj:foo", path: makeDir("omp-stub-proj-"), sync: true }]);
		const rel = "-projects-foo/live_2222.jsonl";
		fs.writeFileSync(path.join(sessionsDir, ...rel.split("/")), "{}\n");
		writeIndex(sessionsDir, [rel]);

		const local: SessionInfo[] = [];
		expect(mergeRemoteOnlySessions(local, sessionsDir)).toHaveLength(0);
	});

	/**
	 * The picker and `--resume <id>` must agree about what exists. The picker
	 * opts into remote-only rows; the id-based resolver used to look only at
	 * local files, so the initial sync could populate the index and `omp
	 * --resume <id>` would still report "Session not found" for a session the
	 * picker listed and could open.
	 *
	 * The stub's `path` is exactly where the body is downloaded to, and every
	 * caller passing `includeRemoteOnly` opens through `SessionManager`, which
	 * fetches it first.
	 */
	test("--resume <id> finds a session that exists here only as a replicated index row", async () => {
		// `listAllSessions` reads the agent dir's own sessions root, not an
		// injected one, so the fixture has to live there.
		const sessionsDir = path.join(AGENT_DIR, "sessions");
		cleanupRoots.push(sessionsDir);
		fs.rmSync(path.join(AGENT_DIR, "remote-session-index.json"), { force: true });
		const project = makeDir("omp-resume-proj-");
		const dirName = sessionDirNameForCwd(project);
		fs.mkdirSync(path.join(sessionsDir, dirName), { recursive: true });
		registerProject([{ id: "proj:foo", path: project, sync: true }]);
		writeIndex(sessionsDir, [`${dirName}/2026-01-01T00-00-00_bbbb2222.jsonl`]);

		// Default behaviour is unchanged: a caller that reads the returned path
		// directly must not be handed a file that is not there yet.
		expect(await resolveResumableSession("bbbb2222", project)).toBeUndefined();

		const match = await resolveResumableSession("bbbb2222", project, undefined, { includeRemoteOnly: true });
		expect(match?.scope).toBe("global");
		expect(match?.session.remoteOnly).toBe(true);
		expect(match?.session.path).toBe(path.join(sessionsDir, dirName, "2026-01-01T00-00-00_bbbb2222.jsonl"));
	});

	/**
	 * The all-projects picker lists remote-only rows, and its delete action ran
	 * an unconditional `unlink` on the stub's `path` — a file that does not
	 * exist here — so choosing Delete surfaced a bare ENOENT and left the row on
	 * screen. Deleting the SHARED copy is deliberately not offered: retracting a
	 * body this machine never published would erase the session on every peer
	 * from a keypress in a list.
	 */
	test("deleting a remote-only row is refused with a reason, not an ENOENT", async () => {
		const storage = new FileSessionStorage();
		const deleteSpy = spyOn(storage, "deleteSessionWithArtifacts");
		const base: SessionInfo = {
			path: path.join(makeDir("omp-del-"), "never-downloaded.jsonl"),
			id: "cccc3333",
			cwd: "",
			created: new Date(),
			modified: new Date(),
			messageCount: 1,
			size: 10,
			firstMessage: "",
			allMessagesText: "",
		};

		await expect(deletePickedSession(storage, { ...base, remoteOnly: true })).rejects.toThrow(/another machine/);
		// Refused BEFORE touching storage, so no ENOENT can escape.
		expect(deleteSpy).not.toHaveBeenCalled();

		// A real local session still deletes, so the guard is not a blanket veto.
		const dir = makeDir("omp-del-local-");
		writeSessionBody(dir, "local.jsonl", dir, "t");
		const local: SessionInfo = { ...base, path: path.join(dir, "local.jsonl") };
		expect(await deletePickedSession(storage, local)).toBe(true);
		expect(fs.existsSync(local.path)).toBe(false);
		deleteSpy.mockRestore();
	});
});

describe("startup readiness", () => {
	/** A domain that records how many push/pull cycles have touched it. */
	class CountingDomain implements ReplicatedDomain {
		readonly id: StateDomainId = "history";
		applied: StateEntry[] = [];
		scans = 0;

		changedSince(): StateEntry[] {
			this.scans += 1;
			return [];
		}

		applyRemote(entries: readonly StateEntry[]): void {
			this.applied.push(...entries);
		}
	}

	/**
	 * The launch-path race. `start()` is fire-and-forget, so without an explicit
	 * wait the caller proceeds before the first exchange has populated anything
	 * it is about to read. The bound is what keeps an unreachable broker from
	 * hanging startup, so both halves are contract: it resolves when the cycle
	 * lands, and it resolves on timeout when the cycle cannot.
	 */
	test("waitForFirstCycle resolves only after a cycle has run", async () => {
		const dir = makeDir("omp-ready-");
		const store = new StateSyncStore(path.join(dir, "sync.db"));
		const domain = new CountingDomain();
		// A real client pointed at a closed port: every request fails fast, and
		// `syncOnce` isolates the failure per domain, so the cycle still completes.
		const engine = new StateSyncEngine({
			client: new StateBrokerClient({ url: "http://127.0.0.1:1", token: "t", maxRetries: 0 }),
			domains: [domain],
			store,
		});
		try {
			engine.start();
			await engine.waitForFirstCycle(5_000);
			// The cycle ran: the domain was scanned at least once. Had the wait
			// returned early this would race.
			expect(domain.scans).toBeGreaterThan(0);
		} finally {
			await engine.stop();
			store.close();
			await removeWithRetries(dir);
		}
	});

	test("waitForFirstCycle returns on its bound when no cycle can complete", async () => {
		const dir = makeDir("omp-ready-");
		const store = new StateSyncStore(path.join(dir, "sync.db"));
		// Never started, so no cycle will ever run; the bound must still release.
		const engine = new StateSyncEngine({
			client: new StateBrokerClient({ url: "http://127.0.0.1:1", token: "t", maxRetries: 0 }),
			domains: [],
			store,
		});
		try {
			const began = Date.now();
			await engine.waitForFirstCycle(50);
			expect(Date.now() - began).toBeLessThan(2_000);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	/**
	 * The end-to-end claim behind the startup gate: on a machine that has just
	 * joined a project, awaiting the first cycle is what makes a peer's sessions
	 * visible to the resume path. Without the wait the index is still absent, so
	 * the launch path would list nothing and exit with "no sessions found".
	 */
	test("awaiting the first cycle is what makes a peer's session listable", async () => {
		const home = makeDir("omp-two-home-");
		homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
		// Same project id, DIFFERENT local paths — the cross-machine mapping case.
		const pathA = path.join(home, "projects", "foo");
		const pathB = path.join(home, "dev", "foo");
		fs.mkdirSync(pathA, { recursive: true });
		fs.mkdirSync(pathB, { recursive: true });

		const brokerRoot = makeDir("omp-two-broker-");
		const authStore = await SqliteAuthCredentialStore.open(path.join(brokerRoot, "agent.db"));
		const storage = new AuthStorage(authStore);
		await storage.reload();
		const brokerStore = StateBrokerStore.open(path.join(brokerRoot, "state.db"));
		let handle: AuthBrokerServerHandle | undefined;
		const syncStores: StateSyncStore[] = [];
		let engineB: StateSyncEngine | undefined;
		try {
			handle = startAuthBroker({
				storage,
				bind: "127.0.0.1:0",
				bearerTokens: ["t"],
				disableRefresher: true,
				routes: [createStateBrokerRoutes(brokerStore)],
			});
			const client = new StateBrokerClient({ url: handle.url, token: "t", maxRetries: 0 });

			// Machine A owns the project at pathA and publishes one session.
			saveProjects([{ id: "proj:foo", path: pathA, sync: true }], AGENT_DIR);
			ProjectsConfigFile.invalidate();
			invalidateProjectScope();
			invalidateSessionOwnerCache();
			const sessionsA = path.join(makeDir("omp-two-a-"), "sessions");
			fs.mkdirSync(sessionsA, { recursive: true });
			writeSessionBody(path.join(sessionsA, sessionDirNameForCwd(pathA)), "aaaa1111.jsonl", pathA, "From A");
			const storeA = new StateSyncStore(path.join(brokerRoot, "sync-a.db"));
			syncStores.push(storeA);
			await new StateSyncEngine({
				client,
				domains: [createSessionsDomain(sessionsA)],
				store: storeA,
			}).syncOnce();

			// Machine B has the same project at pathB and no local sessions.
			saveProjects([{ id: "proj:foo", path: pathB, sync: true }], AGENT_DIR);
			ProjectsConfigFile.invalidate();
			invalidateProjectScope();
			invalidateSessionOwnerCache();
			const sessionsB = path.join(makeDir("omp-two-b-"), "sessions");
			fs.mkdirSync(sessionsB, { recursive: true });
			const storeB = new StateSyncStore(path.join(brokerRoot, "sync-b.db"));
			syncStores.push(storeB);
			engineB = new StateSyncEngine({
				client,
				domains: [createSessionsDomain(sessionsB)],
				store: storeB,
			});

			engineB.start();
			// Synchronously after start() nothing can have been merged: the first
			// await inside a cycle is a network call. This is the state the launch
			// path used to read.
			expect(mergeRemoteOnlySessions([], sessionsB)).toHaveLength(0);

			await engineB.waitForFirstCycle(5_000);

			// A's session is now listable on B, under B's own path mapping.
			const stubs = mergeRemoteOnlySessions([], sessionsB);
			expect(stubs).toHaveLength(1);
			expect(stubs[0].remoteOnly).toBe(true);
			expect(stubs[0].title).toBe("From A");
			expect(stubs[0].path).toContain(sessionDirNameForCwd(pathB));
			// The index row records B's local layout, not A's.
			expect(readRemoteSessionIndex(sessionsB)[0].rel).toContain("-dev-foo");
		} finally {
			await engineB?.stop();
			for (const s of syncStores) s.close();
			await handle?.close();
			brokerStore.close();
			storage.close();
			authStore.close();
		}
	});
});

describe("blob upload durability", () => {
	/** An object store whose `put` fails a fixed number of times first. */
	class FlakyStore implements ObjectStore {
		puts = 0;
		readonly objects = new Map<string, Uint8Array>();

		constructor(readonly failures: number) {}

		async has(key: string): Promise<boolean> {
			return this.objects.has(key);
		}

		async put(key: string, data: Uint8Array): Promise<void> {
			this.puts += 1;
			if (this.puts <= this.failures) throw new Error("transient");
			this.objects.set(key, data);
		}

		async get(key: string): Promise<Uint8Array | null> {
			return this.objects.get(key) ?? null;
		}

		async list(): Promise<never[]> {
			return [];
		}

		async delete(key: string): Promise<void> {
			this.objects.delete(key);
		}
	}

	/**
	 * Blobs are content-addressed, so nothing ever revisits one that is already
	 * local: a dropped upload is permanent, and the session body referencing it
	 * replicates anyway. A transient failure must therefore be retried, and
	 * `drainBlobUploads` must not return while an attempt is still in flight.
	 */
	test("a transient failure is retried and the blob still lands", async () => {
		const dir = makeDir("omp-blob-");
		const store = new FlakyStore(2);
		try {
			const blobs = new BlobStore(dir);
			blobs.attachObjectStore(store);
			await blobs.put(Buffer.from("payload"));

			await drainBlobUploads();

			expect(store.puts).toBe(3); // two failures, then success
			expect(store.objects.size).toBe(1);
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("drainBlobUploads waits for an in-flight upload instead of abandoning it", async () => {
		const dir = makeDir("omp-blob-");
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		let landed = false;
		const store: ObjectStore = {
			async has() {
				return false;
			},
			async put() {
				await gate;
				landed = true;
			},
			async get() {
				return null;
			},
			async list() {
				return [];
			},
			async delete() {},
		};
		try {
			const blobs = new BlobStore(dir);
			blobs.attachObjectStore(store);
			await blobs.put(Buffer.from("held"));

			// Still in flight, so the blob has not landed yet.
			expect(landed).toBe(false);
			// Release it and drain: the drain must observe the completion.
			release();
			await drainBlobUploads();
			expect(landed).toBe(true);
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("uploads are skipped entirely while the upload gate is off", async () => {
		const dir = makeDir("omp-blob-");
		const store = new FlakyStore(0);
		try {
			const blobs = new BlobStore(dir);
			blobs.attachObjectStore(store, { upload: false });
			await blobs.put(Buffer.from("local-only"));
			await drainBlobUploads();

			expect(store.puts).toBe(0);
			expect(store.objects.size).toBe(0);
		} finally {
			await removeWithRetries(dir);
		}
	});
});
