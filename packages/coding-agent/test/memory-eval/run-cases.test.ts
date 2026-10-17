import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pinnedCheckout } from "../../bench/memory-eval/run";

const RUN = path.join(import.meta.dir, "../../bench/memory-eval/run.ts");
const FIXTURE_DATA = path.join(import.meta.dir, "fixtures", "data");
/** The BEAM revision `run.ts` pins; `py/prepare_datasets.py` records it next to the file it downloaded. */
const BEAM_REVISION = "3205395e897e7318c7b094ef4e6047b9b82dbb03";
// Each case spawns the CLI, which loads the harness and Mnemopi; on a loaded machine that exceeds bun's 5 s default.
setDefaultTimeout(30_000);

// Temp HOMEs whose cache holds only the BEAM fixture: runs never read or write the real cache.
let root: string;
let home: string;
beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-cases-"));
	home = await cacheHome("pinned", BEAM_REVISION);
});
afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** A HOME holding the BEAM fixture and, unless `revision` is undefined, its revision marker. */
async function cacheHome(name: string, revision: string | undefined): Promise<string> {
	const dir = path.join(root, name);
	const data = path.join(dir, ".cache", "omp-memory-eval", "data");
	await fs.mkdir(data, { recursive: true });
	await fs.copyFile(path.join(FIXTURE_DATA, "beam-100k.json"), path.join(data, "beam-100k.json"));
	if (revision !== undefined) await Bun.write(path.join(data, "beam-100k.json.revision"), `${revision}\n`);
	return dir;
}

/** `run --dataset beam-100k` plus `args` with HOME `homeDir`, without MNEMOPI_* in the environment. */
async function runAt(homeDir: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("MNEMOPI_")));
	const proc = Bun.spawn([process.execPath, RUN, "run", "--dataset", "beam-100k", ...args], {
		env: { ...env, HOME: homeDir },
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

const run = (...args: string[]) => runAt(home, args);

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
	expect((await Bun.file(defaults).json()).config).toMatchObject({
		mnemopiRecall: "recall",
		polyphonic: false,
		datasetRevision: BEAM_REVISION,
		gitCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
		gitDirty: expect.any(Boolean),
	});
	expect((await Bun.file(ablation).json()).config).toMatchObject({ mnemopiRecall: "enhanced", polyphonic: true });
});

it("run refuses a cached dataset whose recorded revision is missing or not the pinned one", async () => {
	const [stale, bare] = await Promise.all([
		cacheHome("stale", "deadbeef").then(dir => runAt(dir, ["--engine", "oracle", "--protocol", "standard"])),
		cacheHome("bare", undefined).then(dir => runAt(dir, ["--engine", "oracle", "--protocol", "standard"])),
	]);
	expect(stale.code).toBe(1);
	expect(stale.stderr).toContain(`beam-100k.json.revision: revision deadbeef, expected ${BEAM_REVISION}`);
	expect(bare.code).toBe(1);
	expect(bare.stderr).toContain(`beam-100k.json.revision: missing, expected ${BEAM_REVISION}`);
});

describe("pinnedCheckout", () => {
	const commit = (dir: string, message: string) =>
		Bun.$`git -c user.name=t -c user.email=t@t commit -q --allow-empty -m ${message}`.cwd(dir).quiet();
	const repo = async (name: string): Promise<string> => {
		const dir = path.join(root, name);
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "a"), "1");
		await Bun.$`git init -q && git add a`.cwd(dir).quiet();
		await commit(dir, "one");
		return dir;
	};
	const head = async (dir: string) => (await Bun.$`git rev-parse HEAD`.cwd(dir).text()).trim();

	it("records HEAD and whether the checkout is dirty before the run starts", async () => {
		const dir = await repo("clean");
		const sha = await head(dir);
		const dirtyDuringRun = await pinnedCheckout(dir, async state => {
			await Bun.write(path.join(dir, "a"), "2");
			return state;
		});
		expect(dirtyDuringRun).toEqual({ commit: sha, dirty: false });
		expect(await pinnedCheckout(dir, async state => state)).toEqual({ commit: sha, dirty: true });
	});

	it("refuses the result when HEAD moves during the run", async () => {
		const dir = await repo("moved");
		await expect(pinnedCheckout(dir, () => commit(dir, "two"))).rejects.toThrow("HEAD moved");
	});
});
