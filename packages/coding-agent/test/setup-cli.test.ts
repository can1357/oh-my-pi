import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildSpeechComponents, checkPythonSetup } from "../src/cli/setup-cli";
import { Settings, settings } from "../src/config/settings";
import * as setupModelPicker from "../src/cli/setup-model-picker";
import * as downloader from "../src/stt/downloader";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "./helpers/settings-test-state";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

// An activated venv/conda env legitimately outranks the project `.venv`
// (docs/environment-variables.md: VIRTUAL_ENV, then CONDA_PREFIX, then
// `<cwd>/.venv`), so probes that assert on the project venv must not see one.
const ACTIVE_PYTHON_ENV_VARS = ["VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV"] as const;

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
 * Hide any activated Python environment from the in-process probe for the
 * duration of a test. The resolver reads the live env (`resolveVenvPath`) and
 * the process-wide cached shell env (`Settings#getShellConfig().env`), so both
 * are covered. Returns the restore function; the spy is undone by
 * `vi.restoreAllMocks()` in `afterEach`.
 */
function hideActivePythonEnv(): () => void {
	const previous = new Map<string, string | undefined>(ACTIVE_PYTHON_ENV_VARS.map(name => [name, process.env[name]]));
	for (const name of ACTIVE_PYTHON_ENV_VARS) delete process.env[name];
	vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
		shell: "/bin/sh",
		args: ["-c"],
		env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "" },
		prefix: undefined,
	});
	return () => {
		for (const [name, value] of previous) restoreEnvValue(name, value);
	};
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
		projectDir = TempDir.createSync("@omp-setup-python-");
		const cwd = projectDir.path();
		const interpreter = path.join(cwd, ".venv", "bin", "python");
		await Bun.write(interpreter, "#!/bin/sh\nexit 0\n");
		await fs.chmod(interpreter, 0o755);

		const restoreEnv = hideActivePythonEnv();
		try {
			const result = await checkPythonSetup(cwd);

			expect(result).toMatchObject({
				available: true,
				pythonPath: interpreter,
				usingManagedEnv: false,
			});
		} finally {
			restoreEnv();
		}
	});
	it.skipIf(process.platform === "win32")("does not let the global probe bypass skip setup validation", async () => {
		projectDir = TempDir.createSync("@omp-setup-python-");
		const cwd = projectDir.path();
		const interpreter = path.join(cwd, "configured-python");
		await Bun.write(interpreter, "#!/bin/sh\nexit 23\n");
		await fs.chmod(interpreter, 0o755);

		const previousSkipCheck = process.env.PI_PYTHON_SKIP_CHECK;
		process.env.PI_PYTHON_SKIP_CHECK = "1";
		try {
			const result = await checkPythonSetup(cwd, interpreter);
			expect(result).toMatchObject({
				available: false,
				pythonPath: interpreter,
				usingManagedEnv: false,
			});
		} finally {
			if (previousSkipCheck === undefined) delete process.env.PI_PYTHON_SKIP_CHECK;
			else process.env.PI_PYTHON_SKIP_CHECK = previousSkipCheck;
		}
	});
});

describe("omp setup speech", () => {
	let state: SettingsTestState | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.backend", "cloud");
		settings.set("stt.modelName", "fast");
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		vi.restoreAllMocks();
	});

	it("requires and prepares the local fallback when cloud credentials are unavailable", async () => {
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(false);
		const download = vi.spyOn(downloader, "downloadSttModel").mockResolvedValue();
		const stt = buildSpeechComponents(Promise.resolve(false))[0]!;

		expect(await stt.isReady()).toBe(false);
		expect(await stt.status()).toBe("fast — local fallback not downloaded");
		await stt.ensure(() => {});
		expect(download).toHaveBeenCalledWith("fast", expect.any(Function));
	});

	it("reports the local model actually probed when stt.modelName holds a cloud id", async () => {
		// `--check`/`--json` never run the picker, so a cloud id lingers in
		// `stt.modelName` after the credential goes away. The local path resolves
		// it onto the default spec; the status must name that model, not the
		// remote id it neither probed nor could download.
		settings.set("stt.modelName", "gpt-4o-mini-transcribe");
		const cached = vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		const stt = buildSpeechComponents(Promise.resolve(false))[0]!;

		expect(await stt.status()).toBe("parakeet");
		expect(cached).toHaveBeenLastCalledWith("parakeet");

		cached.mockResolvedValue(false);
		expect(await stt.status()).toBe("parakeet — local fallback not downloaded");
	});

	it("offers local fallback models when cloud credentials are unavailable", async () => {
		const picker = vi.spyOn(setupModelPicker, "selectSetupModel").mockResolvedValue("turbo");
		const stt = buildSpeechComponents(Promise.resolve(false))[0]!;

		await stt.pick?.();

		expect(picker.mock.calls[0]?.[1]).toEqual(
			expect.arrayContaining([
				{ value: "turbo", label: "Turbo (Whisper large-v3)", description: expect.any(String) },
			]),
		);
		expect(settings.get("stt.modelName")).toBe("turbo");
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
