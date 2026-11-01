import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const fixture = path.join(import.meta.dir, "test-preload.fixture.ts");

/** Every directory a `bun test` run starts in: the repository root and each workspace with tests. */
async function testRoots(): Promise<string[]> {
	const manifest: { workspaces: string[] | { packages: string[] } } = await Bun.file(
		path.join(repoRoot, "package.json"),
	).json();
	const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces.packages;
	const roots = ["."];
	for (const pattern of patterns) {
		for await (const dir of new Bun.Glob(pattern).scan({ cwd: repoRoot, onlyFiles: false })) {
			if (!fs.existsSync(path.join(repoRoot, dir, "package.json"))) continue;
			const tests = new Bun.Glob("{src,test}/**/*.test.ts").scan({ cwd: path.join(repoRoot, dir) });
			if (!(await tests.next()).done) roots.push(dir);
		}
	}
	return roots.sort();
}

const roots = await testRoots();

describe("the test preload", () => {
	it("finds the repository's test roots", () => {
		expect(roots).toEqual(expect.arrayContaining([".", "packages/ai", "packages/coding-agent", "packages/utils"]));
	});

	// A direct `bun test` starts without the marker, and Bun reads only the bunfig.toml of
	// the directory it runs in, so each test root must preload the marker on its own.
	it.each(roots)(
		"marks every child a direct `bun test` in %s spawns",
		async root => {
			const proc = Bun.spawn([process.execPath, "test", fixture], {
				cwd: path.join(repoRoot, root),
				env: { ...process.env, PI_TEST_RUNTIME: undefined },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			const line = `${stdout}\n${stderr}`.split("\n").find(entry => entry.startsWith("CHILD_MARKERS "));
			expect({ exitCode, received: line && JSON.parse(line.slice("CHILD_MARKERS ".length)) }).toEqual({
				exitCode: 0,
				received: {
					bunSpawn: "1",
					bunSpawnCmd: "1",
					bunSpawnSync: "1",
					bunSpawnSyncCmd: "1",
					processEnv: "1",
					nodeChildProcess: "1",
					bunShell: "1",
					// The next four copy the environment of the process, not the test's JavaScript
					// realm: native code reads it directly, and a Worker builds its children's from it.
					nativeShell: "1",
					nativePty: "1",
					workerBunSpawn: "1",
					workerBunSpawnSync: "1",
					// A test that runs a child as production removes the marker itself.
					removedByCaller: "unset",
				},
			});
		},
		30_000,
	);
});
