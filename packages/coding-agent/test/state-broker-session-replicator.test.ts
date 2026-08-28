import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectsConfigFile, getProjectsConfigPath, saveProjects } from "@oh-my-pi/pi-coding-agent/config/projects-config";
import { sessionDirNameForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import type { ObjectStore } from "@oh-my-pi/pi-coding-agent/state-broker/object-store";
import { sessionKey } from "@oh-my-pi/pi-coding-agent/state-broker/object-store";
import { invalidateProjectScope, projectObjectSlug } from "@oh-my-pi/pi-coding-agent/state-broker/project-scope";
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

	seed(key: string, data: Uint8Array, mtimeMs: number): void {
		this.map.set(key, { data: Uint8Array.from(data), mtimeMs });
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		this.puts++;
		this.map.set(key, { data: Uint8Array.from(data), mtimeMs: Date.now() });
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
	replicator: SessionReplicator;
}

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
	return { foo, sessionsDir, fake, replicator: new SessionReplicator({ store: fake, sessionsDir }) };
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

		await fx.replicator.uploadIfStale(local.rel);

		// The upload happened and replaced the remote with the newer local body,
		// even though it is fewer bytes — proving mtime, not size, drove it.
		expect(fx.fake.puts).toBe(1);
		expect(Buffer.from(fx.fake.map.get(keyFor(file))!.data).equals(localBytes)).toBe(true);
	});

	test("an absent remote object always uploads", async () => {
		const fx = setup();
		const local = writeLocalBody(fx, "new.jsonl", `${JSON.stringify({ type: "session" })}\n`);
		expect(fx.fake.map.has(keyFor("new.jsonl"))).toBe(false);

		await fx.replicator.uploadIfStale(local.rel);

		expect(fx.fake.puts).toBe(1);
		expect(fx.fake.map.has(keyFor("new.jsonl"))).toBe(true);
	});

	// Guards the fractional-mtime infinite-reupload trap: after one upload the
	// remote is stamped no earlier than the local mtime, so a second cycle with
	// an unchanged body must be a no-op. A raw `100.9 > 100` compare would loop.
	test("an unchanged local body does not re-upload on the next cycle", async () => {
		const fx = setup();
		const local = writeLocalBody(fx, "steady.jsonl", `${JSON.stringify({ type: "session" })}\n`);

		await fx.replicator.uploadIfStale(local.rel);
		expect(fx.fake.puts).toBe(1);
		// Second and third cycles with no local change: no further uploads.
		await fx.replicator.uploadIfStale(local.rel);
		await fx.replicator.uploadIfStale(local.rel);
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
		const pending = Array.from({ length: 10 }, (_, i) => replicator.ensureLocal(`${dirName}/s${i}.jsonl`));

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
