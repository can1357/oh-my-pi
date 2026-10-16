import { afterAll, beforeAll, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const RUN = path.join(import.meta.dir, "../../bench/memory-eval/run.ts");
const FIXTURE_DATA = path.join(import.meta.dir, "fixtures", "data");
// Each case spawns the CLI, which loads the harness and Mnemopi; on a loaded machine that exceeds bun's 5 s default.
setDefaultTimeout(30_000);

// A temp HOME whose cache holds only the BEAM fixture: runs never read or write the real cache.
let home: string;
beforeAll(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-cases-"));
	const data = path.join(home, ".cache", "omp-memory-eval", "data");
	await fs.mkdir(data, { recursive: true });
	await fs.copyFile(path.join(FIXTURE_DATA, "beam-100k.json"), path.join(data, "beam-100k.json"));
});
afterAll(async () => {
	await fs.rm(home, { recursive: true, force: true });
});

/** `run --dataset beam-100k` plus `args`, without MNEMOPI_* in the environment. */
async function run(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("MNEMOPI_")));
	const proc = Bun.spawn([process.execPath, RUN, "run", "--dataset", "beam-100k", ...args], {
		env: { ...env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

it("run rejects a --cases value that is not a positive integer", async () => {
	const runs = await Promise.all([
		// `--cases=value`: parseArgs itself rejects a separate argument that starts with a dash.
		...["nope", "-1", "0", "1.5", "Infinity", ""].map(value =>
			run("--engine", "oracle", "--protocol", "standard", `--cases=${value}`),
		),
		run("--engine", "mnemosyne", "--protocol", "upstream-compat", "--cases=nope"),
	]);
	for (const { stderr, code } of runs) {
		expect(code).toBe(1);
		expect(stderr).toContain("--cases must be a positive integer");
	}
});

it("run rejects engine options the engine does not have", async () => {
	const [bogus, recallOnOracle, polyphonicOnOracle, polyphonicLinear] = await Promise.all([
		run("--engine", "mnemopi", "--protocol", "fts-only", "--mnemopi-recall", "bogus"),
		run("--engine", "oracle", "--protocol", "standard", "--mnemopi-recall", "enhanced"),
		run("--engine", "oracle", "--protocol", "standard", "--polyphonic"),
		run("--engine", "mnemopi", "--protocol", "fts-only", "--polyphonic"),
	]);
	expect(bogus.stderr).toContain("--mnemopi-recall must be one of recall, enhanced");
	expect(recallOnOracle.stderr).toContain("--mnemopi-recall applies to the mnemopi engine only");
	expect(polyphonicOnOracle.stderr).toContain("--polyphonic applies to the mnemopi and mnemosyne engines only");
	expect(polyphonicLinear.stderr).toContain("--polyphonic with --engine mnemopi needs --mnemopi-recall enhanced");
	for (const { code } of [bogus, recallOnOracle, polyphonicOnOracle, polyphonicLinear]) expect(code).toBe(1);
});

it("run records the engine options in the result config", async () => {
	const defaults = path.join(home, "defaults.json");
	const ablation = path.join(home, "ablation.json");
	const [a, b] = await Promise.all([
		run("--engine", "oracle", "--protocol", "standard", "--out", defaults),
		run(
			"--engine",
			"mnemopi",
			"--protocol",
			"fts-only",
			"--mnemopi-recall",
			"enhanced",
			"--polyphonic",
			"--out",
			ablation,
		),
	]);
	expect([a.code, a.stderr]).toEqual([0, ""]);
	expect([b.code, b.stderr]).toEqual([0, ""]);
	expect((await Bun.file(defaults).json()).config).toMatchObject({ mnemopiRecall: "recall", polyphonic: false });
	expect((await Bun.file(ablation).json()).config).toMatchObject({ mnemopiRecall: "enhanced", polyphonic: true });
});
