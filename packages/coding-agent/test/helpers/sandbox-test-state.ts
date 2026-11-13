import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { YAML } from "bun";

/** Backend probe of a host where seatbelt contains processes, with proxy confinement. */
export const SANDBOX_SUPPORTED = { supported: true, backend: "seatbelt" as const, proxy: true, warnings: [] };
/** Backend probe of a host without a usable backend. */
export const SANDBOX_UNAVAILABLE = { supported: false, reason: "test: no backend", proxy: false, warnings: [] };
/**
 * Whether a contained child can load omp from this source checkout. On Windows, Bun cannot open
 * directories under the processcontainer's read-only roots, so it cannot resolve the TypeScript
 * sources a contained shell host or evaluator re-enters (docs/sandbox.md, "Windows"); there only
 * the compiled binary runs contained, which `omp --smoke-test` covers. Lift once
 * oven-sh/bun#48581 or microsoft/mxc#1467 (including `FILE_READ_EA`) is fixed.
 */
export const CONTAINED_SOURCE_RUNS = process.platform !== "win32";

/** The process settings over `agentDir` and `workspace`, with optional global and project `sandbox:` sections. */
export async function initSandboxSettings(
	dirs: { agentDir: string; workspace: string },
	layers: { global?: object; project?: object } = {},
): Promise<Settings> {
	if (layers.global) {
		await Bun.write(path.join(dirs.agentDir, "config.yml"), YAML.stringify({ sandbox: layers.global }));
	}
	if (layers.project) {
		await Bun.write(path.join(dirs.workspace, ".omp", "config.yml"), YAML.stringify({ sandbox: layers.project }));
	}
	return Settings.init({ agentDir: dirs.agentDir, cwd: dirs.workspace });
}
