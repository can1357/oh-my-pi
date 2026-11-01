import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

// run-rs-task.ts decides whether the Rust half of `bun check` runs. Each case
// copies the real script into a throwaway git repo and runs `check:rs` there with
// `cargo` shadowed by a stub on PATH, so a case observes exactly what a
// contributor does: whether cargo ran, the line the gate printed, and its exit
// code. No Rust is built.

const SCRIPT = path.join(import.meta.dir, "run-rs-task.ts");
const cleanups: (() => Promise<void>)[] = [];
// Each case builds and clones a repository and spawns bun; on a loaded host
// that outruns bun's 5 s default.
const CASE_TIMEOUT_MS = 30_000;

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Fixture {
	root: string;
	/** Bare-bones stand-in for the main repository: two commits on `main`. */
	origin: string;
	/** A full clone of `origin`, so `origin/main` exists. */
	work: string;
	shimDir: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await $`git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false ${args}`
		.cwd(cwd)
		.quiet();
	return result.text();
}

async function writeExecutable(file: string, content: string): Promise<void> {
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function makeFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-run-rs-task-"));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const origin = path.join(root, "origin");
	const work = path.join(root, "work");
	const shimDir = path.join(root, "bin");
	// `rustup` fails so the script falls back to the `cargo` on PATH: the stub.
	await writeExecutable(path.join(shimDir, "rustup"), "#!/bin/sh\nexit 1\n");
	await writeExecutable(path.join(shimDir, "cargo"), '#!/bin/sh\necho "cargo-stub $*"\n');

	await Bun.write(path.join(origin, "scripts/run-rs-task.ts"), Bun.file(SCRIPT));
	await Bun.write(path.join(origin, "packages/app/src/a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(origin, "crates/x/src/lib.rs"), "pub fn x() {}\n");
	await git(origin, "init", "-q", "-b", "main");
	await git(origin, "add", "-A");
	await git(origin, "commit", "-q", "-m", "base");
	// A second commit, so a depth-1 clone is really shallow.
	await commitFile(origin, "packages/app/src/a.ts", "export const a = 2;\n", "second");
	await git(root, "clone", "-q", origin, work);
	return { root, origin, work, shimDir };
}

async function commitFile(repo: string, file: string, content: string, message: string): Promise<void> {
	await Bun.write(path.join(repo, file), content);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", message);
}

/** What a contributor sees from one gate run. */
interface CheckRsResult {
	exitCode: number;
	output: string;
	cargoRan: boolean;
}

async function runCheckRs(fixture: Fixture, cwd: string, env: Record<string, string> = {}): Promise<CheckRsResult> {
	const base: Record<string, string | undefined> = { ...process.env };
	// The ambient environment must not decide the case: an omp shell exports
	// CI=true, a GitHub runner exports GITHUB_ACTIONS, and a git hook exports GIT_DIR.
	for (const key of ["CI", "GITHUB_ACTIONS", "OMP_FORCE_RUST_TASKS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
		delete base[key];
	}
	const proc = Bun.spawn([process.execPath, "scripts/run-rs-task.ts", "check:rs"], {
		cwd,
		env: { ...base, ...env, PATH: `${fixture.shimDir}${path.delimiter}${process.env.PATH ?? ""}` },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const output = `${stdout}${stderr}`;
	return { exitCode, output, cargoRan: output.includes("cargo-stub clippy") };
}

describe.skipIf(process.platform === "win32")("run-rs-task.ts check:rs", () => {
	// Failure mode: a contributor commits a Rust change, runs `bun check` on the
	// clean tree, and gets a green gate that never looked at their Rust.
	test(
		"a committed Rust change on a clean tree runs the Rust gate and names the file",
		async () => {
			const fixture = await makeFixture();
			await git(fixture.work, "switch", "-q", "-c", "feature");
			await commitFile(fixture.work, "crates/x/src/lib.rs", "pub fn x() -> u8 { 1 }\n", "rust change");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(true);
			expect(result.output).toContain("crates/x/src/lib.rs");
			expect(result.exitCode).toBe(0);
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: omp exports CI=true into every agent command, so every agent's
	// `bun check` on a TypeScript-only change paid a full `cargo clippy --workspace`.
	test(
		"a TypeScript-only commit skips the Rust half under CI=true and says why",
		async () => {
			const fixture = await makeFixture();
			await git(fixture.work, "remote", "add", "upstream", `file://${fixture.origin}`);
			await git(fixture.work, "fetch", "-q", "upstream");
			await git(fixture.work, "switch", "-q", "--detach");
			await commitFile(fixture.work, "packages/app/src/a.ts", "export const a = 3;\n", "ts change");

			const result = await runCheckRs(fixture, fixture.work, { CI: "true" });

			expect(result.cargoRan).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("Skipping check:rs");
		},
		CASE_TIMEOUT_MS,
	);

	// Failure mode: `git status` folds an untracked directory into one
	// `crates/newcrate/` entry, so a brand-new crate looks like no Rust change at all.
	test(
		"a new untracked crate runs the Rust gate",
		async () => {
			const fixture = await makeFixture();
			await Bun.write(path.join(fixture.work, "crates/newcrate/Cargo.toml"), '[package]\nname = "newcrate"\n');
			await Bun.write(path.join(fixture.work, "crates/newcrate/src/lib.rs"), "pub fn y() {}\n");

			const result = await runCheckRs(fixture, fixture.work);

			expect(result.cargoRan).toBe(true);
			expect(result.output).toContain("crates/newcrate/");
		},
		CASE_TIMEOUT_MS,
	);
});
