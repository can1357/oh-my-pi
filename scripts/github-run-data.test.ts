import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// GitHub substitutes `${{ … }}` into a `run` script before bash parses it, so a
// value that holds `$(…)` runs as a command. These tests render real steps the
// way the runner does, give them a value that would create a marker file, run
// them under bash with stubbed tools, and require the value to arrive as data.

const repoRoot = path.join(import.meta.dir, "..");
const scratchDirs: string[] = [];

afterEach(async () => {
	for (const dir of scratchDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface RunStep {
	run: string;
	env: Record<string, string>;
}

interface YamlStep {
	name?: unknown;
	run?: unknown;
	env?: Record<string, unknown>;
}

interface YamlDocument {
	jobs?: Record<string, { steps?: YamlStep[] }>;
	runs?: { steps?: YamlStep[] };
}

interface StepRun {
	exitCode: number;
	stdout: string;
	stderr: string;
	outputs: Record<string, string>;
}

async function scratchDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-github-run-data-"));
	scratchDirs.push(dir);
	return dir;
}

/** A value that writes `PWNED` to `marker` if a shell parses it, with no space so it is a legal Git ref name. */
function commandSubstitution(marker: string): string {
	return `$(printf\${IFS}PWNED>${marker})`;
}

async function readRunStep(file: string, job: string | undefined, name: string): Promise<RunStep> {
	const document = Bun.YAML.parse(await Bun.file(path.join(repoRoot, file)).text()) as YamlDocument;
	const steps = job === undefined ? document.runs?.steps : document.jobs?.[job]?.steps;
	const step = steps?.find(candidate => candidate.name === name);
	if (!step || typeof step.run !== "string") throw new Error(`${file}: no run step named "${name}"`);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(step.env ?? {})) env[key] = String(value);
	return { run: step.run, env };
}

/** Substitutes `${{ expression }}` the way the runner does: verbatim text, before any shell sees it. */
function renderExpressions(text: string, values: Record<string, string>): string {
	return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_match, expression: string) => {
		const value = values[expression];
		if (value === undefined) throw new Error(`no test value for expression: ${expression}`);
		return value;
	});
}

async function writeStub(dir: string, name: string, body: string): Promise<void> {
	const file = path.join(dir, name);
	await Bun.write(file, `#!/bin/sh\n${body}\n`);
	await fs.chmod(file, 0o755);
}

function parseOutputs(text: string): Record<string, string> {
	const outputs: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) outputs[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return outputs;
}

/** Runs a step as GitHub's `bash` shell does: `bash --noprofile --norc -eo pipefail <script>`. */
async function runStep(options: {
	file: string;
	job?: string;
	name: string;
	scratch: string;
	expressions: Record<string, string>;
	env?: Record<string, string>;
}): Promise<StepRun> {
	const step = await readRunStep(options.file, options.job, options.name);
	const stubs = path.join(options.scratch, "stubs");
	const script = path.join(options.scratch, `step-${crypto.randomUUID()}.sh`);
	const output = path.join(options.scratch, `output-${crypto.randomUUID()}`);
	await Bun.write(script, renderExpressions(step.run, options.expressions));
	await Bun.write(output, "");
	const stepEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(step.env)) stepEnv[key] = renderExpressions(value, options.expressions);
	const child = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", script], {
		cwd: options.scratch,
		env: {
			PATH: `${stubs}:/usr/bin:/bin`,
			HOME: options.scratch,
			GITHUB_OUTPUT: output,
			GITHUB_PATH: path.join(options.scratch, "github-path"),
			...options.env,
			...stepEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr, outputs: parseOutputs(await Bun.file(output).text()) };
}

describe("bun-install action", () => {
	async function installWithPin(pin: string): Promise<{ scratch: string; install: StepRun }> {
		const scratch = await scratchDir();
		const stubs = path.join(scratch, "stubs");
		await fs.mkdir(stubs);
		await Bun.write(path.join(scratch, "package.json"), JSON.stringify({ packageManager: `bun@${pin}` }));
		await writeStub(stubs, "bun", "echo 0.0.1");
		// The installer records the arguments `bash -s --` hands it.
		await writeStub(stubs, "curl", `echo 'printf "%s\\n" "$#" "$@" > "$HOME/installer-args"'`);
		const file = ".github/actions/bun-install/action.yml";
		const detect = await runStep({ file, name: "Detect environment", scratch, expressions: {} });
		expect(detect).toMatchObject({ exitCode: 0, outputs: { setup_bun: "true" } });
		const install = await runStep({
			file,
			name: "Install pinned bun when missing or mismatched",
			scratch,
			expressions: { "steps.env.outputs.bun_install": detect.outputs.bun_install ?? "" },
		});
		return { scratch, install };
	}

	test("passes an exact pin from package.json to the installer as data", async () => {
		const marker = path.join(os.tmpdir(), `omp-bun-install-marker-${crypto.randomUUID()}`);
		const pin = `1.4.4${commandSubstitution(marker)}`;
		try {
			const { scratch, install } = await installWithPin(pin);

			expect(await Bun.file(marker).exists()).toBe(false);
			expect(install.exitCode).toBe(0);
			expect(await Bun.file(path.join(scratch, "installer-args")).text()).toBe(`1\nbun-v${pin}\n`);
		} finally {
			await fs.rm(marker, { force: true });
		}
	});

	test("passes no installer argument for a floor pin", async () => {
		const { scratch, install } = await installWithPin(">=1.4");

		expect(install.exitCode).toBe(0);
		expect(await Bun.file(path.join(scratch, "installer-args")).text()).toBe("0\n");
	});
});

describe("CI release workflow", () => {
	const workflow = ".github/workflows/ci.yml";

	test("reads a dispatched tag ref as data", async () => {
		const scratch = await scratchDir();
		await fs.mkdir(path.join(scratch, "stubs"));
		const marker = path.join(scratch, "marker");
		const tag = `v1.0.0${commandSubstitution(marker)}`;
		const ref = `refs/tags/${tag}`;
		const event = "workflow_dispatch";

		const detect = await runStep({
			file: workflow,
			job: "release_metadata",
			name: "Detect release tag at HEAD",
			scratch,
			expressions: { "github.ref": ref, "github.ref_name": tag, "github.event_name": event },
			env: { GITHUB_REF: ref, GITHUB_REF_NAME: tag, GITHUB_EVENT_NAME: event },
		});

		expect(await Bun.file(marker).exists()).toBe(false);
		expect(detect).toMatchObject({ exitCode: 0, outputs: { "is-release": "true", "release-tag": tag } });
	});

	test.each([
		{ label: "release notes", job: "release_github", name: "Generate release notes from CHANGELOGs", changed: "1" },
		{ label: "build upload", job: "release_build", name: "Publish to build.stencil.so", changed: "1" },
		{ label: "changed formula", job: "release_brew", name: "Regenerate and push the formula", changed: "1" },
		{ label: "unchanged formula", job: "release_brew", name: "Regenerate and push the formula", changed: "0" },
	])("passes the release tag to the $label step as data", async ({ job, name, changed }) => {
		const scratch = await scratchDir();
		const stubs = path.join(scratch, "stubs");
		await fs.mkdir(stubs);
		await fs.mkdir(path.join(scratch, "homebrew-tap"));
		await writeStub(stubs, "bun", 'printf "%s\\n" "$@" > "$HOME/bun-args"');
		// `git diff --quiet` exits 1 when the formula changed.
		await writeStub(
			stubs,
			"git",
			`case "$1" in diff) exit ${changed} ;; esac\nprintf "%s\\n" "$@" >> "$HOME/git-args"`,
		);
		const marker = path.join(scratch, "marker");
		const tag = `v1.0.0${commandSubstitution(marker)}`;

		const step = await runStep({
			file: workflow,
			job,
			name,
			scratch,
			expressions: {
				"needs.release_metadata.outputs.release-tag": tag,
				"secrets.GITHUB_TOKEN": "test-token",
			},
		});

		expect(await Bun.file(marker).exists()).toBe(false);
		expect(step.exitCode).toBe(0);
		expect((await Bun.file(path.join(scratch, "bun-args")).text()).split("\n")).toContain(tag);
		if (job === "release_brew" && changed === "1") {
			expect((await Bun.file(path.join(scratch, "git-args")).text()).split("\n")).toContain(`omp ${tag}`);
		}
		if (job === "release_brew" && changed === "0") {
			expect(step.stdout).toBe(`formula already up to date for ${tag}\n`);
		}
	});
});
