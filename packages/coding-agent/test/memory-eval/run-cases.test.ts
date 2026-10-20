import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries, stripGitRepoLocationEnv } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { pinnedCheckout } from "../../bench/memory-eval/run";

const RUN = path.join(import.meta.dir, "../../bench/memory-eval/run.ts");
const FIXTURE_DATA = path.join(import.meta.dir, "fixtures", "data");
/** The BEAM revision `run.ts` pins; `py/prepare_datasets.py` records it next to the file it downloaded. */
const BEAM_REVISION = "3205395e897e7318c7b094ef4e6047b9b82dbb03";
// Each case spawns the CLI, which loads the harness and Mnemopi; on a loaded machine that exceeds bun's 5 s default.
setDefaultTimeout(30_000);

// Inject a private benchmark cache: HOME/USERPROFILE remain unchanged on every platform.
let root: string;
let cacheRoot: string;
beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-cases-"));
	cacheRoot = await fixtureCache("pinned", BEAM_REVISION);
});
afterAll(async () => {
	await removeWithRetries(root);
});

/**
 * A private cache holding the fixture and, unless `revision` is undefined, its marker: the revision and the fixture's
 * SHA-256 as `py/prepare_datasets.py` writes them, or `sha256` instead when given ("" leaves the digest out).
 */
async function fixtureCache(name: string, revision: string | undefined, sha256?: string): Promise<string> {
	const dir = path.join(root, name);
	const data = path.join(dir, "data");
	await fs.mkdir(data, { recursive: true });
	const file = path.join(data, "beam-100k.json");
	await fs.copyFile(path.join(FIXTURE_DATA, "beam-100k.json"), file);
	const digest = sha256 ?? new Bun.CryptoHasher("sha256").update(await Bun.file(file).bytes()).digest("hex");
	if (revision !== undefined) await Bun.write(`${file}.revision`, `${revision}\n${digest}\n`);
	return dir;
}

/** `run --dataset beam-100k` plus `args` using an explicit cache root, with no MNEMOPI_* overrides. */
async function runAt(cacheDir: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("MNEMOPI_")));
	const proc = Bun.spawn([process.execPath, RUN, "run", "--dataset", "beam-100k", "--cache-root", cacheDir, ...args], {
		env,
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

const run = (...args: string[]) => runAt(cacheRoot, args);

it("run rejects an empty cache root instead of silently using the current directory", async () => {
	const { stderr, code } = await run("--engine", "oracle", "--protocol", "standard", "--cache-root=");
	expect(code).toBe(1);
	expect(stderr).toContain("--cache-root must not be empty");
});

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

it("run rejects --polyphonic with upstream-compat, which replays upstream's default recall", async () => {
	const { stderr, code } = await run("--engine", "mnemosyne", "--protocol", "upstream-compat", "--polyphonic");
	expect(code).toBe(1);
	expect(stderr).toContain("--polyphonic does not apply to upstream-compat");
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
	const defaults = path.join(cacheRoot, "defaults.json");
	const ablation = path.join(cacheRoot, "ablation.json");
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
		datasetSha256: new Bun.CryptoHasher("sha256")
			.update(await Bun.file(path.join(FIXTURE_DATA, "beam-100k.json")).bytes())
			.digest("hex"),
		gitCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
		gitDirty: expect.any(Boolean),
	});
	expect((await Bun.file(ablation).json()).config).toMatchObject({ mnemopiRecall: "enhanced", polyphonic: true });
	// Only these questions survive the private fixture's blank/abstention exclusions; the user's cache must not be read.
	expect((await Bun.file(defaults).json()).questions.map((q: { questionId: string }) => q.questionId).sort()).toEqual([
		"c1:contradiction_resolution:0",
		"c1:event_ordering:0",
		"c1:multi_session_reasoning:0",
	]);
});

it("run refuses a cached dataset whose recorded revision is missing or not the pinned one", async () => {
	const [stale, bare] = await Promise.all([
		fixtureCache("stale", "deadbeef").then(dir => runAt(dir, ["--engine", "oracle", "--protocol", "standard"])),
		fixtureCache("bare", undefined).then(dir => runAt(dir, ["--engine", "oracle", "--protocol", "standard"])),
	]);
	expect(stale.code).toBe(1);
	expect(stale.stderr).toContain(`beam-100k.json.revision: revision deadbeef, expected ${BEAM_REVISION}`);
	expect(bare.code).toBe(1);
	expect(bare.stderr).toContain(`beam-100k.json.revision: missing, expected ${BEAM_REVISION}`);
});

it("run refuses a cached dataset whose marker records no digest or the digest of other data", async () => {
	const [other, undigested] = await Promise.all([
		fixtureCache("other-data", BEAM_REVISION, "0".repeat(64)).then(dir =>
			runAt(dir, ["--engine", "oracle", "--protocol", "standard"]),
		),
		fixtureCache("undigested", BEAM_REVISION, "").then(dir =>
			runAt(dir, ["--engine", "oracle", "--protocol", "standard"]),
		),
	]);
	expect(other.code).toBe(1);
	expect(other.stderr).toContain("beam-100k.json.revision: records a digest of other data");
	expect(undigested.code).toBe(1);
	expect(undigested.stderr).toContain("beam-100k.json.revision: records no data digest");
});

describe("pinnedCheckout", () => {
	/** A repo with one commit; returns its directory and HEAD. */
	const repo = async (name: string): Promise<{ dir: string; sha: string }> => {
		const dir = path.join(root, name);
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "a"), "1");
		// The vcs module has no init; everything after it goes through vcs. A hook's GIT_DIR must not redirect it.
		const env: Record<string, string> = { ...Bun.env } as Record<string, string>;
		stripGitRepoLocationEnv(env);
		await $`git init -q ${dir}`.env(env).quiet();
		const git = vcs.requireGit(dir);
		await git.configSet("user.name", "t");
		await git.configSet("user.email", "t@t");
		await git.stageFiles(["a"]);
		return { dir, sha: await git.commitCreate("one", {}) };
	};

	it("records HEAD and whether the checkout is dirty before the run starts", async () => {
		const { dir, sha } = await repo("clean");
		expect(await pinnedCheckout(dir, async state => state)).toEqual({ commit: sha, dirty: false });
		await Bun.write(path.join(dir, "a"), "2");
		expect(await pinnedCheckout(dir, async state => state)).toEqual({ commit: sha, dirty: true });
	});

	it("refuses the result when a clean checkout gains local changes during the run", async () => {
		const { dir } = await repo("edited");
		await expect(pinnedCheckout(dir, () => Bun.write(path.join(dir, "a"), "2"))).rejects.toThrow(
			"gained local changes",
		);
	});

	it("refuses the result when HEAD moves during the run", async () => {
		const { dir } = await repo("moved");
		await expect(
			pinnedCheckout(dir, () => vcs.requireGit(dir).commitCreate("two", { allowEmpty: true })),
		).rejects.toThrow("HEAD moved");
	});
});
