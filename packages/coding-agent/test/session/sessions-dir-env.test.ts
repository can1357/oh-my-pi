import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

interface SessionRecord {
	cwd: string;
	id: string;
	file: string;
	artifactsDir: string;
}

interface SessionsResult {
	sessions: SessionRecord[];
	picker: Record<string, string[]>;
	all: string[];
	resumeById: Record<string, string[]>;
	stats: Record<string, { folder: string; agentType: string }>;
	stores: { sessions: string; agentDb: string; historyDb: string; modelsDb: string; blobs: string };
}

interface GcResult {
	session: SessionRecord;
	archive: { archived: number; errors: string[] };
}

interface ResolveResult {
	agentDir: string;
	rows: Array<{ value: string; implicit: string; explicitDefault: string; explicitOther: string }>;
}

interface ImageResult {
	session: SessionRecord;
	blob: string;
}

interface LifetimeResult {
	before: SessionRecord;
	after: SessionRecord;
	sessionsDir: string;
}

interface TraceResult {
	summaries: string[];
	trace: string;
}

interface BlobGcReport {
	referenced: number;
	deleted: number;
	errors: string[];
}

const FIXTURE = path.join(import.meta.dir, "../fixtures/sessions-dir-env.ts");
const CLI = path.join(import.meta.dir, "../../src/cli.ts");

interface SpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Runs `argv` under Bun as a fresh omp process: a temp HOME, so the default
 * agent directory is `<home>/.omp/agent`, and only the variables in `env` set
 * (an `undefined` value removes the variable).
 */
async function spawnInHome(
	home: string,
	env: Record<string, string | undefined>,
	argv: string[],
): Promise<SpawnResult> {
	const child = Bun.spawn([process.execPath, ...argv], {
		cwd: home,
		env: {
			...process.env,
			// os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
			HOME: home,
			USERPROFILE: home,
			OMP_PROFILE: undefined,
			PI_PROFILE: undefined,
			PI_CODING_AGENT_DIR: undefined,
			PI_CODING_AGENT_SESSION_DIR: undefined,
			PI_CONFIG_DIR: ".omp",
			PI_CONFIG_FILES: undefined,
			XDG_DATA_HOME: undefined,
			XDG_STATE_HOME: undefined,
			XDG_CACHE_HOME: undefined,
			OMP_SESSIONS_DIR: undefined,
			...env,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function runFixture(home: string, env: Record<string, string | undefined>, args: string[]): Promise<unknown> {
	const resultFile = path.join(home, "result.json");
	const { stderr, exitCode } = await spawnInHome(home, env, [FIXTURE, resultFile, ...args]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	return Bun.file(resultFile).json();
}

/** Runs the real `omp` command line and returns its stdout; its stderr shows only on failure. */
async function runOmp(home: string, env: Record<string, string | undefined>, args: string[]): Promise<string> {
	const { stdout, stderr, exitCode } = await spawnInHome(home, env, [CLI, ...args]);
	expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
	return stdout;
}

function makeHome(temp: TempDir, ...projects: string[]): { home: string; cwds: string[] } {
	const home = path.join(temp.path(), "home");
	const cwds = projects.map(project => path.join(home, project));
	for (const cwd of cwds) fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	return { home, cwds };
}

/** Each session sits in its own cwd bucket directly under `root`; its artifacts sit beside it. */
function expectBucketedUnder(root: string, sessions: SessionRecord[]): void {
	for (const session of sessions) {
		expect(path.dirname(path.dirname(session.file))).toBe(root);
		expect(fs.existsSync(session.file)).toBe(true);
		// Tool output (`artifact://`, PI_ARTIFACTS_DIR) follows the transcript.
		expect(path.dirname(session.artifactsDir)).toBe(path.dirname(session.file));
	}
	expect(new Set(sessions.map(session => path.dirname(session.file))).size).toBe(sessions.length);
}

describe("OMP_SESSIONS_DIR", () => {
	it("writes each cwd's sessions to its own directory under the relocated root, and every reader follows it", async () => {
		using temp = TempDir.createSync("@omp-sessions-dir-");
		const { home, cwds } = makeHome(temp, "alpha", "beta");
		const relocated = path.join(temp.path(), "durable", "omp-sessions");

		const result = (await runFixture(home, { OMP_SESSIONS_DIR: relocated }, ["sessions", ...cwds])) as SessionsResult;

		const [alpha, beta] = result.sessions;
		expectBucketedUnder(relocated, result.sessions);
		expect(result.picker).toEqual({ [alpha.cwd]: [alpha.id], [beta.cwd]: [beta.id] });
		expect(result.all.sort()).toEqual([alpha.id, beta.id].sort());
		expect(result.resumeById).toEqual({ [alpha.id]: [alpha.file], [beta.id]: [beta.file] });
		for (const session of result.sessions) {
			expect(result.stats[session.id]).toEqual({
				folder: path.basename(path.dirname(session.file)),
				agentType: "main",
			});
		}

		const agentDir = path.join(home, ".omp", "agent");
		expect(fs.existsSync(path.join(agentDir, "sessions"))).toBe(false);
		expect(result.stores).toEqual({
			sessions: relocated,
			agentDb: path.join(agentDir, "agent.db"),
			historyDb: path.join(agentDir, "history.db"),
			modelsDb: path.join(agentDir, "models.db"),
			blobs: path.join(agentDir, "blobs"),
		});
	}, 60_000);

	it("resolves every spelling: absolute, padded, trailing separator, ~-relative; relative and blank values are ignored", async () => {
		using temp = TempDir.createSync("@omp-sessions-dir-resolve-");
		const { home } = makeHome(temp);
		const relocated = path.join(temp.path(), "durable", "omp-sessions");
		const otherAgentDir = path.join(temp.path(), "scratch-agent");
		const defaultRoot = path.join(home, ".omp", "agent", "sessions");
		const expected: Array<[string, string]> = [
			[relocated, relocated],
			[`  ${relocated}  `, relocated],
			[`${path.join(temp.path(), "durable", "tmp", "..", "omp-sessions")}${path.sep}`, relocated],
			["~/durable-sessions", path.join(home, "durable-sessions")],
			["durable/omp-sessions", defaultRoot],
			["", defaultRoot],
			["   ", defaultRoot],
		];

		const result = (await runFixture(home, {}, [
			"resolve",
			otherAgentDir,
			...expected.map(([value]) => value),
		])) as ResolveResult;

		expect(result.agentDir).toBe(path.join(home, ".omp", "agent"));
		expect(result.rows).toEqual(
			expected.map(([value, root]) => ({
				value,
				implicit: root,
				explicitDefault: root,
				// An agent directory the caller names (`gc --agent-dir`, the SDK's `agentDir`) keeps its own sessions.
				explicitOther: path.join(otherAgentDir, "sessions"),
			})),
		);
	}, 60_000);

	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"relocates the sessions root out of an XDG data home and leaves the stores there",
		async () => {
			using temp = TempDir.createSync("@omp-sessions-dir-xdg-");
			const { home, cwds } = makeHome(temp, "alpha");
			const relocated = path.join(temp.path(), "durable", "omp-sessions");
			const xdgData = path.join(temp.path(), "xdg-data");
			const xdgOmp = path.join(xdgData, "omp");
			fs.mkdirSync(xdgOmp, { recursive: true });

			const result = (await runFixture(home, { OMP_SESSIONS_DIR: relocated, XDG_DATA_HOME: xdgData }, [
				"sessions",
				...cwds,
			])) as SessionsResult;

			expectBucketedUnder(relocated, result.sessions);
			expect(fs.existsSync(path.join(xdgOmp, "sessions"))).toBe(false);
			expect(result.stores).toEqual({
				sessions: relocated,
				agentDb: path.join(xdgOmp, "agent.db"),
				historyDb: path.join(xdgOmp, "history.db"),
				modelsDb: path.join(xdgOmp, "models.db"),
				blobs: path.join(xdgOmp, "blobs"),
			});
		},
		60_000,
	);

	const scopeRows: Array<{
		label: string;
		env: (home: string) => Record<string, string>;
		agentDir: (home: string) => string;
	}> = [
		{
			label: "PI_CODING_AGENT_DIR",
			env: home => ({ PI_CODING_AGENT_DIR: path.join(home, "custom-agent") }),
			agentDir: home => path.join(home, "custom-agent"),
		},
		{
			label: "a named profile",
			env: () => ({ OMP_PROFILE: "work" }),
			agentDir: home => path.join(home, ".omp", "profiles", "work", "agent"),
		},
	];
	// Tests and other tools isolate omp by relocating its agent directory; an
	// exported OMP_SESSIONS_DIR must not pull their sessions into the shared root.
	it.each(scopeRows)(
		"leaves the sessions of an agent directory chosen by $label in that directory",
		async row => {
			using temp = TempDir.createSync("@omp-sessions-dir-scope-");
			const { home, cwds } = makeHome(temp, "alpha");
			const relocated = path.join(temp.path(), "durable", "omp-sessions");

			const result = (await runFixture(home, { OMP_SESSIONS_DIR: relocated, ...row.env(home) }, [
				"sessions",
				...cwds,
			])) as SessionsResult;

			expectBucketedUnder(path.join(row.agentDir(home), "sessions"), result.sessions);
			expect(fs.existsSync(relocated)).toBe(false);
		},
		60_000,
	);

	it("omp gc archives a cold session out of the relocated root into the agent directory's archive", async () => {
		using temp = TempDir.createSync("@omp-sessions-dir-gc-");
		const { home, cwds } = makeHome(temp, "alpha");
		const relocated = path.join(temp.path(), "durable", "omp-sessions");

		const result = (await runFixture(home, { OMP_SESSIONS_DIR: relocated }, ["gc", ...cwds])) as GcResult;

		const { file } = result.session;
		expect(path.dirname(path.dirname(file))).toBe(relocated);
		expect(result.archive).toMatchObject({ archived: 1, errors: [] });
		expect(fs.existsSync(file)).toBe(false);
		const archiveRoot = path.join(home, ".omp", "agent", "archive", "sessions");
		expect(
			fs.existsSync(path.join(archiveRoot, path.basename(path.dirname(file)), `${path.basename(file)}.gz`)),
		).toBe(true);
		// The archive must not land beside the relocated root, in a directory nobody chose.
		expect(fs.existsSync(path.join(path.dirname(relocated), "archive"))).toBe(false);
	}, 60_000);

	it("keeps the sessions root a process started with when the variable changes while it runs", async () => {
		using temp = TempDir.createSync("@omp-sessions-dir-lifetime-");
		const { home, cwds } = makeHome(temp, "alpha");
		const initial = path.join(temp.path(), "initial-sessions");
		const later = path.join(temp.path(), "later-sessions");

		const result = (await runFixture(home, { OMP_SESSIONS_DIR: initial }, [
			"lifetime",
			cwds[0],
			later,
		])) as LifetimeResult;

		expect(result.sessionsDir).toBe(initial);
		expectBucketedUnder(initial, [result.before]);
		expectBucketedUnder(initial, [result.after]);
		expect(fs.existsSync(later)).toBe(false);
	}, 60_000);

	it("takes the variable from the agent directory's .env file, like the other directory variables", async () => {
		using temp = TempDir.createSync("@omp-sessions-dir-dotenv-");
		const { home, cwds } = makeHome(temp, "alpha");
		const relocated = path.join(temp.path(), "durable", "omp-sessions");
		const agentDir = path.join(home, ".omp", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, ".env"), `OMP_SESSIONS_DIR=${relocated}\n`);

		const result = (await runFixture(home, {}, ["sessions", ...cwds])) as SessionsResult;

		expectBucketedUnder(relocated, result.sessions);
		expect(result.stores.sessions).toBe(relocated);
	}, 60_000);
});

describe("omp gc after the sessions root moves", () => {
	// A transcript stays in the root it was written to while its images sit in
	// the agent directory's one blob store, so gc must keep those blobs however
	// `OMP_SESSIONS_DIR` was set when each session was written and when gc runs.
	// `undefined` is the agent directory's own `sessions`.
	const rows: Array<{ label: string; written: Array<string | undefined>; gc: string | undefined }> = [
		{
			label: "the variable is set after sessions were written to the default root",
			written: [undefined],
			gc: "first",
		},
		{ label: "the variable is removed after sessions were written under it", written: ["first"], gc: undefined },
		{ label: "the variable moved twice since sessions were written", written: ["first", "second"], gc: "third" },
	];
	it.each(rows)(
		"keeps every image blob a retained session references when $label",
		async row => {
			using temp = TempDir.createSync("@omp-sessions-dir-blobs-");
			const { home, cwds } = makeHome(temp, "alpha");
			const rootFor = (name: string | undefined) =>
				name === undefined ? undefined : path.join(temp.path(), `${name}-sessions`);
			const written: ImageResult[] = [];
			for (const [index, name] of row.written.entries()) {
				written.push(
					(await runFixture(home, { OMP_SESSIONS_DIR: rootFor(name) }, [
						"image",
						cwds[0],
						String(index + 1),
					])) as ImageResult,
				);
			}
			// An old blob nothing references: a run that deletes nothing would prove nothing.
			const orphan = path.join(home, ".omp", "agent", "blobs", new Bun.SHA256().update("orphan").digest("hex"));
			fs.writeFileSync(orphan, "orphan");
			const old = new Date(Date.now() - 3 * 86_400_000);
			fs.utimesSync(orphan, old, old);

			const report = JSON.parse(
				await runOmp(home, { OMP_SESSIONS_DIR: rootFor(row.gc) }, ["gc", "--blobs", "--apply", "--json"]),
			) as { blobs: BlobGcReport };

			expect(report.blobs).toMatchObject({ referenced: written.length, deleted: 1, errors: [] });
			for (const { session, blob } of written) {
				expect(fs.existsSync(session.file)).toBe(true);
				expect(fs.existsSync(blob)).toBe(true);
			}
			expect(fs.existsSync(orphan)).toBe(false);
		},
		120_000,
	);

	it("keeps the blobs of sessions moved by hand into a root an earlier omp gc ran under", async () => {
		using temp = TempDir.createSync("@omp-sessions-dir-moved-");
		const { home, cwds } = makeHome(temp, "alpha");
		const relocated = path.join(temp.path(), "durable-sessions");
		const { session, blob } = (await runFixture(home, {}, ["image", cwds[0], "1"])) as ImageResult;
		// The finished sessions move to the new root, and gc runs there before any new session does.
		const bucket = path.dirname(session.file);
		const movedBucket = path.join(relocated, path.basename(bucket));
		fs.mkdirSync(relocated, { recursive: true });
		fs.renameSync(bucket, movedBucket);
		await runOmp(home, { OMP_SESSIONS_DIR: relocated }, ["gc", "--json"]);

		// A later run without the variable (another shell, a service) must still read that root.
		const report = JSON.parse(await runOmp(home, {}, ["gc", "--blobs", "--apply", "--json"])) as {
			blobs: BlobGcReport;
		};

		expect(report.blobs).toMatchObject({ referenced: 1, deleted: 0, errors: [] });
		expect(fs.existsSync(path.join(movedBucket, path.basename(session.file)))).toBe(true);
		expect(fs.existsSync(blob)).toBe(true);
	}, 120_000);
});

describe("omp stats after the sessions root moves", () => {
	it("counts, classifies and traces a session continued in a previous sessions root", async () => {
		using temp = TempDir.createSync("@omp-sessions-dir-stats-");
		const { home, cwds } = makeHome(temp, "alpha");
		const first = path.join(temp.path(), "first-sessions");
		const second = path.join(temp.path(), "second-sessions");
		const {
			sessions: [session],
		} = (await runFixture(home, { OMP_SESSIONS_DIR: first }, ["sessions", cwds[0]])) as SessionsResult;
		// After the move, `--resume <path>` or `--continue` appends to the transcript where it is.
		await runFixture(home, { OMP_SESSIONS_DIR: second }, ["append", session.file]);

		await runOmp(home, { OMP_SESSIONS_DIR: second }, ["stats", "--json"]);

		const folder = path.basename(path.dirname(session.file));
		const db = new Database(path.join(home, ".omp", "stats.db"), { readonly: true });
		try {
			expect(db.query("SELECT folder, agent_type FROM messages WHERE session_file = ?").all(session.file)).toEqual([
				{ folder, agent_type: "main" },
				{ folder, agent_type: "main" },
			]);
		} finally {
			db.close();
		}
		const traced = (await runFixture(home, { OMP_SESSIONS_DIR: second }, ["trace", session.file])) as TraceResult;
		expect(traced).toEqual({ summaries: [session.file], trace: session.file });
	}, 120_000);
});

// Permission bits do not bind root, and Windows has none of these modes.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"omp gc when the record of sessions roots is in doubt",
	() => {
		// gc may delete a blob only when it has read every place a reference can
		// be. Each case writes a session with an image under `OMP_SESSIONS_DIR`,
		// damages the record of that root or the root itself, then runs the real
		// `omp gc --blobs --apply` without the variable: gc must keep the blob and
		// say why, never read the doubt as an empty root.
		interface Doubt {
			label: string;
			/** Runs before the session is written. */
			before?: (ctx: { registry: string }) => void;
			/** Damages the record or the root; returns how to put permissions back. */
			damage: (ctx: { home: string; registry: string; root: string }) => (() => void) | undefined;
		}
		const onlyEntry = (registry: string) => {
			const entries = fs.readdirSync(registry).filter(name => !name.endsWith(".tmp"));
			expect(entries).toHaveLength(1);
			return path.join(registry, entries[0]);
		};
		const moveRootAway = (home: string, root: string) => fs.renameSync(root, path.join(home, "saved-root"));
		const doubts: Doubt[] = [
			{ label: "the registry is removed", damage: ({ registry }) => void fs.rmSync(registry, { recursive: true }) },
			{ label: "the registry is emptied", damage: ({ registry }) => void fs.unlinkSync(onlyEntry(registry)) },
			{ label: "the entry is empty", damage: ({ registry }) => void fs.writeFileSync(onlyEntry(registry), "") },
			{
				label: "the entry is relative",
				damage: ({ registry }) => void fs.writeFileSync(onlyEntry(registry), "relative/sessions"),
			},
			{
				label: "the entry is corrupt",
				damage: ({ registry }) => void fs.writeFileSync(onlyEntry(registry), "\0{]"),
			},
			{
				label: "the entry names another directory",
				damage: ({ home, registry }) => void fs.writeFileSync(onlyEntry(registry), path.join(home, "elsewhere")),
			},
			{
				label: "the entry is truncated",
				damage: ({ registry }) => {
					const entry = onlyEntry(registry);
					fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").slice(0, -4));
					return undefined;
				},
			},
			{
				label: "the entry is left under a staging name",
				damage: ({ registry }) => {
					const entry = onlyEntry(registry);
					fs.renameSync(entry, `${entry}.999.tmp`);
					return undefined;
				},
			},
			{
				label: "the registry could not be written when the session was saved",
				before: ({ registry }) => {
					fs.mkdirSync(registry, { recursive: true });
					fs.chmodSync(registry, 0o500);
				},
				damage: ({ registry }) => void fs.chmodSync(registry, 0o700),
			},
			{
				label: "the entry is unreadable",
				damage: ({ registry }) => {
					const entry = onlyEntry(registry);
					fs.chmodSync(entry, 0);
					return () => fs.chmodSync(entry, 0o600);
				},
			},
			{
				label: "the registry is unreadable",
				damage: ({ registry }) => {
					fs.chmodSync(registry, 0);
					return () => fs.chmodSync(registry, 0o700);
				},
			},
			{
				label: "the registry is a file",
				damage: ({ home, registry }) => {
					fs.renameSync(registry, path.join(home, "saved-registry"));
					fs.writeFileSync(registry, "not a directory");
					return undefined;
				},
			},
			{
				label: "the root is unreadable",
				damage: ({ root }) => {
					fs.chmodSync(root, 0);
					return () => fs.chmodSync(root, 0o700);
				},
			},
			{ label: "the root is missing", damage: ({ home, root }) => void moveRootAway(home, root) },
			{
				label: "the root is a file",
				damage: ({ home, root }) => {
					moveRootAway(home, root);
					fs.writeFileSync(root, "not a directory");
					return undefined;
				},
			},
			{
				label: "the root is a dangling symlink",
				damage: ({ home, root }) => {
					moveRootAway(home, root);
					fs.symlinkSync(path.join(home, "unavailable-target"), root, "dir");
					return undefined;
				},
			},
			{
				// An unmounted disk leaves its empty mount point: another directory at the same path.
				label: "the root is an empty directory in its place",
				damage: ({ home, root }) => {
					moveRootAway(home, root);
					fs.mkdirSync(root);
					return undefined;
				},
			},
		];
		it.each(doubts)(
			"keeps the blob and reports why when $label",
			async doubt => {
				using temp = TempDir.createSync("@omp-sessions-dir-doubt-");
				const { home, cwds } = makeHome(temp, "alpha");
				const root = path.join(home, "old-root");
				const registry = path.join(home, ".omp", "agent", "sessions-roots");
				doubt.before?.({ registry });
				const { blob } = (await runFixture(home, { OMP_SESSIONS_DIR: root }, [
					"image",
					cwds[0],
					"1",
				])) as ImageResult;
				const restore = doubt.damage({ home, registry, root });
				let run: SpawnResult;
				try {
					run = await spawnInHome(home, {}, [CLI, "gc", "--blobs", "--apply", "--json"]);
				} finally {
					restore?.();
				}

				expect(fs.existsSync(blob)).toBe(true);
				expect(run.exitCode).not.toBe(0);
				const report = JSON.parse(run.stdout) as { blobs: BlobGcReport };
				expect(report.blobs.deleted).toBe(0);
				expect(report.blobs.errors.length).toBeGreaterThan(0);
			},
			120_000,
		);

		// A path is any byte string: the record must give back exactly the root it was given.
		it.each(["old-root ", "old-root\n"])(
			"reads a root whose name ends in whitespace back exactly (%j)",
			async name => {
				using temp = TempDir.createSync("@omp-sessions-dir-exact-");
				const { home, cwds } = makeHome(temp, "alpha");
				// The trailing separator keeps the whitespace from being trimmed as padding.
				const root = `${path.join(home, name)}${path.sep}`;
				const { blob } = (await runFixture(home, { OMP_SESSIONS_DIR: root }, [
					"image",
					cwds[0],
					"1",
				])) as ImageResult;

				const report = JSON.parse(await runOmp(home, {}, ["gc", "--blobs", "--apply", "--json"])) as {
					blobs: BlobGcReport;
				};

				expect(report.blobs).toMatchObject({ referenced: 1, deleted: 0, errors: [] });
				expect(fs.existsSync(blob)).toBe(true);
			},
			120_000,
		);
	},
);
