#!/usr/bin/env bun

import * as path from "node:path";
import { $ } from "bun";

const RUST_AFFECTING_FILE_NAMES = [
	"Cargo.toml",
	"Cargo.lock",
	"build.rs",
	"rust-toolchain",
	"rust-toolchain.toml",
	"clippy.toml",
	".clippy.toml",
	"rustfmt.toml",
	".rustfmt.toml",
] as const satisfies readonly string[];
// Remote-tracking trunks the branch is diffed against (a local `main` can carry the commits being checked).
const TRUNKS = ["upstream/main", "origin/main"] as const satisfies readonly string[];
// Vendored path-patched crates are workspace members for Bazel hermeticity
// (path-patch rendering is machine-local), but cargo dev tasks keep their
// historical scope: the forks are not held to workspace format/lint/test gates.
//
// pi-builtins is NOT excluded. It is first-party, and although it opts out of
// the workspace's pedantic/nursery lints in its own manifest (most of it is
// ported third-party code), it is held to default clippy and to zero rustc
// warnings like everything else.
const VENDORED_FORK_EXCLUDES = [
	"--exclude",
	"brush-core",
	"--exclude",
	"brush-parser",
	"--exclude",
	"cfg_aliases",
	"--exclude",
	"napi",
] as const satisfies readonly string[];
// grep-searcher's upstream ripgrep code predates the workspace clippy policy, but
// the fork's own `search_push` (src/searcher/push.rs, see its README.md) carries
// tests, so it is exempt from the lint gates only and still runs under test:rs.
const LINT_EXEMPT_FORK_EXCLUDES = [
	...VENDORED_FORK_EXCLUDES,
	"--exclude",
	"grep-searcher",
] as const satisfies readonly string[];
const TASK_COMMANDS = {
	"check:rs": [
		["cargo", "fmt", "--all", "--", "--check"],
		["cargo", "clippy", "--workspace", ...LINT_EXEMPT_FORK_EXCLUDES, "--no-deps", "--", "-D", "warnings"],
	],
	"fix:rs": [
		["cargo", "fmt", "--all"],
		[
			"cargo",
			"clippy",
			"--workspace",
			...LINT_EXEMPT_FORK_EXCLUDES,
			"--fix",
			"--allow-dirty",
			"--no-deps",
			"--allow-staged",
			"--allow-no-vcs",
		],
	],
	"fmt:rs": [["cargo", "fmt", "--all"]],
	"lint:rs": [["cargo", "clippy", "--workspace", ...LINT_EXEMPT_FORK_EXCLUDES, "--no-deps", "--", "-D", "warnings"]],
	"test:rs": [
		[
			"cargo",
			"nextest",
			"run",
			"--workspace",
			...VENDORED_FORK_EXCLUDES,
			"--status-level=fail",
			"--final-status-level=fail",
		],
		// nextest cannot run doctests (no stable libtest-json interface for
		// them), so they need their own libtest pass. It runs every runnable
		// doctest in the workspace's lib crates; today that is tree-sitter-go's
		// one example, since pi-natives is a `cdylib`, which rustdoc refuses to
		// collect doctests from, and pi-builtins' 16 examples are `ignore`d
		// vendored uutils docs. `--doc` overrides a crate's own
		// `doctest = false`, so a vendored crate whose examples do not compile
		// (napi-rs's) has to be in VENDORED_FORK_EXCLUDES.
		["cargo", "test", "--doc", "--workspace", ...VENDORED_FORK_EXCLUDES],
	],
} as const satisfies Record<string, readonly (readonly string[])[]>;

type RustTaskName = keyof typeof TASK_COMMANDS;

const repoRoot = path.join(import.meta.dir, "..");
const cargoBinary = await resolveCargoBinary();
const taskName = process.argv[2];

if (!isRustTaskName(taskName)) {
	console.error(`Unknown Rust task: ${taskName ?? "(missing)"}`);
	process.exit(1);
}

if (taskName !== "fmt:rs") {
	const decision = await decideWhetherToRun();
	console.log(`${decision.run ? "Running" : "Skipping"} ${taskName}: ${decision.reason}`);
	if (!decision.run) process.exit(0);
}

for (const command of TASK_COMMANDS[taskName]) {
	const exitCode = await runCommand(command);
	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}

function isRustTaskName(value: string | undefined): value is RustTaskName {
	return value != null && value in TASK_COMMANDS;
}

interface RunDecision {
	run: boolean;
	/** Printed as one line, so a skipped Rust gate is never silent. */
	reason: string;
}

type GitResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Runs unless the branch provably changed nothing Rust builds from since its merge base with a trunk.
 * `CI` is not read: omp exports `CI=true` into every agent command. GitHub Actions and
 * `OMP_FORCE_RUST_TASKS=1` force a run.
 */
async function decideWhetherToRun(): Promise<RunDecision> {
	if (isEnabled(Bun.env.OMP_FORCE_RUST_TASKS)) return { run: true, reason: "OMP_FORCE_RUST_TASKS is set." };
	// A CI job on `main` has an empty branch diff by definition and must still check everything.
	if (Bun.env.GITHUB_ACTIONS === "true") return { run: true, reason: "running in GitHub Actions." };
	const changed = await changedPathsSinceTrunk();
	if (typeof changed === "string")
		return { run: true, reason: `cannot tell what this checkout changed (${changed}).` };
	const rust = changed.filter(isRustAffectingPath);
	if (rust.length === 0) {
		return {
			run: false,
			reason:
				"no Rust-affecting change since the merge base with main. Set OMP_FORCE_RUST_TASKS=1 to run it anyway.",
		};
	}
	return {
		run: true,
		reason: `${JSON.stringify(rust[0])}${rust.length > 1 ? ` and ${rust.length - 1} more` : ""} changed.`,
	};
}

function isEnabled(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * Paths changed since the merge base with each fetched trunk (three-dot, so the trunk's newer commits
 * do not count), plus uncommitted and untracked files; a string says why that cannot be known.
 */
async function changedPathsSinceTrunk(): Promise<string[] | string> {
	const shallow = await git("rev-parse", "--is-shallow-repository");
	if (!shallow.ok) return shallow.error;
	// A shallow clone can report a stale merge base.
	if (shallow.text.trim() === "true") return "shallow clone; run git fetch --unshallow";
	// `--untracked-files=all` lists a new crate's files instead of one `crates/new/` entry.
	const status = await git("status", "--porcelain", "-z", "--untracked-files=all");
	if (!status.ok) return status.error;
	const paths = getChangedPathsFromPorcelain(status.text);
	let diffed = false;
	for (const trunk of TRUNKS) {
		const base = await git("merge-base", "HEAD", `refs/remotes/${trunk}`);
		if (!base.ok) continue;
		diffed = true;
		// `--no-renames` reports both sides, so moving a file out of a crate still counts.
		const committed = await git("diff", "--no-renames", "--name-only", "-z", base.text.trim(), "HEAD");
		if (!committed.ok) return committed.error;
		paths.push(...committed.text.split("\0").filter(Boolean));
	}
	return diffed ? paths : `no fetched ${TRUNKS.join(" or ")}`;
}

async function git(...args: string[]): Promise<GitResult> {
	const result = await $`git ${args}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode === 0) return { ok: true, text: result.text() };
	const firstLine = result.stderr.toString().trim().split("\n")[0];
	return { ok: false, error: `git ${args[0]}: ${firstLine || `exit ${result.exitCode}`}` };
}

function getChangedPathsFromPorcelain(porcelain: string): string[] {
	const entries = porcelain.split("\0").filter(Boolean);
	const changedPaths: string[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;

		const status = entry.slice(0, 2);
		const changedPath = entry.slice(3);
		if (changedPath !== "") {
			changedPaths.push(changedPath);
		}

		if (status.includes("R") || status.includes("C")) {
			const renamedPath = entries[index + 1];
			if (renamedPath) {
				changedPaths.push(renamedPath);
				index += 1;
			}
		}
	}

	return changedPaths;
}

function isRustAffectingPath(changedPath: string): boolean {
	const normalized = changedPath.replace(/\\/g, "/");
	const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
	return (
		normalized.endsWith(".rs") ||
		// Everything under crates/ feeds a crate: fixtures, include_bytes! data, grammars build.rs compiles.
		normalized.startsWith("crates/") ||
		normalized.startsWith(".cargo/") ||
		// `test:rs` is `cargo nextest run`, which reads its filters and scheduling from here.
		normalized === ".config/nextest.toml" ||
		isOneOf(fileName, RUST_AFFECTING_FILE_NAMES)
	);
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
	return values.some(entry => entry === value);
}

async function resolveCargoBinary(): Promise<string> {
	// On macOS runners, Homebrew's `rustup-init` binary is on PATH before the
	// rustup proxies in `$CARGO_HOME/bin`, and invoking it as `cargo` falls
	// through to its installer mode ("unexpected argument 'nextest' found").
	// Ask rustup directly for the cargo binary in the active toolchain.
	const result = await $`rustup which cargo`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode === 0) {
		const resolved = result.stdout.toString().trim();
		if (resolved !== "") return resolved;
	}
	return "cargo";
}

async function runCommand(command: readonly string[]): Promise<number> {
	const [head, ...rest] = command;
	const isCargo = head === "cargo";
	const argv = isCargo ? [cargoBinary, ...rest] : [head, ...rest];
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	if (isCargo) {
		// Cargo subprocesses (notably `rustc -vV` from `cargo metadata`) resolve
		// via PATH; ensure the active toolchain bin dir wins over Homebrew's
		// rustup-init shadow on macOS runners.
		const toolchainBin = path.dirname(cargoBinary);
		const pathSep = process.platform === "win32" ? ";" : ":";
		const currentPath = env.PATH ?? env.Path ?? "";
		env.PATH = currentPath === "" ? toolchainBin : `${toolchainBin}${pathSep}${currentPath}`;
	}
	const proc = Bun.spawn(argv, {
		cwd: repoRoot,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}
