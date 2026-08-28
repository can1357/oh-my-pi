import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectsConfigFile, getProjectsConfigPath, saveProjects } from "@oh-my-pi/pi-coding-agent/config/projects-config";
import { BlobStore, setDefaultBlobObjectStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { sessionDirNameForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { parseTitleSlotFromContent, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import type { ObjectStore, SettingsLike } from "@oh-my-pi/pi-coding-agent/state-broker/object-store";
import { blobKey, resolveObjectStore, sessionKey } from "@oh-my-pi/pi-coding-agent/state-broker/object-store";
import { invalidateProjectScope, projectObjectSlug } from "@oh-my-pi/pi-coding-agent/state-broker/project-scope";
import { SessionReplicator } from "@oh-my-pi/pi-coding-agent/state-broker/session-replicator";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

// A throwaway agent dir for this file. `SessionReplicator` resolves projects
// through `project-scope`, which reads the process-wide agent dir with no
// injection seam, so it must point here. Set in `beforeEach` and restored in
// `afterEach` so this file's temp dir never redirects a later test file (the
// reviewer's load-order finding).
const AGENT_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-objects-agent-")));
const SAVED_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

/** In-memory {@link ObjectStore} so no test touches the network. */
class FakeObjectStore implements ObjectStore {
	readonly map = new Map<string, { data: Uint8Array; mtimeMs: number }>();
	puts = 0;
	#putWaiters: Array<() => void> = [];

	/** Resolves the next time any `put` lands — lets a test await the real upload
	 * event instead of sleeping for a guessed duration. */
	whenPut(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#putWaiters.push(resolve);
		return promise;
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		this.puts++;
		this.map.set(key, { data: Uint8Array.from(data), mtimeMs: Date.now() });
		for (const resolve of this.#putWaiters.splice(0)) resolve();
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
	setDefaultBlobObjectStore(undefined);
	fs.rmSync(getProjectsConfigPath(AGENT_DIR), { force: true });
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
});

afterEach(async () => {
	homedirSpy?.mockRestore();
	homedirSpy = undefined;
	setDefaultBlobObjectStore(undefined);
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

describe("resolveObjectStore", () => {
	function settings(values: Record<string, unknown>): SettingsLike {
		return { get: (key: string) => values[key] };
	}

	// These cases exercise backend-off and missing-field short-circuits, which
	// return before any resolution; a passthrough async resolver keeps the call
	// arity correct without affecting the outcome. Indirection-resolution
	// behaviour is covered separately in state-broker-object-store-config.test.ts.
	const passthrough = async (raw: string): Promise<string> => raw;

	test("returns undefined when the backend is off", async () => {
		expect(await resolveObjectStore(settings({ "objects.backend": "off" }), passthrough)).toBeUndefined();
		expect(await resolveObjectStore(settings({}), passthrough)).toBeUndefined();
	});

	test("returns undefined when a required s3 field is missing", async () => {
		// Bucket missing.
		expect(
			await resolveObjectStore(
				settings({ "objects.backend": "s3", "objects.s3.accessKeyId": "a", "objects.s3.secretAccessKey": "s" }),
				passthrough,
			),
		).toBeUndefined();
		// Access key missing.
		expect(
			await resolveObjectStore(
				settings({ "objects.backend": "s3", "objects.s3.bucket": "b", "objects.s3.secretAccessKey": "s" }),
				passthrough,
			),
		).toBeUndefined();
		// Secret missing.
		expect(
			await resolveObjectStore(
				settings({ "objects.backend": "s3", "objects.s3.bucket": "b", "objects.s3.accessKeyId": "a" }),
				passthrough,
			),
		).toBeUndefined();
	});
});

describe("sessionKey / blobKey layout", () => {
	test("prefix keys under their kind", () => {
		expect(sessionKey("slug/file.jsonl")).toBe("sessions/slug/file.jsonl");
		expect(blobKey("deadbeef")).toBe("blobs/deadbeef");
	});
});

describe("BlobStore remote backing", () => {
	test("uploads gated OFF: put/putSync write locally with ZERO object-store writes", async () => {
		const fake = new FakeObjectStore();
		const store = new BlobStore(makeDir("omp-blob-"));
		store.attachObjectStore(fake, { upload: false });

		const asyncRes = await store.put(Buffer.from("async-bytes"));
		const syncRes = store.putSync(Buffer.from("sync-bytes"));
		// The upload gate is checked synchronously inside put/putSync, so a gated
		// store never even schedules a transfer — no wait is needed to prove it.

		expect(fake.puts).toBe(0);
		expect(fake.map.size).toBe(0);
		expect(fs.existsSync(asyncRes.path)).toBe(true);
		expect(fs.existsSync(syncRes.path)).toBe(true);
	});

	test("uploads ON: the blob appears remotely", async () => {
		const fake = new FakeObjectStore();
		const store = new BlobStore(makeDir("omp-blob-"));
		store.attachObjectStore(fake, { upload: true });

		const uploaded = fake.whenPut();
		const { hash } = await store.put(Buffer.from("upload-me"));
		await uploaded; // the background upload's real put event, not a timed guess
		expect(fake.map.has(blobKey(hash))).toBe(true);
	});

	test("downloads are unconditional: a local miss fetches, materializes, and getSync then hits", async () => {
		const fake = new FakeObjectStore();
		const payload = Buffer.from("remote-only-bytes");
		const hash = new Bun.SHA256().update(payload).digest("hex");
		await fake.put(blobKey(hash), payload);

		const store = new BlobStore(makeDir("omp-blob-"));
		// Attach download-only: uploads gated off but downloads still work.
		store.attachObjectStore(fake, { upload: false });

		expect(store.getSync(hash)).toBeNull(); // not yet local
		const fetched = await store.get(hash);
		expect(fetched?.equals(payload)).toBe(true);
		// Materialized locally, so the synchronous read now hits.
		expect(store.getSync(hash)?.equals(payload)).toBe(true);
	});

	test("with no store attached, behaviour is purely local", async () => {
		const store = new BlobStore(makeDir("omp-blob-"));
		const { hash } = await store.put(Buffer.from("local"));
		expect((await store.get(hash))?.toString()).toBe("local");
		expect(await store.get("f".repeat(64))).toBeNull();
		expect(store.getSync("f".repeat(64))).toBeNull();
	});

	test("putSync / getSync are synchronous (return non-Promise values)", () => {
		const store = new BlobStore(makeDir("omp-blob-"));
		const put = store.putSync(Buffer.from("sync"));
		expect(put instanceof Promise).toBe(false);
		const got = store.getSync(put.hash);
		expect(got instanceof Promise).toBe(false);
		expect(got?.toString()).toBe("sync");
	});
});

describe("SessionReplicator", () => {
	interface Fixture {
		home: string;
		foo: string;
		sessionsDir: string;
		fake: FakeObjectStore;
		replicator: SessionReplicator;
	}

	function setup(sync: boolean): Fixture {
		const home = makeDir("omp-repl-home-");
		homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
		const foo = path.join(home, "projects", "foo");
		fs.mkdirSync(path.join(foo, "pkg", "a"), { recursive: true });
		saveProjects([{ id: "proj:foo", path: foo, sync }], AGENT_DIR);
		ProjectsConfigFile.invalidate();
		invalidateProjectScope();
		const sessionsDir = path.join(makeDir("omp-repl-root-"), "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const fake = new FakeObjectStore();
		return { home, foo, sessionsDir, fake, replicator: new SessionReplicator({ store: fake, sessionsDir }) };
	}

	/** Local rel + on-disk body for a session rooted at `<foo>/<relCwd>`. */
	function seedLocalBody(fx: Fixture, file: string, cwd: string, title: string): string {
		const dir = path.join(fx.sessionsDir, sessionDirNameForCwd(cwd));
		fs.mkdirSync(dir, { recursive: true });
		const slot = serializeTitleSlot({ title, source: "user", updatedAt: new Date().toISOString() });
		const header = JSON.stringify({ type: "session", version: 1, id: file.replace(/\.jsonl$/, ""), cwd });
		fs.writeFileSync(path.join(dir, file), `${slot}${header}\n${JSON.stringify({ type: "message", n: 1 })}\n`);
		return `${sessionDirNameForCwd(cwd)}/${file}`;
	}

	test("uploadIfStale uploads a synced project's body", async () => {
		const fx = setup(true);
		const rel = seedLocalBody(fx, "sess.jsonl", path.join(fx.foo, "pkg", "a"), "T");
		await fx.replicator.uploadIfStale(rel, "proj:foo");
		expect(fx.fake.map.has(sessionKey(`${projectObjectSlug("proj:foo")}/sess.jsonl`))).toBe(true);
	});

	test("uploadIfStale / scheduleUpload are NO-OPS for a sync:false project", async () => {
		const fx = setup(false);
		const rel = seedLocalBody(fx, "sess.jsonl", path.join(fx.foo, "pkg", "a"), "T");
		await fx.replicator.uploadIfStale(rel, "proj:foo");
		fx.replicator.scheduleUpload(rel, "proj:foo");
		await fx.replicator.drain();
		expect(fx.fake.puts).toBe(0);
		expect(fx.fake.map.size).toBe(0);
	});

	test("drain() flushes a debounced scheduleUpload", async () => {
		const fx = setup(true);
		const rel = seedLocalBody(fx, "sess.jsonl", path.join(fx.foo, "pkg", "a"), "T");
		fx.replicator.scheduleUpload(rel, "proj:foo"); // debounced 3s; drain must fast-flush it
		await fx.replicator.drain();
		expect(fx.fake.map.has(sessionKey(`${projectObjectSlug("proj:foo")}/sess.jsonl`))).toBe(true);
	});

	test("ensureLocal rewrites the header cwd to the local subdir while preserving the title slot verbatim", async () => {
		const fx = setup(true);
		const relCwd = "pkg/a";
		const file = "resume.jsonl";
		const originCwd = "/origin/checkout/foo/pkg/a";
		const title = "Cross-machine Session";
		// Build the origin body exactly as a real session would be laid out.
		const slot = serializeTitleSlot({ title, source: "user", updatedAt: new Date().toISOString() });
		const header = JSON.stringify({ type: "session", version: 1, id: "resume", cwd: originCwd });
		const messageLine = JSON.stringify({ type: "message", role: "user", content: "hi" });
		const originBytes = Buffer.from(`${slot}${header}\n${messageLine}\n`, "utf-8");
		// Publish it under the project-keyed object key ensureLocal will fetch from.
		await fx.fake.put(sessionKey(`${projectObjectSlug("proj:foo")}/${file}`), originBytes);

		const localDir = sessionDirNameForCwd(path.join(fx.foo, "pkg", "a"));
		const rel = `${localDir}/${file}`;
		expect(await fx.replicator.ensureLocal(rel, { projectId: "proj:foo", relCwd })).toBe(true);

		const landed = fs.readFileSync(path.join(fx.sessionsDir, localDir, file), "utf-8");
		// Title slot preserved byte-for-byte (first 256 bytes) and still parses.
		expect(Buffer.from(landed, "utf-8").subarray(0, 256).equals(Buffer.from(slot, "utf-8"))).toBe(true);
		expect(parseTitleSlotFromContent(landed)?.title).toBe(title);
		// Header cwd rewritten to THIS machine's subdirectory.
		const lines = landed.split("\n");
		const parsedHeader = JSON.parse(lines[1]) as { cwd: string };
		expect(parsedHeader.cwd).toBe(path.join(fx.foo, "pkg", "a"));
		// Non-header line preserved verbatim.
		expect(lines[2]).toBe(messageLine);
	});

	test("ensureLocal is a NO-OP for a body outside any synced project", async () => {
		const fx = setup(false);
		const file = "x.jsonl";
		const localDir = sessionDirNameForCwd(path.join(fx.foo, "pkg", "a"));
		// Even if a matching remote object existed, an unsynced rel must not pull.
		await fx.fake.put(sessionKey(`${projectObjectSlug("proj:foo")}/${file}`), Buffer.from("{}"));
		expect(await fx.replicator.ensureLocal(`${localDir}/${file}`, { projectId: "proj:foo", relCwd: "pkg/a" })).toBe(
			false,
		);
		expect(fs.existsSync(path.join(fx.sessionsDir, localDir, file))).toBe(false);
	});
});
