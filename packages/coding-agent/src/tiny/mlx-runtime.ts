import * as path from "node:path";
import { getTinyModelsCacheDir, type RuntimeInstallPhase } from "@oh-my-pi/pi-utils";
import { ensureManagedVenv } from "../eval/py/venv";

/** Pinned mlx-lm release; its venv directory is versioned for clean upgrades. */
export const MLX_LM_VERSION = "0.31.3";

/** Directory of the private mlx-lm runtime for the current pinned release. */
export function getTinyMlxRuntimeDir(): string {
	return path.join(path.dirname(getTinyModelsCacheDir()), "tiny-mlx-runtime", `mlx-lm-${MLX_LM_VERSION}`);
}

/** Local weights directory for an MLX Hub repository (`org/name` → `mlx/org--name`). */
export function getTinyMlxModelDir(repo: string): string {
	return path.join(getTinyModelsCacheDir(), "mlx", repo.replace("/", "--"));
}

/** Ensure the private mlx-lm venv exists, preferring uv over a compatible system Python. */
export function ensureTinyMlxRuntime(onPhase?: (phase: RuntimeInstallPhase) => void): Promise<string> {
	return ensureManagedVenv(
		{
			dir: getTinyMlxRuntimeDir(),
			marker: ".omp-mlx-lm",
			key: MLX_LM_VERSION,
			python: { min: "3.10", below: "3.14" },
			install: [`mlx-lm==${MLX_LM_VERSION}`],
			label: "mlx-lm",
		},
		onPhase,
	);
}
