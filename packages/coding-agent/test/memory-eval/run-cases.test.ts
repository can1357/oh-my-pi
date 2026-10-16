import { afterAll, beforeAll, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const RUN = path.join(import.meta.dir, "../../bench/memory-eval/run.ts");
// Each case spawns the CLI, which loads the harness and Mnemopi; on a loaded machine that exceeds bun's 5 s default.
setDefaultTimeout(30_000);

// An empty HOME: a run that got past argument checks finds no datasets and writes nothing to the real cache.
let home: string;
beforeAll(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-cases-"));
});
afterAll(async () => {
	await fs.rm(home, { recursive: true, force: true });
});

async function runWithCases(
	value: string,
	engine: string,
	protocol: string,
): Promise<{ stderr: string; code: number }> {
	const proc = Bun.spawn(
		// `--cases=value`: parseArgs itself rejects a separate argument that starts with a dash.
		[
			process.execPath,
			RUN,
			"run",
			"--dataset",
			"beam-100k",
			"--engine",
			engine,
			"--protocol",
			protocol,
			`--cases=${value}`,
		],
		{ env: { ...Bun.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
	);
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { stderr, code };
}

it("run rejects a --cases value that is not a positive integer", async () => {
	const runs = await Promise.all([
		...["nope", "-1", "0", "1.5", "Infinity", ""].map(value => runWithCases(value, "oracle", "standard")),
		runWithCases("nope", "mnemosyne", "upstream-compat"),
	]);
	for (const { stderr, code } of runs) {
		expect(code).toBe(1);
		expect(stderr).toContain("--cases must be a positive integer");
	}
});
