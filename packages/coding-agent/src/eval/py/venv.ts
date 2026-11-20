import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, isEnoent, type RuntimeInstallPhase, withFileLock } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

/** Version-keyed Python environment provisioned by uv or a compatible system interpreter. */
export interface ManagedVenvOptions {
	dir: string;
	marker: string;
	key: string;
	python: { min: string; below: string };
	install: string[];
	label: string;
}

async function readReadyMarker(file: string): Promise<string | undefined> {
	try {
		return (await Bun.file(file).text()).trim();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

async function systemPython(options: ManagedVenvOptions): Promise<string> {
	const { min, below } = options.python;
	const probe =
		"import sys; lo,hi=(tuple(map(int,v.split('.'))) for v in sys.argv[1:]); sys.exit(0 if lo <= sys.version_info[:2] < hi else 1)";
	const candidates = new Set([$which("python3"), $which("python")]);
	for (const python of candidates) {
		if (!python) continue;
		const check = await $`${python} -c ${probe} ${min} ${below}`.quiet().nothrow();
		if (check.exitCode === 0) return python;
	}
	throw new Error(`${options.label} needs \`uv\` or Python ${min}–<${below} on PATH`);
}

/**
 * Ensure a version-keyed venv exists, serialized across processes by `${dir}.install`.
 * uv can fetch a compatible Python; the system fallback enforces both version bounds.
 * @throws when no compatible interpreter exists or venv creation/package installation fails.
 */
export async function ensureManagedVenv(
	options: ManagedVenvOptions,
	onPhase?: (phase: RuntimeInstallPhase) => void,
): Promise<string> {
	const { dir, marker, key, install, label } = options;
	const python =
		process.platform === "win32" ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");
	const markerPath = path.join(dir, marker);
	if ((await readReadyMarker(markerPath)) === key && (await Bun.file(python).exists())) return python;
	onPhase?.("initiate");
	await fs.mkdir(path.dirname(dir), { recursive: true });
	const result = await withFileLock(
		`${dir}.install`,
		async () => {
			if ((await readReadyMarker(markerPath)) === key && (await Bun.file(python).exists())) return python;
			onPhase?.("download");
			const uv = $which("uv");
			const interpreter = uv ?? (await systemPython(options));
			// A mismatched marker can leave incompatible packages or a partially installed environment.
			await fs.rm(dir, { recursive: true, force: true });
			const create = await (
				uv
					? $`${uv} venv --quiet --python ${`>=${options.python.min},<${options.python.below}`} ${dir}`
					: $`${interpreter} -m venv ${dir}`
			)
				.quiet()
				.nothrow();
			if (create.exitCode !== 0)
				throw new Error(`${label} venv failed (exit ${create.exitCode}): ${create.stderr.toString().trim()}`);
			const pip = await (
				uv
					? $`${uv} pip install --quiet --python ${python} ${install}`
					: $`${python} -m pip install --quiet --disable-pip-version-check ${install}`
			)
				.quiet()
				.nothrow();
			if (pip.exitCode !== 0)
				throw new Error(`${label} pip install failed (exit ${pip.exitCode}): ${pip.stderr.toString().trim()}`);
			await Bun.write(markerPath, `${key}\n`);
			return python;
		},
		{ retries: 3600, retryDelayMs: 1000 },
	);
	onPhase?.("done");
	return result;
}
