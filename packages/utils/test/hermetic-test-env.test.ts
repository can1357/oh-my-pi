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

/** Every workspace the root package.json declares that has a test directory; each runs `bun test` from its own directory. */
async function workspacesWithTests(): Promise<string[]> {
	const manifest = (await Bun.file(path.join(REPO_ROOT, "package.json")).json()) as { workspaces: { packages: string[] } };
	const dirs: string[] = [];
	for (const pattern of manifest.workspaces.packages) {
		for await (const match of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT, onlyFiles: false })) {
			const dir = path.join(REPO_ROOT, match);
			const stat = await fs.stat(path.join(dir, "test")).catch(() => undefined);
			if (stat?.isDirectory()) dirs.push(dir);
		}
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

const PLACES = ["test", "child", "worker", "workerChild"] as const;
type SeenEnv = Record<(typeof PLACES)[number], string[]> & { agentDir: string };
// The preload sets PI_CODING_AGENT_DIR itself, to an empty dir of the test's own; the guard checks
// that value instead of the name.
const USER_NAMES = Object.keys(USER_ENV).filter(name => name !== "PI_CODING_AGENT_DIR");

async function envSeenByTestIn(
	cwd: string,
	home: string,
	out: string,
	userEnv: Record<string, string> = USER_ENV,
): Promise<SeenEnv> {
	// The probe starts a child and a worker that starts a child, and one probe per workspace runs at
	// once; Bun's 5 s default test timeout is too short for that on a loaded machine.
	const child = Bun.spawn([process.execPath, "test", "--timeout", "120000", PROBE], {
		cwd,
		env: {
			...process.env,
			...userEnv,
			...HARNESS_ENV,
			HOME: home,
			USERPROFILE: home,
			PI_TEST_HERMETIC_ENV_OUT: out,
			// As from a shell without it: this test's own preload set it, and the probe's run must
			// autoload the run directory's `.env` the way a developer's `bun test` does.
			BUN_OPTIONS: undefined,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (exitCode !== 0) throw new Error(`bun test in ${cwd} exited ${exitCode}:\n${stderr}`);
	return (await Bun.file(out).json()) as SeenEnv;
}

/** Lists each user name a test, child, worker or worker child saw, and each harness name one of them lost. */
function leaksAndDrops(runs: Array<{ label: string; seen: SeenEnv }>, userNames: string[]) {
	const report = (names: string[], wanted: boolean) =>
		runs.flatMap(({ label, seen }) =>
			PLACES.flatMap(where =>
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

test("every workspace's tests, children and workers start without the invoking user's omp environment", async () => {
	await withUserHome(async (root, home) => {
		const workspaces = await workspacesWithTests();
		const runs = await Promise.all(
			workspaces.map(async dir => {
				const label = path.relative(REPO_ROOT, dir);
				const out = path.join(root, `${label.replaceAll(path.sep, "_")}.json`);
				return { label, seen: await envSeenByTestIn(dir, home, out) };
			}),
		);
		const userAgentDirs = runs
			.filter(({ seen }) => seen.agentDir === USER_ENV.PI_CODING_AGENT_DIR || seen.agentDir.startsWith(home))
			.map(({ label, seen }) => `${label}: ${seen.agentDir}`);
		expect({ ...leaksAndDrops(runs, [...USER_NAMES, ...Object.values(USER_DOTENV)]), userAgentDirs }).toEqual({
			leaks: [],
			dropped: [],
			userAgentDirs: [],
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
		// The probe's children start in this directory too, where Bun's own autoload would read the
		// `.env` again in each of them.
		expect(leaksAndDrops([{ label: "project", seen }], [PROJECT_DOTENV, ...USER_NAMES])).toEqual({
			leaks: [],
			dropped: [],
		});
	});
}, 180_000);

// Windows reads environment names in any case but enumerates them as spelled, so `pi_config_files`
// is PI_CONFIG_FILES to omp there.
const WINDOWS_SPELLED_ENV: Record<string, string> = {
	pi_config_files: "/home/user/.omp/overlay.yml",
	Omp_Profile: "work",
};

test("on Windows, a name spelled in another case is removed too", async () => {
	await withUserHome(async (root, home) => {
		const project = path.join(root, "win32");
		// The preload runs as on Windows; the test after it runs on the real platform again, so omp
		// loads the native addon it has.
		const asWindows = path.join(root, "as-windows.ts");
		const asItself = path.join(root, "as-itself.ts");
		await Bun.write(
			asWindows,
			[
				'(globalThis as Record<string, unknown>).realPlatform = Object.getOwnPropertyDescriptor(process, "platform");',
				'Object.defineProperty(process, "platform", { value: "win32", configurable: true });',
			].join("\n"),
		);
		await Bun.write(
			asItself,
			'Object.defineProperty(process, "platform", (globalThis as Record<string, PropertyDescriptor>).realPlatform);\n',
		);
		const preloads = [asWindows, PRELOAD, asItself].map(file => JSON.stringify(file)).join(", ");
		await Bun.write(path.join(project, "bunfig.toml"), `[test]\npreload = [${preloads}]\n`);
		const seen = await envSeenByTestIn(project, home, path.join(root, "win32.json"), WINDOWS_SPELLED_ENV);
		expect(leaksAndDrops([{ label: "win32", seen }], Object.keys(WINDOWS_SPELLED_ENV))).toEqual({
			leaks: [],
			dropped: [],
		});
	});
}, 180_000);
