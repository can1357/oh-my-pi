import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const PROBE = path.join(import.meta.dir, "fixtures", "hermetic-env-probe.ts");
const PRELOAD = path.join(REPO_ROOT, "scripts", "test-hermetic-env.ts");

// What an omp bash tool exports into the shell a developer runs the suite from.
const USER_ENV: Record<string, string> = {
	PI_CONFIG_FILES: "/home/user/.omp/overlay.yml",
	PI_SHELL_PREFIX: "set +e;",
	CLAUDE_CODE_SHELL_PREFIX: "set +e;",
	CLAUDE_CONFIG_DIR: "/home/user/.claude",
	XDG_CONFIG_HOME: "/home/user/.config",
	PI_SESSION_FILE: "/home/user/.omp/agent/sessions/x.jsonl",
	PI_CODING_AGENT_DIR: "/home/user/.omp/agent",
	OMP_PROFILE: "work",
	OMP_AUTH_BROKER_URL: "http://127.0.0.1:1",
};
// Controls a test run sets on purpose.
const HARNESS_ENV: Record<string, string> = {
	PI_TEST_RUNTIME: "1",
	PI_NATIVES_DIR: "/tmp/natives-under-test",
	PI_PYTHON_INTEGRATION: "1",
};

async function packagesWithTests(): Promise<string[]> {
	const dirs: string[] = [];
	for (const entry of await fs.readdir(path.join(REPO_ROOT, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(REPO_ROOT, "packages", entry.name);
		const stat = await fs.stat(path.join(dir, "test")).catch(() => undefined);
		if (stat?.isDirectory()) dirs.push(dir);
	}
	return dirs.sort();
}

// The user's own dotenv files, which omp's env loader would otherwise apply after the preload ran.
const USER_DOTENV: Record<string, string> = {
	".env": "PI_HERMETIC_HOME_DOTENV",
	".omp/.env": "PI_HERMETIC_CONFIG_DOTENV",
	".omp/agent/.env": "PI_HERMETIC_AGENT_DOTENV",
};
// A `.env` in the directory the run starts from; Bun loads it before the preload.
const PROJECT_DOTENV = "PI_HERMETIC_PROJECT_DOTENV";

const PLACES = ["test", "child", "worker"] as const;
type SeenEnv = Record<(typeof PLACES)[number], string[]>;

async function envSeenByTestIn(cwd: string, home: string, out: string): Promise<SeenEnv> {
	const child = Bun.spawn([process.execPath, "test", PROBE], {
		cwd,
		env: {
			...process.env,
			...USER_ENV,
			...HARNESS_ENV,
			HOME: home,
			USERPROFILE: home,
			PI_TEST_HERMETIC_ENV_OUT: out,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (exitCode !== 0) throw new Error(`bun test in ${cwd} exited ${exitCode}:\n${stderr}`);
	return (await Bun.file(out).json()) as SeenEnv;
}

/** Lists each user name seen in one of `places`, and each harness name one of them lost. */
function leaksAndDrops(
	runs: Array<{ label: string; seen: SeenEnv }>,
	userNames: string[],
	places: ReadonlyArray<(typeof PLACES)[number]> = PLACES,
) {
	const report = (names: string[], wanted: boolean) =>
		runs.flatMap(({ label, seen }) =>
			places.flatMap(where =>
				names.filter(name => seen[where].includes(name) === wanted).map(name => `${label} ${where}: ${name}`),
			),
		);
	return { leaks: report(userNames, true), dropped: report(Object.keys(HARNESS_ENV), false) };
}

async function withUserHome<T>(run: (root: string, home: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hermetic-env-"));
	try {
		const home = path.join(root, "home");
		for (const [file, name] of Object.entries(USER_DOTENV)) {
			await Bun.write(path.join(home, file), `${name}=from-user-dotenv\n`);
		}
		return await run(root, home);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

test("every package's tests, children and workers start without the invoking user's omp environment", async () => {
	await withUserHome(async (root, home) => {
		const packages = await packagesWithTests();
		const runs = await Promise.all(
			packages.map(async dir => ({
				label: path.basename(dir),
				seen: await envSeenByTestIn(dir, home, path.join(root, `${path.basename(dir)}.json`)),
			})),
		);
		expect(leaksAndDrops(runs, [...Object.keys(USER_ENV), ...Object.values(USER_DOTENV)])).toEqual({
			leaks: [],
			dropped: [],
		});
	});
}, 180_000);

test("a .env in the directory the run starts from does not put removed names back", async () => {
	await withUserHome(async (root, home) => {
		const project = path.join(root, "project");
		await Bun.write(path.join(project, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n`);
		await Bun.write(
			path.join(project, ".env"),
			`${PROJECT_DOTENV}=from-project-dotenv\nPI_CONFIG_FILES=/home/user/.omp/project-overlay.yml\n`,
		);
		const seen = await envSeenByTestIn(project, home, path.join(root, "project.json"));
		// A bun child started in this directory loads its `.env` itself (Bun's own autoload, which
		// only `--no-env-file` stops); no environment the test passes reaches it, so only the test
		// process and its worker are checked here.
		expect(
			leaksAndDrops([{ label: "project", seen }], [PROJECT_DOTENV, ...Object.keys(USER_ENV)], ["test", "worker"]),
		).toEqual({ leaks: [], dropped: [] });
	});
}, 60_000);
