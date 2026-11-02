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

async function envSeenByTestIn(cwd: string, outDir: string): Promise<string[]> {
	const out = path.join(outDir, `${path.basename(cwd)}.json`);
	const child = Bun.spawn([process.execPath, "test", PROBE], {
		cwd,
		env: { ...process.env, ...USER_ENV, ...HARNESS_ENV, PI_TEST_HERMETIC_ENV_OUT: out },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (exitCode !== 0) throw new Error(`bun test in ${cwd} exited ${exitCode}:\n${stderr}`);
	return (await Bun.file(out).json()) as string[];
}

test("every package's tests start without the invoking user's omp environment", async () => {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hermetic-env-"));
	try {
		const packages = await packagesWithTests();
		const seen = await Promise.all(packages.map(dir => envSeenByTestIn(dir, outDir)));
		const leaks = packages.flatMap((dir, i) =>
			Object.keys(USER_ENV)
				.filter(name => seen[i].includes(name))
				.map(name => `${path.basename(dir)}: ${name}`),
		);
		const dropped = packages.flatMap((dir, i) =>
			Object.keys(HARNESS_ENV)
				.filter(name => !seen[i].includes(name))
				.map(name => `${path.basename(dir)}: ${name}`),
		);
		expect({ leaks, dropped }).toEqual({ leaks: [], dropped: [] });
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
	}
}, 180_000);
