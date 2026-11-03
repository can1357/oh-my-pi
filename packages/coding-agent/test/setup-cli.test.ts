import { afterEach, describe, expect, it, onTestFinished, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { testLifetime } from "../../utils/test/helpers/mock-restores";
import { checkPythonSetup } from "../src/cli/setup-cli";
import { Settings } from "../src/config/settings";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

interface CliProcessResult {
	exitCode: number;
	output: string;
	error: string;
}

async function runSetupPython(cwd: string): Promise<CliProcessResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
	};
	delete env.VIRTUAL_ENV;
	delete env.CONDA_DEFAULT_ENV;
	delete env.CONDA_PREFIX;
	const proc = Bun.spawn([process.execPath, cliEntry, "setup", "python", "--json"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const output = new Response(proc.stdout).text();
	const error = new Response(proc.stderr).text();
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, output, error]);
	return { exitCode, output: stdout, error: stderr };
}

async function runSetup(cwd: string, ...setupArgs: string[]): Promise<CliProcessResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NO_COLOR: "1",
		PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
	};
	const proc = Bun.spawn([process.execPath, cliEntry, "setup", ...setupArgs], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const output = new Response(proc.stdout).text();
	const error = new Response(proc.stderr).text();
	const [exitCode, stdout, stderr] = await Promise.all([proc.exited, output, error]);
	return { exitCode, output: stdout, error: stderr };
}

/**
 * An activated venv/conda env legitimately outranks the project `.venv`
 * (docs/environment-variables.md: VIRTUAL_ENV, then CONDA_PREFIX, then
 * `<cwd>/.venv`), so probes that assert on the project venv must not see one.
 *
 * Hide any activated Python environment from the in-process probe for the
 * rest of the test. The resolver reads the live env (`resolveVenvPath`) and
 * the process-wide cached shell env (`Settings#getShellConfig().env`), so both
 * are covered. The test's end puts the variables back; the spy is undone by
 * `vi.restoreAllMocks()` in `afterEach`.
 */
function hideActivePythonEnv(): void {
	const previousVirtualEnv = process.env.VIRTUAL_ENV;
	const previousCondaPrefix = process.env.CONDA_PREFIX;
	const previousCondaDefaultEnv = process.env.CONDA_DEFAULT_ENV;
	onTestFinished(() => {
		if (previousVirtualEnv === undefined) delete process.env.VIRTUAL_ENV;
		else process.env.VIRTUAL_ENV = previousVirtualEnv;
		if (previousCondaPrefix === undefined) delete process.env.CONDA_PREFIX;
		else process.env.CONDA_PREFIX = previousCondaPrefix;
		if (previousCondaDefaultEnv === undefined) delete process.env.CONDA_DEFAULT_ENV;
		else process.env.CONDA_DEFAULT_ENV = previousCondaDefaultEnv;
	});
	delete process.env.VIRTUAL_ENV;
	delete process.env.CONDA_PREFIX;
	delete process.env.CONDA_DEFAULT_ENV;
	vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
		shell: "/bin/sh",
		args: ["-c"],
		env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "" },
		prefix: undefined,
	});
}

describe("omp setup python", () => {
	let projectDir: TempDir | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await projectDir?.remove();
		projectDir = undefined;
	});

	it.skipIf(process.platform === "win32")(
		"probes the project-configured interpreter instead of the PATH interpreter",
		async () => {
			projectDir = TempDir.createSync("@omp-setup-python-");
			const cwd = projectDir.path();
			const interpreter = path.join(cwd, "configured-python");
			await Bun.write(interpreter, "#!/bin/sh\nexit 0\n");
			await fs.chmod(interpreter, 0o755);
			await Bun.write(path.join(cwd, ".omp", "config.yml"), `python:\n  interpreter: ${interpreter}\n`);

			const result = await runSetupPython(cwd);

			expect(result.error).toBe("");
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output)).toMatchObject({
				available: true,
				pythonPath: interpreter,
				usingManagedEnv: false,
			});
		},
	);
	it.skipIf(process.platform === "win32")("prefers the project venv over the PATH interpreter", async () => {
		const life = testLifetime();
		projectDir = TempDir.createSync("@omp-setup-python-");
		const cwd = projectDir.path();
		const interpreter = path.join(cwd, ".venv", "bin", "python");
		await Bun.write(interpreter, "#!/bin/sh\nexit 0\n");
		await fs.chmod(interpreter, 0o755);

		life.assertLive();
		hideActivePythonEnv();
		const result = await checkPythonSetup(cwd);

		expect(result).toMatchObject({
			available: true,
			pythonPath: interpreter,
			usingManagedEnv: false,
		});
	});
	it.skipIf(process.platform === "win32")("does not let the global probe bypass skip setup validation", async () => {
		const life = testLifetime();
		const previousSkipCheck = process.env.PI_PYTHON_SKIP_CHECK;
		onTestFinished(() => {
			if (previousSkipCheck === undefined) delete process.env.PI_PYTHON_SKIP_CHECK;
			else process.env.PI_PYTHON_SKIP_CHECK = previousSkipCheck;
		});
		projectDir = TempDir.createSync("@omp-setup-python-");
		const cwd = projectDir.path();
		const interpreter = path.join(cwd, "configured-python");
		await Bun.write(interpreter, "#!/bin/sh\nexit 23\n");
		await fs.chmod(interpreter, 0o755);

		life.assertLive();
		process.env.PI_PYTHON_SKIP_CHECK = "1";
		const result = await checkPythonSetup(cwd, interpreter);
		expect(result).toMatchObject({
			available: false,
			pythonPath: interpreter,
			usingManagedEnv: false,
		});
	});
});

describe("omp setup without a component", () => {
	let projectDir: TempDir | undefined;

	afterEach(async () => {
		await projectDir?.remove();
		projectDir = undefined;
	});

	// Regression: `setup --check --json` with no COMPONENT used to print USAGE to
	// stdout and exit 0, silently succeeding a machine-readable check and breaking
	// scripted `--json` health checks. It must now fail loudly on stderr.
	for (const flags of [["--check"], ["--json"]]) {
		it(`fails on stderr with a non-zero exit for ${["setup", ...flags].join(" ")}`, async () => {
			projectDir = TempDir.createSync("@omp-setup-noarg-");
			const result = await runSetup(projectDir.path(), ...flags);

			expect(result.exitCode).not.toBe(0);
			expect(result.output).toBe("");
			expect(result.error).toContain("requires a COMPONENT");
		});
	}
});
