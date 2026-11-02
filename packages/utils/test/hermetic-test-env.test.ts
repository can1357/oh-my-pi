import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const PROBE = path.join(import.meta.dir, "fixtures", "hermetic-env-probe.ts");

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

interface SeenEnv {
	test: string[];
	child: string[];
}

async function envSeenByTestIn(cwd: string, home: string, outDir: string): Promise<SeenEnv> {
	const out = path.join(outDir, `${path.basename(cwd)}.json`);
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

test("every package's tests and their children start without the invoking user's omp environment", async () => {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hermetic-env-"));
	try {
		const home = path.join(outDir, "home");
		for (const [file, name] of Object.entries(USER_DOTENV)) {
			await Bun.write(path.join(home, file), `${name}=from-user-dotenv\n`);
		}
		const packages = await packagesWithTests();
		const seen = await Promise.all(packages.map(dir => envSeenByTestIn(dir, home, outDir)));
		const userNames = [...Object.keys(USER_ENV), ...Object.values(USER_DOTENV)];
		const report = (names: string[], wanted: boolean) =>
			packages.flatMap((dir, i) =>
				(["test", "child"] as const).flatMap(where =>
					names
						.filter(name => seen[i][where].includes(name) === wanted)
						.map(name => `${path.basename(dir)} ${where}: ${name}`),
				),
			);
		expect({ leaks: report(userNames, true), dropped: report(Object.keys(HARNESS_ENV), false) }).toEqual({
			leaks: [],
			dropped: [],
		});
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
	}
}, 180_000);
