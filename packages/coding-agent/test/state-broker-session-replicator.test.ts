import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectsConfigFile, getProjectsConfigPath, saveProjects } from "@oh-my-pi/pi-coding-agent/config/projects-config";
import { sessionDirNameForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import type { ObjectStore } from "@oh-my-pi/pi-coding-agent/state-broker/object-store";
import { sessionKey } from "@oh-my-pi/pi-coding-agent/state-broker/object-store";
import { invalidateProjectScope, projectObjectSlug } from "@oh-my-pi/pi-coding-agent/state-broker/project-scope";
import { StateSyncStore } from "@oh-my-pi/pi-coding-agent/state-broker/replica";
import { SessionReplicator } from "@oh-my-pi/pi-coding-agent/state-broker/session-replicator";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

// A throwaway agent dir for this file. `SessionReplicator` resolves projects
// through `project-scope`, which reads the process-wide agent dir with no
// injection seam, so it must point here. Set in `beforeEach` and restored in
// `afterEach` so this file's temp dir never redirects a later test file (the
// reviewer's load-order finding).
const AGENT_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-repl-agent-")));
const SAVED_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

/**
 * In-memory {@link ObjectStore} backed by a Map so no test touches S3. `put`
 * records the wall-clock time it landed as `mtimeMs`, mirroring how a real
 * object store stamps an upload — that is what `uploadIfStale` compares against.
 * `seed` injects a remote object with an explicit mtime so a test can construct
 * a remote that is deliberately older (or larger) than the local body.
 */
class FakeObjectStore implements ObjectStore {
	readonly map = new Map<string, { data: Uint8Array; mtimeMs: number }>();
	puts = 0;
	/** Runs at the start of every `put`, to simulate work racing the transfer. */
	onPut?: (key: string) => void;
	/**
	 * Forces the mtime the next `put` stamps. Real object stores stamp the time
	 * the upload COMPLETED, which a test needs to pin to make "the remote looks
	 * newer than the local file" deterministic rather than clock-dependent.
	 */
	nextPutMtimeMs?: number;

	seed(key: string, data: Uint8Array, mtimeMs: number): void {
		this.map.set(key, { data: Uint8Array.from(data), mtimeMs });
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		this.puts++;
		this.onPut?.(key);
		this.map.set(key, { data: Uint8Array.from(data), mtimeMs: this.nextPutMtimeMs ?? Date.now() });
	}
	async get(key: string): Promise<Uint8Array | null> {
		return this.map.get(key)?.data ?? null;
	}
	async has(key: string): Promise<boolean> {
		return this.map.has(key);
	}
	async list(prefix: string): Promise<Array<{ key: string; size: number; mtimeMs: number }>> {
		return [...this.map.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([key, v]) => ({ key, size: v.data.length, mtimeMs: v.mtimeMs }));
	}
	async delete(key: string): Promise<void> {
		this.map.delete(key);
	}
}

const cleanupRoots: string[] = [];
function makeDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	cleanupRoots.push(dir);
	return dir;
}

let homedirSpy: { mockRestore: () => void } | undefined;

beforeEach(() => {
	setAgentDir(AGENT_DIR);
	fs.rmSync(getProjectsConfigPath(AGENT_DIR), { force: true });
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
});

afterEach(async () => {
	for (const store of syncStores.splice(0)) store.close();
	homedirSpy?.mockRestore();
	homedirSpy = undefined;
	fs.rmSync(getProjectsConfigPath(AGENT_DIR), { force: true });
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
	for (const root of cleanupRoots.splice(0)) await removeWithRetries(root);
	// Restore the process-wide agent dir so this file's temp dir never redirects
	// a later test file: put the env var back exactly and rebuild the resolver.
	if (SAVED_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = SAVED_AGENT_DIR;
	__resetDirsFromEnvForTests();
});

interface Fixture {
	foo: string;
	sessionsDir: string;
	fake: FakeObjectStore;
	sync: StateSyncStore;
	replicator: SessionReplicator;
}

/** Sync stores opened by `setup`, closed in `afterEach`. */
const syncStores: StateSyncStore[] = [];

function setup(): Fixture {
	const home = makeDir("omp-repl-home-");
	homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
	const foo = path.join(home, "projects", "foo");
	fs.mkdirSync(foo, { recursive: true });
	saveProjects([{ id: "proj:foo", path: foo, sync: true }], AGENT_DIR);
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
	const sessionsDir = path.join(makeDir("omp-repl-root-"), "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const fake = new FakeObjectStore();
	const sync = new StateSyncStore(path.join(makeDir("omp-repl-sync-"), "sync.db"));
	syncStores.push(sync);
	return { foo, sessionsDir, fake, sync, replicator: new SessionReplicator({ store: fake, sessionsDir, sync }) };
}

/** Object key `uploadIfStale` addresses `<file>` under `proj:foo` by. */
function keyFor(file: string): string {
	return sessionKey(`${projectObjectSlug("proj:foo")}/${file}`);
}

/** Write a local session body for `file` rooted at the project, return its rel. */
function writeLocalBody(fx: Fixture, file: string, body: string): { rel: string; abs: string } {
	const dirName = sessionDirNameForCwd(fx.foo);
	const dir = path.join(fx.sessionsDir, dirName);
	fs.mkdirSync(dir, { recursive: true });
	const abs = path.join(dir, file);
	fs.writeFileSync(abs, body);
	return { rel: `${dirName}/${file}`, abs };
}

describe("SessionReplicator.uploadIfStale staleness", () => {
	// The regression this replaces: a header rewrite on download shortens the
	// file on a machine with a shorter checkout path, so a genuinely newer local
	// body is SMALLER than the remote. A byte-size test ("remote.size >= local")
	// would skip the upload and strand the new turn. mtime must win over size.
	test("a shorter-but-newer local body uploads over a larger, older remote", async () => {
		const fx = setup();
		const file = "sess.jsonl";
		// Remote: large body, deliberately OLD mtime.
		const remoteBody = Buffer.from(`${"x".repeat(4096)}\n`);
		fx.fake.seed(keyFor(file), remoteBody, 1_000);
		// Local: SMALLER body, newer mtime (set explicitly for determinism).
		const local = writeLocalBody(fx, file, `${JSON.stringify({ type: "session", n: 1 })}\n`);
		const localBytes = fs.readFileSync(local.abs);
		expect(localBytes.length).toBeLessThan(remoteBody.length); // the trap precondition
		fs.utimesSync(local.abs, new Date(5_000), new Date(5_000));

		await fx.replicator.uploadIfStale(local.rel, "proj:foo");

		// The upload happened and replaced the remote with the newer local body,
		// even though it is fewer bytes — proving mtime, not size, drove it.
		expect(fx.fake.puts).toBe(1);
		expect(Buffer.from(fx.fake.map.get(keyFor(file))!.data).equals(localBytes)).toBe(true);
	});

	test("an absent remote object always uploads", async () => {
		const fx = setup();
		const local = writeLocalBody(fx, "new.jsonl", `${JSON.stringify({ type: "session" })}\n`);
		expect(fx.fake.map.has(keyFor("new.jsonl"))).toBe(false);

		await fx.replicator.uploadIfStale(local.rel, "proj:foo");

		expect(fx.fake.puts).toBe(1);
		expect(fx.fake.map.has(keyFor("new.jsonl"))).toBe(true);
	});

	// Guards the fractional-mtime infinite-reupload trap: after one upload the
	// remote is stamped no earlier than the local mtime, so a second cycle with
	// an unchanged body must be a no-op. A raw `100.9 > 100` compare would loop.
	test("an unchanged local body does not re-upload on the next cycle", async () => {
		const fx = setup();
		const local = writeLocalBody(fx, "steady.jsonl", `${JSON.stringify({ type: "session" })}\n`);

		await fx.replicator.uploadIfStale(local.rel, "proj:foo");
		expect(fx.fake.puts).toBe(1);
		// Second and third cycles with no local change: no further uploads.
		await fx.replicator.uploadIfStale(local.rel, "proj:foo");
		await fx.replicator.uploadIfStale(local.rel, "proj:foo");
		expect(fx.fake.puts).toBe(1);
	});
});

describe("SessionReplicator concurrency cap", () => {
	/**
	 * Store whose `get` blocks on a shared gate and records the peak number of
	 * simultaneous in-flight calls, so a test can prove the semaphore never lets
	 * more than MAX_CONCURRENT_TRANSFERS transfers run at once.
	 */
	class GatedStore implements ObjectStore {
		active = 0;
		peak = 0;
		readonly #gate: Promise<void>;
		readonly #open: () => void;
		// Waiters parked until `active` reaches their target count, so a test can
		// await the exact concurrency state instead of sleeping for a guess.
		readonly #activeWaiters: Array<{ target: number; resolve: () => void }> = [];
		constructor() {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#gate = promise;
			this.#open = resolve;
		}
		release(): void {
			this.#open();
		}
		whenActiveReaches(target: number): Promise<void> {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#activeWaiters.push({ target, resolve });
			this.#notifyActive();
			return promise;
		}
		#notifyActive(): void {
			for (const waiter of this.#activeWaiters.splice(0)) {
				if (this.active >= waiter.target) waiter.resolve();
				else this.#activeWaiters.push(waiter);
			}
		}
		async get(): Promise<Uint8Array | null> {
			this.active++;
			this.peak = Math.max(this.peak, this.active);
			this.#notifyActive();
			await this.#gate;
			this.active--;
			return null;
		}
		async put(): Promise<void> {}
		async has(): Promise<boolean> {
			return false;
		}
		async list(): Promise<Array<{ key: string; size: number; mtimeMs: number }>> {
			return [];
		}
		async delete(): Promise<void> {}
	}

	test("ensureLocal admits at most MAX_CONCURRENT_TRANSFERS (4) transfers at once", async () => {
		const home = makeDir("omp-repl-home-");
		homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
		const foo = path.join(home, "projects", "foo");
		fs.mkdirSync(foo, { recursive: true });
		saveProjects([{ id: "proj:foo", path: foo, sync: true }], AGENT_DIR);
		ProjectsConfigFile.invalidate();
		invalidateProjectScope();
		const sessionsDir = path.join(makeDir("omp-repl-root-"), "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const gated = new GatedStore();
		const replicator = new SessionReplicator({ store: gated, sessionsDir });

		const dirName = sessionDirNameForCwd(foo);
		// Ten distinct, not-yet-local sessions: each ensureLocal must take a slot
		// and block in the gated `get`. Files intentionally do NOT exist on disk.
		const pending = Array.from({ length: 10 }, (_, i) => replicator.ensureLocal(`${dirName}/s${i}.jsonl`, { projectId: "proj:foo" }));

		// Await the exact moment four transfers are in flight. The gate is closed,
		// so no slot can free and no fifth `get` can be admitted — the state is
		// stable the instant this resolves, needing no wall-clock settle time.
		await gated.whenActiveReaches(4);
		expect(gated.active).toBe(4);
		expect(gated.peak).toBe(4);

		gated.release();
		const results = await Promise.all(pending);
		// Every call resolved (false: the gated store returns no body) and the peak
		// stayed at the cap across all three waves (4 + 4 + 2) — never exceeded 4.
		expect(results).toEqual(Array.from({ length: 10 }, () => false));
		expect(gated.peak).toBe(4);
	});
});

describe("SessionReplicator project identity", () => {
	/**
	 * The encoded directory name is ambiguous: a session in `<home>/p/foo/bar`
	 * and one at the root of the sibling project `<home>/p/foo-bar` both encode
	 * to `-p-foo-bar`. Deriving ownership from that name by longest prefix picks
	 * `foo-bar` for both, so the body lands under the wrong project's key while
	 * the index row stays keyed to `foo`, and peers cannot fetch the body they
	 * were told about. Identity must come from the confirmed id instead.
	 */
	test("uploads a subdirectory session under its own project, not a name-sibling", async () => {
		const home = makeDir("omp-amb-home-");
		homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
		const foo = path.join(home, "p", "foo");
		const fooBar = path.join(home, "p", "foo-bar");
		fs.mkdirSync(path.join(foo, "bar"), { recursive: true });
		fs.mkdirSync(fooBar, { recursive: true });
		saveProjects(
			[
				{ id: "proj:foo", path: foo, sync: true },
				{ id: "proj:foo-bar", path: fooBar, sync: true },
			],
			AGENT_DIR,
		);
		ProjectsConfigFile.invalidate();
		invalidateProjectScope();

		// Both of these encode to the SAME directory name.
		const shared = sessionDirNameForCwd(path.join(foo, "bar"));
		expect(shared).toBe(sessionDirNameForCwd(fooBar));

		const sessionsDir = path.join(makeDir("omp-amb-root-"), "sessions");
		fs.mkdirSync(path.join(sessionsDir, shared), { recursive: true });
		const file = "aaaa1111.jsonl";
		fs.writeFileSync(path.join(sessionsDir, shared, file), "{}\n");

		const fake = new FakeObjectStore();
		const replicator = new SessionReplicator({ store: fake, sessionsDir });
		// The id the owning scan confirmed from the body's header, not the one the
		// directory name suggests.
		await replicator.uploadIfStale(`${shared}/${file}`, "proj:foo");

		const keys = [...fake.map.keys()];
		expect(keys).toEqual([sessionKey(`${projectObjectSlug("proj:foo")}/${file}`)]);
		expect(keys[0]).not.toContain(projectObjectSlug("proj:foo-bar"));
	});
});

describe("SessionReplicator.maybeReconcile", () => {
	/**
	 * Uploads are scheduled from `changedSince` index rows, and the outbound
	 * cursor advances once the METADATA push succeeds. So a body whose transfer
	 * failed was never offered again: peers held an index row pointing at an
	 * object that does not exist, until that session happened to be written
	 * again. Reconcile has to be able to repair it with no index change at all.
	 */
	test("re-uploads a body whose first transfer failed, with no index change", async () => {
		const fx = setup();
		const file = "bbbb2222.jsonl";
		// A real session body: reconcile only considers files whose header cwd
		// confirms them as owned by a synced project.
		const dirName = sessionDirNameForCwd(fx.foo);
		fs.mkdirSync(path.join(fx.sessionsDir, dirName), { recursive: true });
		fs.writeFileSync(
			path.join(fx.sessionsDir, dirName, file),
			`${JSON.stringify({ type: "session", version: 1, id: "bbbb2222", cwd: fx.foo })}\n`,
		);

		// First attempt fails, exactly as a transient object-store error would.
		let failNext = true;
		const original = fx.fake.put.bind(fx.fake);
		const putSpy = spyOn(fx.fake, "put").mockImplementation(async (key, data) => {
			if (failNext) {
				failNext = false;
				throw new Error("transient");
			}
			await original(key, data);
		});
		try {
			await fx.replicator.uploadIfStale(`${dirName}/${file}`, "proj:foo");
			expect(fx.fake.map.size).toBe(0);

			// No index row changes; reconcile alone must notice and repair.
			fx.replicator.maybeReconcile();
			await fx.replicator.drain();

			expect(fx.fake.map.has(keyFor(file))).toBe(true);
		} finally {
			putSpy.mockRestore();
		}
	});

	test("skips a body the store already holds at the same mtime", async () => {
		const fx = setup();
		const file = "cccc3333.jsonl";
		const dirName = sessionDirNameForCwd(fx.foo);
		fs.mkdirSync(path.join(fx.sessionsDir, dirName), { recursive: true });
		const abs = path.join(fx.sessionsDir, dirName, file);
		fs.writeFileSync(abs, `${JSON.stringify({ type: "session", version: 1, id: "cccc3333", cwd: fx.foo })}\n`);
		// Remote already at or past the local mtime.
		fx.fake.seed(keyFor(file), Buffer.from("{}"), Math.floor(fs.statSync(abs).mtimeMs) + 1_000);

		fx.replicator.maybeReconcile();
		await fx.replicator.drain();

		expect(fx.fake.puts).toBe(0);
	});

	/**
	 * A body appended to during its own upload must not stay truncated forever.
	 *
	 * The object store stamps the time the `put` COMPLETED, which is later than
	 * the append that the uploaded bytes missed. Comparing the local mtime with
	 * that stamp therefore reports "remote is newer" for a remote that is
	 * provably incomplete, and every later reconcile skipped it, so a peer
	 * resumed a conversation truncated at an arbitrary point.
	 */
	test("a body appended to during its own upload is repaired, not left truncated", async () => {
		const fx = setup();
		const file = "dddd4444.jsonl";
		const header = `${JSON.stringify({ type: "session", version: 1, id: "dddd4444", cwd: fx.foo })}\n`;
		const { rel, abs } = writeLocalBody(fx, file, header);
		const key = keyFor(file);

		// The live session appends its final record after `readFile` hit EOF, and
		// the completed upload is stamped well after that append.
		fx.fake.onPut = () => fs.appendFileSync(abs, `${JSON.stringify({ type: "message" })}\n`);
		fx.fake.nextPutMtimeMs = Math.floor(fs.statSync(abs).mtimeMs) + 60_000;

		await fx.replicator.uploadIfStale(rel, "proj:foo");
		const torn = new TextDecoder().decode((await fx.fake.get(key)) ?? new Uint8Array());
		expect(torn).toBe(header);

		// Stop racing; a later pass must notice the archive is not the local body.
		fx.fake.onPut = undefined;
		fx.fake.nextPutMtimeMs = undefined;
		await fx.replicator.uploadIfStale(rel, "proj:foo");

		const repaired = new TextDecoder().decode((await fx.fake.get(key)) ?? new Uint8Array());
		expect(repaired).toBe(fs.readFileSync(abs, "utf8"));
		expect(repaired).not.toBe(torn);
		await fx.replicator.drain();
	});

	/**
	 * The complement: once an upload provably matches the local file, repeated
	 * passes must not re-upload it. Without the recorded snapshot this would be
	 * the fallback timestamp comparison, and the point of the fix is that the
	 * snapshot replaces it rather than being additive.
	 */
	test("a body already archived at its current bytes is not re-uploaded", async () => {
		const fx = setup();
		const file = "eeee5555.jsonl";
		const { rel } = writeLocalBody(fx, file, `${JSON.stringify({ type: "session", version: 1, cwd: fx.foo })}\n`);

		await fx.replicator.uploadIfStale(rel, "proj:foo");
		expect(fx.fake.puts).toBe(1);
		await fx.replicator.uploadIfStale(rel, "proj:foo");
		expect(fx.fake.puts).toBe(1);
	});
});
