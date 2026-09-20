import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { $which, getTinyModelsCacheDir, isEnoent, type RuntimeInstallPhase, withFileLock } from "@oh-my-pi/pi-utils";

/**
 * Side-installed Python runtime for the MLX tiny-model backend: a private venv
 * under the agent cache holding a pinned `mlx-lm`. Installed on first use the
 * same way the compiled binary side-installs `@huggingface/transformers`
 * (`ensureRuntimeInstalled`), just with `uv`/`python3 -m venv` instead of bun.
 */

/** Pinned `mlx-lm` release; the venv directory is keyed by it so bumps reinstall cleanly. */
export const MLX_LM_VERSION = "0.31.3";
/** Python range accepted for the venv; mlx publishes Metal wheels for these. */
const MLX_PYTHON_SPEC = ">=3.10,<3.14";
const READY_MARKER = ".omp-mlx-lm";

/** Directory of the `mlx-lm` venv for {@link MLX_LM_VERSION}. */
export function getTinyMlxRuntimeDir(): string {
	return path.join(path.dirname(getTinyModelsCacheDir()), "tiny-mlx-runtime", `mlx-lm-${MLX_LM_VERSION}`);
}

/** Local weights directory for an MLX Hub repo (`org/name` → `mlx/org--name`). */
export function getTinyMlxModelDir(repo: string): string {
	return path.join(getTinyModelsCacheDir(), "mlx", repo.replace("/", "--"));
}

function venvPython(runtimeDir: string): string {
	return path.join(runtimeDir, "bin", "python");
}

async function readReadyMarker(runtimeDir: string): Promise<string | null> {
	try {
		return (await Bun.file(path.join(runtimeDir, READY_MARKER)).text()).trim();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function installWithUv(uv: string, runtimeDir: string): Promise<void> {
	const venv = await $`${uv} venv --quiet --python ${MLX_PYTHON_SPEC} ${runtimeDir}`.quiet().nothrow();
	if (venv.exitCode !== 0) throw new Error(`uv venv failed (exit ${venv.exitCode}): ${venv.stderr.toString().trim()}`);
	const python = venvPython(runtimeDir);
	const pip = await $`${uv} pip install --quiet --python ${python} mlx-lm==${MLX_LM_VERSION}`.quiet().nothrow();
	if (pip.exitCode !== 0)
		throw new Error(`uv pip install failed (exit ${pip.exitCode}): ${pip.stderr.toString().trim()}`);
}

async function installWithSystemPython(python3: string, runtimeDir: string): Promise<void> {
	const check = await $`${python3} -c ${"import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"}`
		.quiet()
		.nothrow();
	if (check.exitCode !== 0) throw new Error(`${python3} is older than Python 3.10; install uv or a newer Python`);
	const venv = await $`${python3} -m venv ${runtimeDir}`.quiet().nothrow();
	if (venv.exitCode !== 0)
		throw new Error(`python3 -m venv failed (exit ${venv.exitCode}): ${venv.stderr.toString().trim()}`);
	const python = venvPython(runtimeDir);
	const pip = await $`${python} -m pip install --quiet --disable-pip-version-check mlx-lm==${MLX_LM_VERSION}`
		.quiet()
		.nothrow();
	if (pip.exitCode !== 0)
		throw new Error(`pip install failed (exit ${pip.exitCode}): ${pip.stderr.toString().trim()}`);
}

/**
 * Ensure the pinned `mlx-lm` venv exists and return its Python interpreter.
 * Prefers `uv` (fetches a suitable Python itself); falls back to a system
 * `python3` ≥ 3.10. Cross-process safe via the same OS file lock the bun
 * runtime installer uses.
 *
 * @throws when neither `uv` nor a usable `python3` is on `PATH`, or the install fails.
 */
export async function ensureTinyMlxRuntime(onPhase?: (phase: RuntimeInstallPhase) => void): Promise<string> {
	const runtimeDir = getTinyMlxRuntimeDir();
	if ((await readReadyMarker(runtimeDir)) === MLX_LM_VERSION) return venvPython(runtimeDir);
	onPhase?.("initiate");
	// withFileLock does not create parent directories; the runtime cache dir may
	// not exist yet on the very first install.
	await fs.mkdir(path.dirname(runtimeDir), { recursive: true });
	return withFileLock(`${runtimeDir}.install`, async () => {
		if ((await readReadyMarker(runtimeDir)) === MLX_LM_VERSION) return venvPython(runtimeDir);
		onPhase?.("download");
		const uv = $which("uv");
		if (uv) {
			await installWithUv(uv, runtimeDir);
		} else {
			const python3 = $which("python3") ?? $which("python");
			if (!python3) throw new Error("MLX backend needs `uv` or `python3` (>= 3.10) on PATH to install mlx-lm");
			await installWithSystemPython(python3, runtimeDir);
		}
		await Bun.write(path.join(runtimeDir, READY_MARKER), `${MLX_LM_VERSION}\n`);
		onPhase?.("done");
		return venvPython(runtimeDir);
	});
}
