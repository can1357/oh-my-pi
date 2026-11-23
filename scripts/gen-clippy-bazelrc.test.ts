/**
 * Contract: `gen-clippy-bazelrc.ts --check` names every first-party crate that
 * opts into `[lints] workspace = true`, and `--coverage` fails when an
 * opted-in library or binary lacks a real top-level `lint_config` attribute or
 * is not scheduled by `.github/workflows/ci.yml` Clippy queries.
 *
 * If this regresses, a commented-out `lint_config` or an unscheduled binary in
 * a crate omitted from the CI strict query passes `--check` and only fails
 * later in `bun run lint:rs`.
 */
import { expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const script = path.join(import.meta.dir, "gen-clippy-bazelrc.ts");
const coveragePrefix = "workspace-lint-coverage:";
const gapPrefix = "workspace-lint-coverage-gap:";

test("check reports every opted-in crate, including ones the strict query omits", async () => {
	const result = await $`bun ${script} --check`.cwd(repoRoot).quiet().nothrow();
	expect(result.exitCode).toBe(0);
	const covered = coverageNames(result.stdout.toString());
	expect(covered).toContain("predict");
	expect(covered).toContain("vfs");
	expect(covered).not.toContain("builtins");
	expect(new Set(covered)).toEqual(new Set(await optedInCrateNames(repoRoot)));

	const lintsBuild = await fs.readFile(path.join(repoRoot, "bazel", "lints", "BUILD.bazel"), "utf8");
	const pedantic = lintsBuild.indexOf('"pedantic"');
	const castLossless = lintsBuild.indexOf('"cast_lossless"');
	expect(pedantic).toBeGreaterThan(-1);
	expect(castLossless).toBeGreaterThan(pedantic);
});

test("coverage ignores stray files and requires a real top-level lint_config attribute", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-clippy-coverage-"));
	try {
		await writeCrate(
			root,
			"pi-gap",
			true,
			`rust_library(\n    name = "pi-gap",\n    deps = ["//crates/pi-wired"],\n)\n`,
		);
		await writeCrate(
			root,
			"pi-commented",
			true,
			`rust_library(\n    name = "pi-commented",\n    # lint_config = "//bazel/lints:workspace_lints",\n)\n`,
		);
		await writeCrate(
			root,
			"pi-nested",
			true,
			`rust_library(\n    name = "pi-nested",\n    rustc_flags = ['lint_config = "//bazel/lints:workspace_lints"'],\n    deps = helper(lint_config = "//bazel/lints:workspace_lints"),\n)\n`,
		);
		await writeCrate(
			root,
			"pi-select",
			true,
			`rust_library(\n    name = "pi-select",\n    lint_config = select({\n        "//conditions:default": "//bazel/lints:workspace_lints",\n    }),\n)\n`,
		);
		await writeCrate(
			root,
			"pi-wired",
			true,
			`rust_library(\n    # name = "pi-wrong",\n    name = "pi-wired",\n    rustc_flags = ["-Copt-level=1"] + select({\n        "//conditions:default": [],\n    }),\n    lint_config = "//bazel/lints:workspace_lints",  # workspace policy\n)\n`,
		);
		await writeCrate(root, "pi-plain", false, `rust_library(\n    name = "pi-plain",\n)\n`);
		await writeCrate(root, "pi-testonly", true, `rust_test(\n    name = "pi-testonly_test",\n)\n`);
		await Bun.write(path.join(root, "crates", ".DS_Store"), "\u0000");

		const result = await $`bun ${script} --check --coverage --root ${root}`.quiet().nothrow();
		const stderr = result.stderr.toString();
		expect(result.exitCode).toBe(1);
		expect(stderr).toContain(`${gapPrefix} pi-gap`);
		expect(stderr).toContain(`${gapPrefix} pi-commented`);
		expect(stderr).toContain(`${gapPrefix} pi-nested`);
		expect(stderr).toContain(`${gapPrefix} pi-select`);
		expect(stderr).toContain(`${gapPrefix} pi-testonly`);
		expect(stderr).not.toContain("pi-wired");
		expect(stderr).not.toContain("pi-plain");
		expect(stderr).not.toContain("ENOTDIR");
		expect(result.stdout.toString()).not.toContain(coveragePrefix);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("coverage flags opted-in binaries not scheduled by ci.yml and passes once scheduled", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-clippy-ci-schedule-"));
	try {
		const ciYamlPath = path.join(root, ".github", "workflows", "ci.yml");
		const repoCiYaml = await Bun.file(path.join(repoRoot, ".github", "workflows", "ci.yml")).text();
		await Bun.write(ciYamlPath, repoCiYaml);

		await writeCrate(
			root,
			"pi-unscheduled-bin",
			true,
			`rust_binary(\n    name = "pi-unscheduled-bin",\n    lint_config = "//bazel/lints:workspace_lints",\n)\n`,
		);
		await writeCrate(
			root,
			"pi-fallback-lib",
			true,
			`rust_library(\n    name = "pi-fallback-lib",\n    lint_config = "//bazel/lints:workspace_lints",\n)\n`,
		);
		await writeCrate(
			root,
			"shell",
			true,
			`rust_binary(\n    name = "obash",\n    lint_config = "//bazel/lints:workspace_lints",\n)\n`,
		);

		const unscheduled = await $`bun ${script} --check --coverage --root ${root}`.quiet().nothrow();
		const stderr = unscheduled.stderr.toString();
		expect(unscheduled.exitCode).toBe(1);
		expect(stderr).toContain(`${gapPrefix} pi-unscheduled-bin rust_binary "pi-unscheduled-bin"`);
		expect(stderr).toContain(".github/workflows/ci.yml");
		expect(stderr).not.toContain("pi-fallback-lib");
		expect(stderr).not.toContain("shell");

		// Once CI schedules binaries in the fallback/unified query, the same crate passes.
		const unifiedCi = `jobs:\n  rust_validate:\n    steps:\n      - name: Clippy\n        run: |\n          bazelisk query "kind('rust_library|rust_shared_library|rust_binary', //crates/... - //crates/builtins/...)" \\\n            | xargs bazelisk build --config=clippy --\n`;
		await Bun.write(ciYamlPath, unifiedCi);

		const scheduled = await $`bun ${script} --check --coverage --root ${root}`.quiet().nothrow();
		expect(scheduled.exitCode).toBe(0);
		expect(new Set(coverageNames(scheduled.stdout.toString()))).toEqual(
			new Set(["pi-unscheduled-bin", "pi-fallback-lib", "shell"]),
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

function coverageNames(stdout: string): string[] {
	const line = stdout.split("\n").find(entry => entry.startsWith(coveragePrefix));
	expect(line).toBeDefined();
	return line!
		.slice(coveragePrefix.length)
		.trim()
		.split(/\s+/)
		.filter(name => name.length > 0);
}

async function optedInCrateNames(root: string): Promise<string[]> {
	const cratesDir = path.join(root, "crates");
	const names: string[] = [];
	for (const name of await fs.readdir(cratesDir)) {
		const cargoPath = path.join(cratesDir, name, "Cargo.toml");
		const text = await fs.readFile(cargoPath, "utf8").catch(() => null);
		if (text == null) continue;
		const parsed = Bun.TOML.parse(text) as { lints?: { workspace?: unknown } };
		if (parsed.lints?.workspace === true) names.push(name);
	}
	return names;
}

async function writeCrate(root: string, name: string, workspaceLints: boolean, build: string): Promise<void> {
	const dir = path.join(root, "crates", name);
	await fs.mkdir(dir, { recursive: true });
	const lints = workspaceLints ? "\n[lints]\nworkspace = true\n" : "\n";
	await Bun.write(path.join(dir, "Cargo.toml"), `[package]\nname = "${name}"\nversion = "0.0.0"\n${lints}`);
	await Bun.write(path.join(dir, "BUILD.bazel"), build);
}
