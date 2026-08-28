import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectsConfigFile, getProjectsConfigPath, saveProjects } from "@oh-my-pi/pi-coding-agent/config/projects-config";
import {
	MAX_CONFIG_FILE_BYTES,
	configFileMtimeMs,
	enumerateConfigFiles,
	readConfigFile,
	writeConfigFileAtomic,
} from "@oh-my-pi/pi-coding-agent/state-broker/config-files";
import { createConfigDomain } from "@oh-my-pi/pi-coding-agent/state-broker/domains/config";
import { createHistoryDomain } from "@oh-my-pi/pi-coding-agent/state-broker/domains/history";
import { createSessionsDomain, readRemoteSessionIndex } from "@oh-my-pi/pi-coding-agent/state-broker/domains/sessions";
import { createTitlesDomain, invalidateSyncedTitleIds } from "@oh-my-pi/pi-coding-agent/state-broker/domains/titles";
import { encodeWireKey, invalidateProjectScope } from "@oh-my-pi/pi-coding-agent/state-broker/project-scope";
import { StateSyncStore } from "@oh-my-pi/pi-coding-agent/state-broker/replica";
import { invalidateSessionOwnerCache } from "@oh-my-pi/pi-coding-agent/state-broker/session-files";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
// Type-only alias for the fixture field type; erased at runtime.
import type { HistoryStorage as HistoryStorageInstance } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { sessionDirNameForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	lookupSessionTitle,
	recordSessionTitle,
	resetSessionTitleIndexForTests,
} from "@oh-my-pi/pi-coding-agent/session/title-index";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

// A throwaway agent dir for this file. `project-scope`'s `resolveProject` and
// `loadProjects()` (its no-arg default path) and the title-index db path have
// NO injection seam, so the domains that resolve projects require the
// process-wide agent dir to point here. It is set in `beforeEach` and restored
// in `afterEach` so it never redirects a later test file (the reviewer's
// load-order finding). Session dirs and config dirs ARE injected per test.
const AGENT_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-domains-agent-")));
const SAVED_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

interface Entry {
	id: string;
	path: string;
	sync: boolean;
}

function setProjects(entries: Entry[]): void {
	saveProjects(entries, AGENT_DIR);
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
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
	invalidateSessionOwnerCache();
	invalidateSyncedTitleIds();
	HistoryStorage.resetInstance();
	resetSessionTitleIndexForTests();
});

afterEach(async () => {
	homedirSpy?.mockRestore();
	homedirSpy = undefined;
	HistoryStorage.resetInstance();
	resetSessionTitleIndexForTests();
	fs.rmSync(getProjectsConfigPath(AGENT_DIR), { force: true });
	ProjectsConfigFile.invalidate();
	invalidateProjectScope();
	invalidateSessionOwnerCache();
	invalidateSyncedTitleIds();
	for (const root of cleanupRoots.splice(0)) await removeWithRetries(root);
	// Restore the process-wide agent dir so this file's temp dir never redirects
	// a later test file: put the env var back exactly and rebuild the resolver.
	if (SAVED_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = SAVED_AGENT_DIR;
	__resetDirsFromEnvForTests();
});

/** Build a physical session body: real fixed-width title slot + JSON header. */
function writeSessionBody(dir: string, file: string, cwd: string, title: string): void {
	const slot = serializeTitleSlot({ title, source: "user", updatedAt: new Date().toISOString() });
	const header = JSON.stringify({ type: "session", version: 1, id: file.replace(/\.jsonl$/, ""), cwd });
	fs.mkdirSync(dir, { recursive: true });
	// slot already carries its own trailing newline (256 bytes incl. "\n").
	fs.writeFileSync(path.join(dir, file), `${slot}${header}\n${JSON.stringify({ type: "message" })}\n`);
}

describe("history domain", () => {
	// Every history test opens a fresh singleton at a private db path.
	function openStorage(): HistoryStorageInstance {
		return HistoryStorage.open(path.join(makeDir("omp-hist-db-"), "history.db"));
	}

	test("emits a synced prompt with cwd replaced by { projectId, rel } and seconds->millis rev", () => {
		const ws = makeDir("omp-hist-ws-");
		const foo = path.join(ws, "foo");
		fs.mkdirSync(path.join(foo, "pkg"), { recursive: true });
		setProjects([{ id: "proj:foo", path: foo, sync: true }]);

		const storage = openStorage();
		storage.mergeRemote([{ prompt: "hello", createdAt: 1000, cwd: path.join(foo, "pkg"), sessionId: "s1" }]);

		const entries = createHistoryDomain(storage).changedSince(0, 10);
		expect(entries).toHaveLength(1);
		const [entry] = entries;
		expect(entry.key).toBe("hello");
		expect(entry.rev).toBe(1000 * 1000); // created_at seconds -> wire millis
		// Shape produced by the history domain itself; named const per cast rule.
		const value = entry.value as { prompt: string; createdAt: number; project?: unknown; cwd?: string };
		expect(value.project).toEqual({ id: "proj:foo", rel: "pkg" });
		expect(value.createdAt).toBe(1000); // value carries SECONDS, not millis
		expect(value.cwd).toBeUndefined(); // the absolute cwd never leaves this machine
	});

	test("does NOT emit a prompt in a sync:false project", () => {
		const ws = makeDir("omp-hist-ws-");
		const foo = path.join(ws, "foo");
		const bar = path.join(ws, "bar");
		fs.mkdirSync(foo, { recursive: true });
		fs.mkdirSync(bar, { recursive: true });
		setProjects([
			{ id: "proj:foo", path: foo, sync: true },
			{ id: "proj:bar", path: bar, sync: false },
		]);

		const storage = openStorage();
		storage.mergeRemote([
			{ prompt: "kept", createdAt: 1000, cwd: foo },
			{ prompt: "secret", createdAt: 1000, cwd: bar },
		]);

		const keys = createHistoryDomain(storage)
			.changedSince(0, 10)
			.map(e => e.key);
		expect(keys).toEqual(["kept"]);
	});

	/**
	 * The watermark-stall regression. A page filled entirely with prompts too
	 * long to be wire keys must not make `changedSince` report "nothing to
	 * send": the sync engine reads an empty page as end-of-data and leaves the
	 * outbound watermark where it is, so a newer eligible prompt sitting beyond
	 * those rows would never replicate.
	 */
	test("a page of oversized prompts does not hide a newer eligible prompt", () => {
		const ws = makeDir("omp-hist-ws-");
		const foo = path.join(ws, "foo");
		fs.mkdirSync(foo, { recursive: true });
		setProjects([{ id: "proj:foo", path: foo, sync: true }]);

		const storage = openStorage();
		// Three prompts past the 4096-char wire cap, then a normal one that is
		// NEWER, so any correct scan has to walk past the oversized rows.
		const oversized = Array.from({ length: 3 }, (_, i) => ({
			prompt: `${"x".repeat(5000)}-${i}`,
			createdAt: 1000 + i,
			cwd: foo,
		}));
		storage.mergeRemote([...oversized, { prompt: "reachable", createdAt: 2000, cwd: foo }]);

		// A limit smaller than the oversized run is what turns the old post-filter
		// into a stall: the first page is entirely dropped.
		const entries = createHistoryDomain(storage).changedSince(0, 2);
		expect(entries.map(e => e.key)).toEqual(["reachable"]);
		// The rev the engine will adopt as its watermark must be the reachable
		// row's, so the next cycle resumes after it rather than re-reading it.
		expect(entries[0].rev).toBe(2000 * 1000);
	});

	test("applyRemote reconstructs the local absolute cwd for a mapped project (millis->seconds)", () => {
		const ws = makeDir("omp-hist-ws-");
		const foo = path.join(ws, "foo");
		fs.mkdirSync(foo, { recursive: true });
		setProjects([{ id: "proj:foo", path: foo, sync: true }]);

		const storage = openStorage();
		createHistoryDomain(storage).applyRemote([
			{
				key: "remote",
				rev: 2000 * 1000,
				value: { prompt: "remote", createdAt: 2000, project: { id: "proj:foo", rel: "pkg/a" } },
			},
		]);

		const row = storage.getRecent(10).find(r => r.prompt === "remote");
		expect(row?.cwd).toBe(path.join(foo, "pkg", "a"));
		expect(row?.created_at).toBe(2000); // stored back in SECONDS
	});

	test("applyRemote SKIPS an unmapped or sync-disabled project", () => {
		const ws = makeDir("omp-hist-ws-");
		const foo = path.join(ws, "foo");
		const bar = path.join(ws, "bar");
		fs.mkdirSync(foo, { recursive: true });
		fs.mkdirSync(bar, { recursive: true });
		setProjects([
			{ id: "proj:foo", path: foo, sync: true },
			{ id: "proj:bar", path: bar, sync: false },
		]);

		const storage = openStorage();
		createHistoryDomain(storage).applyRemote([
			{
				key: "ghost",
				rev: 3000 * 1000,
				value: { prompt: "ghost", createdAt: 3000, project: { id: "proj:ghost", rel: "" } },
			},
			{
				key: "disabled",
				rev: 3000 * 1000,
				value: { prompt: "disabled", createdAt: 3000, project: { id: "proj:bar", rel: "" } },
			},
		]);

		const prompts = storage.getRecent(10).map(r => r.prompt);
		expect(prompts).not.toContain("ghost");
		expect(prompts).not.toContain("disabled");
	});

	test("applyRemote tolerates a legacy bare-cwd entry: accepted, cwd dropped", () => {
		const storage = openStorage();
		createHistoryDomain(storage).applyRemote([
			{ key: "legacy", rev: 4000 * 1000, value: { prompt: "legacy", createdAt: 4000, cwd: "/origin/machine/only" } },
		]);

		const row = storage.getRecent(10).find(r => r.prompt === "legacy");
		expect(row).toBeDefined();
		expect(row?.cwd).toBeUndefined();
		expect(row?.created_at).toBe(4000);
	});

	test("scanChangedSinceForPaths: empty prefixes -> [], NULL cwd excluded", () => {
		const ws = makeDir("omp-hist-ws-");
		const foo = path.join(ws, "foo");
		fs.mkdirSync(foo, { recursive: true });
		const storage = openStorage();
		storage.mergeRemote([
			{ prompt: "under-foo", createdAt: 1000, cwd: path.join(foo, "x") },
			{ prompt: "no-cwd", createdAt: 1000 }, // cwd null
		]);

		expect(storage.scanChangedSinceForPaths(0, 10, [])).toEqual([]);
		const prompts = storage.scanChangedSinceForPaths(0, 10, [foo]).map(r => r.prompt);
		expect(prompts).toContain("under-foo");
		expect(prompts).not.toContain("no-cwd");
	});

	test("scanChangedSinceForPaths: LIKE metacharacters in a path do NOT over-match", () => {
		const ws = makeDir("omp-hist-ws-");
		const underscore = path.join(ws, "a_b"); // literal underscore
		const decoy = path.join(ws, "axb"); // matches `a_b` if `_` is a wildcard
		fs.mkdirSync(underscore, { recursive: true });
		fs.mkdirSync(decoy, { recursive: true });
		const storage = openStorage();
		storage.mergeRemote([
			{ prompt: "real", createdAt: 1000, cwd: path.join(underscore, "sub") },
			{ prompt: "decoy", createdAt: 1000, cwd: path.join(decoy, "sub") },
		]);

		const prompts = storage.scanChangedSinceForPaths(0, 10, [underscore]).map(r => r.prompt);
		expect(prompts).toContain("real");
		expect(prompts).not.toContain("decoy");
	});
});

describe("titles domain", () => {
	// A synced project under a mocked home plus a per-test temp sessions dir that
	// is INJECTED into the domain, so the outbound-title scan never reads the
	// process-wide sessions directory.
	function setupTitlesHome(): { home: string; foo: string; sessionsDir: string } {
		const home = makeDir("omp-titles-home-");
		homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
		const foo = path.join(home, "projects", "foo");
		fs.mkdirSync(foo, { recursive: true });
		setProjects([{ id: "proj:foo", path: foo, sync: true }]);
		const sessionsDir = path.join(makeDir("omp-titles-root-"), "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		return { home, foo, sessionsDir };
	}

	test("outbound is STRICT (only synced-project sessions) but inbound is PERMISSIVE", () => {
		const { foo, sessionsDir } = setupTitlesHome();
		// A session body inside the synced project's session dir makes its id
		// "synced" (ownership is confirmed from the body header's cwd); an id with
		// no such body is not.
		const fooSessionDir = path.join(sessionsDir, sessionDirNameForCwd(foo));
		writeSessionBody(fooSessionDir, "20250101-000000_sIN.jsonl", foo, "Inside Title");

		recordSessionTitle("sIN", "Inside Title");
		recordSessionTitle("sOUT", "Outside Title");

		const emitted = createTitlesDomain(sessionsDir).changedSince(0, 100);
		expect(emitted.map(e => e.key)).toEqual(["sIN"]);
		expect(Number.isInteger(emitted[0].rev)).toBe(true);
		// Shape produced by the titles domain itself; named const per cast rule.
		const value = emitted[0].value as { title: string };
		expect(value.title).toBe("Inside Title");

		// Inbound accepts a title for a session with no local body at all.
		createTitlesDomain(sessionsDir).applyRemote([
			{ key: "sUNKNOWN", rev: 9_000_000, value: { sessionId: "sUNKNOWN", title: "Remote Title", updatedAt: 9000 } },
		]);
		expect(lookupSessionTitle("sUNKNOWN")).toBe("Remote Title");
	});

	test("emits a title for a session started in a project SUBDIRECTORY", () => {
		// Regression: the titles domain once scanned only the project ROOT's
		// encoded dir, so a session under `~/projects/foo/pkg/a` (encoded dir
		// `-projects-foo-pkg-a`, not `-projects-foo`) never had its id in the
		// outbound set and its title never replicated — most sessions in a
		// monorepo. It now shares `scanOwnedSessionFiles` with the sessions domain.
		const { foo, sessionsDir } = setupTitlesHome();
		const subCwd = path.join(foo, "pkg", "a");
		fs.mkdirSync(subCwd, { recursive: true });
		const subDir = path.join(sessionsDir, sessionDirNameForCwd(subCwd));
		expect(path.basename(subDir)).toBe("-projects-foo-pkg-a");
		writeSessionBody(subDir, "20250102-000000_sSUB.jsonl", subCwd, "Sub Title");

		recordSessionTitle("sSUB", "Sub Title");

		const emitted = createTitlesDomain(sessionsDir).changedSince(0, 100);
		expect(emitted.map(e => e.key)).toContain("sSUB");
		// Shape produced by the titles domain itself; named const per cast rule.
		const value = emitted.find(e => e.key === "sSUB")?.value as { title: string };
		expect(value.title).toBe("Sub Title");
	});

	test("does NOT emit a title for a session under a name-prefix sibling project (leak guard)", () => {
		// `~/projects/foobar` -> `-projects-foobar` shares the name prefix of the
		// synced `~/projects/foo` (`-projects-foo`) but is a different,
		// unregistered project. The trailing-dash dir guard AND ownership
		// confirmation from the body header's cwd must both exclude it: a project
		// name or task title is exactly what a user disables sync to protect.
		const { home, foo, sessionsDir } = setupTitlesHome();
		const foobarCwd = path.join(home, "projects", "foobar");
		fs.mkdirSync(foobarCwd, { recursive: true });
		const foobarDir = path.join(sessionsDir, sessionDirNameForCwd(foobarCwd));
		expect(path.basename(foobarDir)).toBe("-projects-foobar");
		writeSessionBody(foobarDir, "20250103-000000_sLEAK.jsonl", foobarCwd, "Secret Title");

		// Seed a legitimate foo session so the scan is not trivially empty.
		writeSessionBody(
			path.join(sessionsDir, sessionDirNameForCwd(foo)),
			"20250103-000001_sOK.jsonl",
			foo,
			"Ok Title",
		);

		recordSessionTitle("sLEAK", "Secret Title");
		recordSessionTitle("sOK", "Ok Title");

		const keys = createTitlesDomain(sessionsDir)
			.changedSince(0, 100)
			.map(e => e.key);
		expect(keys).toContain("sOK");
		expect(keys).not.toContain("sLEAK");
	});
});

describe("sessions domain", () => {
	function setupHome(): { home: string; foo: string; sessionsDir: string } {
		const home = makeDir("omp-sess-home-");
		homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
		const foo = path.join(home, "projects", "foo");
		fs.mkdirSync(path.join(foo, "pkg", "a"), { recursive: true });
		setProjects([{ id: "proj:foo", path: foo, sync: true }]);
		const sessionsDir = path.join(makeDir("omp-sess-root-"), "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		return { home, foo, sessionsDir };
	}

	test("emits a subdirectory session with the correct relCwd and integer rev", () => {
		const { foo, sessionsDir } = setupHome();
		const subCwd = path.join(foo, "pkg", "a");
		const subDir = path.join(sessionsDir, sessionDirNameForCwd(subCwd));
		expect(path.basename(subDir)).toBe("-projects-foo-pkg-a");
		writeSessionBody(subDir, "aaaa1111.jsonl", subCwd, "Sub Session");

		const entries = createSessionsDomain(sessionsDir).changedSince(0, 100);
		expect(entries).toHaveLength(1);
		const [entry] = entries;
		expect(entry.key).toBe(encodeWireKey("proj:foo", "aaaa1111.jsonl"));
		expect(Number.isInteger(entry.rev)).toBe(true);
		// Index-entry shape produced by the sessions domain; named const per cast rule.
		const value = entry.value as { projectId: string; relCwd: string; title?: string };
		expect(value.projectId).toBe("proj:foo");
		expect(value.relCwd).toBe("pkg/a");
		expect(value.title).toBe("Sub Session");
	});

	test("never claims a sibling project that only shares a name prefix", () => {
		const { home, foo, sessionsDir } = setupHome();
		// `~/projects/foobar` -> `-projects-foobar`, which must NOT be swept by the
		// project rooted at `~/projects/foo` (`-projects-foo`).
		const foobarCwd = path.join(home, "projects", "foobar");
		fs.mkdirSync(foobarCwd, { recursive: true });
		const foobarDir = path.join(sessionsDir, sessionDirNameForCwd(foobarCwd));
		expect(path.basename(foobarDir)).toBe("-projects-foobar");
		writeSessionBody(foobarDir, "bbbb2222.jsonl", foobarCwd, "Sibling Session");

		// Also drop a legitimate foo session so the scan is not trivially empty.
		writeSessionBody(path.join(sessionsDir, sessionDirNameForCwd(foo)), "cccc3333.jsonl", foo, "Root Session");

		const entries = createSessionsDomain(sessionsDir).changedSince(0, 100);
		const keys = entries.map(e => e.key);
		expect(keys).toContain(encodeWireKey("proj:foo", "cccc3333.jsonl"));
		expect(keys).not.toContain(encodeWireKey("proj:foo", "bbbb2222.jsonl"));
		// No emitted session escapes the project root via a sibling path.
		for (const entry of entries) {
			const value = entry.value as { relCwd: string }; // domain-produced shape
			expect(value.relCwd.startsWith("..")).toBe(false);
		}
	});

	test("applyRemote places rows under THIS machine's encoded dir and skips unmapped projects", () => {
		const { sessionsDir } = setupHome();
		const domain = createSessionsDomain(sessionsDir);
		domain.applyRemote([
			{
				key: encodeWireKey("proj:foo", "dddd4444.jsonl"),
				rev: 55_000,
				value: {
					projectId: "proj:foo",
					relCwd: "pkg/a",
					file: "dddd4444.jsonl",
					size: 10,
					mtimeMs: 55_000,
					title: "Remote",
				},
			},
			{
				key: encodeWireKey("proj:ghost", "eeee5555.jsonl"),
				rev: 66_000,
				value: { projectId: "proj:ghost", relCwd: "", file: "eeee5555.jsonl", size: 10, mtimeMs: 66_000 },
			},
		]);

		const index = readRemoteSessionIndex(sessionsDir);
		const mapped = index.find(e => e.projectId === "proj:foo");
		expect(mapped?.rel).toBe("-projects-foo-pkg-a/dddd4444.jsonl");
		expect(mapped?.relCwd).toBe("pkg/a");
		expect(mapped?.mtimeMs).toBe(55_000);
		expect(mapped?.title).toBe("Remote");
		// Unmapped project fails closed: never recorded.
		expect(index.some(e => e.projectId === "proj:ghost")).toBe(false);
	});

	/**
	 * Trust-boundary regression. The wire key's filename and the value's `relCwd`
	 * both come from a peer and are both joined into a local path, so a `..`
	 * segment in either would name a file outside the sessions dir. Selecting
	 * such a row makes the resume path open (and create) that path.
	 */
	test("applyRemote refuses traversal in the wire filename", () => {
		const { sessionsDir } = setupHome();
		const domain = createSessionsDomain(sessionsDir);
		domain.applyRemote([
			{
				key: encodeWireKey("proj:foo", "../../../../tmp/evil.jsonl"),
				rev: 70_000,
				value: { projectId: "proj:foo", relCwd: "", file: "x.jsonl", size: 1, mtimeMs: 70_000 },
			},
			{
				key: encodeWireKey("proj:foo", "nested/evil.jsonl"),
				rev: 71_000,
				value: { projectId: "proj:foo", relCwd: "", file: "x.jsonl", size: 1, mtimeMs: 71_000 },
			},
			// A non-.jsonl name would not be opened as a session body either.
			{
				key: encodeWireKey("proj:foo", "authorized_keys"),
				rev: 72_000,
				value: { projectId: "proj:foo", relCwd: "", file: "x.jsonl", size: 1, mtimeMs: 72_000 },
			},
		]);

		const index = readRemoteSessionIndex(sessionsDir);
		expect(index).toHaveLength(0);
	});

	test("applyRemote refuses a relCwd that escapes the project", () => {
		const { sessionsDir } = setupHome();
		createSessionsDomain(sessionsDir).applyRemote([
			{
				key: encodeWireKey("proj:foo", "ffff6666.jsonl"),
				rev: 80_000,
				value: {
					projectId: "proj:foo",
					relCwd: "../../../../etc",
					file: "ffff6666.jsonl",
					size: 1,
					mtimeMs: 80_000,
				},
			},
		]);

		expect(readRemoteSessionIndex(sessionsDir)).toHaveLength(0);
	});

	/**
	 * A live enumeration cannot see a session that is gone, so without a
	 * publication ledger a delete never reaches the broker. The row then stays
	 * on the wire, this replica pulls its OWN stale row back, and the deleted
	 * session reappears as a remote-only stub whose body is still archived, so
	 * selecting it downloads the session the user just deleted.
	 */
	test("emits a tombstone for a session it published and no longer has", () => {
		const { foo, sessionsDir } = setupHome();
		const store = new StateSyncStore(path.join(makeDir("omp-sess-sync-"), "sync.db"));
		try {
			const dir = path.join(sessionsDir, sessionDirNameForCwd(foo));
			writeSessionBody(dir, "dddd4444.jsonl", foo, "Doomed");
			const domain = createSessionsDomain(sessionsDir, store);

			// Publish it, which is what records the key in the ledger.
			const first = domain.changedSince(0, 100);
			expect(first).toHaveLength(1);
			const published = first[0];
			expect(published.value).not.toBeNull();

			// The user deletes the session.
			fs.rmSync(path.join(dir, "dddd4444.jsonl"));
			invalidateSessionOwnerCache();

			const after = domain.changedSince(published.rev, 100);
			expect(after).toHaveLength(1);
			expect(after[0].key).toBe(published.key);
			expect(after[0].value).toBeNull(); // tombstone
			// The tombstone must be newer than the row it retracts, or LWW on the
			// receiving side would ignore it.
			expect(after[0].rev).toBeGreaterThan(published.rev);
		} finally {
			store.close();
		}
	});

	test("re-offers an undelivered tombstone instead of dropping it", () => {
		const { foo, sessionsDir } = setupHome();
		const store = new StateSyncStore(path.join(makeDir("omp-sess-sync-"), "sync.db"));
		try {
			const dir = path.join(sessionsDir, sessionDirNameForCwd(foo));
			writeSessionBody(dir, "eeee5555.jsonl", foo, "Doomed");
			const domain = createSessionsDomain(sessionsDir, store);
			const published = domain.changedSince(0, 100)[0];

			fs.rmSync(path.join(dir, "eeee5555.jsonl"));
			invalidateSessionOwnerCache();

			// Two scans at the same watermark, as happens when a push fails and the
			// cursor therefore never advanced: the same tombstone rev comes back.
			const a = domain.changedSince(published.rev, 100);
			const b = domain.changedSince(published.rev, 100);
			expect(a).toHaveLength(1);
			expect(b).toHaveLength(1);
			expect(b[0].rev).toBe(a[0].rev);
			expect(b[0].value).toBeNull();
		} finally {
			store.close();
		}
	});

	/**
	 * A tombstone must outrank the row it retracts. Deleting a session in the
	 * same millisecond it was published makes `Date.now()` equal to the
	 * published rev (which is the body's floored mtime), and an equal rev both
	 * fails the domain's own `rev > afterRev` emit test and loses to LWW on the
	 * receiving side. The clock is pinned here so the race is deterministic
	 * rather than dependent on how fast the suite runs.
	 */
	test("a deletion in the same millisecond as its publication still tombstones", () => {
		const { foo, sessionsDir } = setupHome();
		const store = new StateSyncStore(path.join(makeDir("omp-sess-sync-"), "sync.db"));
		const nowSpy = spyOn(Date, "now");
		try {
			const dir = path.join(sessionsDir, sessionDirNameForCwd(foo));
			writeSessionBody(dir, "ffff6666.jsonl", foo, "Doomed");
			const domain = createSessionsDomain(sessionsDir, store);
			const published = domain.changedSince(0, 100)[0];

			fs.rmSync(path.join(dir, "ffff6666.jsonl"));
			invalidateSessionOwnerCache();
			// The worst case: the wall clock reads exactly the published rev.
			nowSpy.mockReturnValue(published.rev);

			const after = domain.changedSince(published.rev, 100);
			expect(after).toHaveLength(1);
			expect(after[0].value).toBeNull();
			expect(after[0].rev).toBeGreaterThan(published.rev);
		} finally {
			nowSpy.mockRestore();
			store.close();
		}
	});

	/**
	 * Turning sync off for a project must not look like deleting its sessions.
	 * The scan intentionally stops enumerating a disabled project, so treating
	 * every published-but-absent key as a deletion published tombstones that
	 * removed those sessions from every OTHER machine. They could not even be
	 * restored by re-enabling, since the surviving bodies keep their original
	 * mtimes and lose LWW against the newer tombstone.
	 */
	test("disabling a project does not tombstone its sessions", () => {
		const { foo, sessionsDir } = setupHome();
		const store = new StateSyncStore(path.join(makeDir("omp-sess-sync-"), "sync.db"));
		try {
			const dir = path.join(sessionsDir, sessionDirNameForCwd(foo));
			writeSessionBody(dir, "aaaa1111.jsonl", foo, "Kept");
			const domain = createSessionsDomain(sessionsDir, store);
			const published = domain.changedSince(0, 100);
			expect(published).toHaveLength(1);

			// Sync off, body untouched on disk.
			setProjects([{ id: "proj:foo", path: foo, sync: false }]);
			invalidateSessionOwnerCache();

			expect(domain.changedSince(published[0].rev, 100)).toEqual([]);
			// And re-enabling must still see the session as live, not deleted.
			setProjects([{ id: "proj:foo", path: foo, sync: true }]);
			invalidateSessionOwnerCache();
			expect(domain.changedSince(published[0].rev, 100)).toEqual([]);
			expect(domain.changedSince(0, 100)[0]?.value).not.toBeNull();
		} finally {
			store.close();
		}
	});

	/**
	 * Same rule for a scan that could not read the disk. `readdir` failing on
	 * the sessions root used to be indistinguishable from an empty root, so one
	 * transient EACCES/EMFILE would tombstone every session this replica had
	 * ever published.
	 */
	test("an unreadable sessions root does not tombstone anything", () => {
		const { foo, sessionsDir } = setupHome();
		const store = new StateSyncStore(path.join(makeDir("omp-sess-sync-"), "sync.db"));
		const readdirSpy = spyOn(fs, "readdirSync");
		try {
			const dir = path.join(sessionsDir, sessionDirNameForCwd(foo));
			writeSessionBody(dir, "bbbb2222.jsonl", foo, "Kept");
			const domain = createSessionsDomain(sessionsDir, store);
			const published = domain.changedSince(0, 100);
			expect(published).toHaveLength(1);

			invalidateSessionOwnerCache();
			readdirSpy.mockImplementation(() => {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			});
			expect(domain.changedSince(published[0].rev, 100)).toEqual([]);
		} finally {
			readdirSpy.mockRestore();
			store.close();
		}
	});
});

describe("config domain + config-files", () => {
	test("enumerateConfigFiles includes config/models yml and agents/*, excludes secrets and projects.yml", () => {
		const dir = makeDir("omp-cfg-agent-");
		fs.writeFileSync(path.join(dir, "config.yml"), "a: 1\n");
		fs.writeFileSync(path.join(dir, "models.yml"), "b: 2\n");
		fs.writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
		fs.writeFileSync(path.join(dir, "secrets.yml"), "k: v\n");
		fs.writeFileSync(path.join(dir, "secret-placeholder.key"), "hmac\n");
		fs.writeFileSync(path.join(dir, "projects.yml"), "projects: []\n");
		fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, "agents", "reviewer.md"), "# reviewer\n");

		const rels = enumerateConfigFiles(dir).map(f => f.rel);
		expect(rels).toContain("config.yml");
		expect(rels).toContain("models.yml");
		expect(rels).toContain(path.join("agents", "reviewer.md"));
		for (const excluded of [".env", "secrets.yml", "secret-placeholder.key", "projects.yml"]) {
			expect(rels).not.toContain(excluded);
		}
	});

	test("oversized files (> MAX_CONFIG_FILE_BYTES) are excluded", () => {
		const dir = makeDir("omp-cfg-agent-");
		fs.writeFileSync(path.join(dir, "config.yml"), "small: true\n");
		fs.writeFileSync(path.join(dir, "models.yml"), "x".repeat(MAX_CONFIG_FILE_BYTES + 1));
		const rels = enumerateConfigFiles(dir).map(f => f.rel);
		expect(rels).toContain("config.yml");
		expect(rels).not.toContain("models.yml");
	});

	test("readConfigFile / writeConfigFileAtomic reject path traversal", () => {
		const dir = makeDir("omp-cfg-agent-");
		for (const evil of ["../evil", path.join(dir, "abs.yml"), path.join("agents", "..", "..", "evil")]) {
			expect(() => readConfigFile(dir, evil)).toThrow();
			expect(() => writeConfigFileAtomic(dir, evil, "x", Date.now())).toThrow();
		}
		// None of the traversal targets were created.
		expect(fs.existsSync(path.join(path.dirname(dir), "evil"))).toBe(false);
	});

	test("writeConfigFileAtomic pins mtime so the file does not immediately re-push", () => {
		const dir = makeDir("omp-cfg-agent-");
		const mtimeMs = 1_700_000_000_000; // whole seconds so utimes round-trips exactly
		writeConfigFileAtomic(dir, "config.yml", "pinned: true\n", mtimeMs);
		expect(configFileMtimeMs(dir, "config.yml")).toBe(mtimeMs);

		const domain = createConfigDomain(dir);
		// A watermark AT the file's rev must not re-report it (strictly-greater).
		expect(domain.changedSince(mtimeMs, 100).some(e => e.key === "config.yml")).toBe(false);
		// A watermark BEFORE it does report it.
		expect(domain.changedSince(mtimeMs - 1000, 100).some(e => e.key === "config.yml")).toBe(true);
	});
});
