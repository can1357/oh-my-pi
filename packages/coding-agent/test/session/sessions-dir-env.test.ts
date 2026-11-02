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

const FIXTURE = path.join(import.meta.dir, "../fixtures/sessions-dir-env.ts");

/**
 * Runs the fixture as a fresh omp process: a temp HOME, so the default agent
 * directory is `<home>/.omp/agent`, and only the variables in `env` set.
 */
async function runFixture(home: string, env: Record<string, string>, args: string[]): Promise<unknown> {
	const resultFile = path.join(home, "result.json");
	const child = Bun.spawn([process.execPath, FIXTURE, resultFile, ...args], {
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
	const [, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	return Bun.file(resultFile).json();
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
});
