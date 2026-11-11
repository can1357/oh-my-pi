import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getConfigDirName,
	isBunTestRuntime,
	pathIsWithin,
	resolveEquivalentPath,
} from "@oh-my-pi/pi-utils";

const TEST_REAL_HOMEDIR_ENV = "PI_TEST_REAL_HOMEDIR";

function resolveRealHomedir(): string {
	const exported = process.env[TEST_REAL_HOMEDIR_ENV];
	if (exported) return exported;
	const home = os.homedir();
	if (isBunTestRuntime()) {
		process.env[TEST_REAL_HOMEDIR_ENV] = home;
	}
	return home;
}

const REAL_HOMEDIR = resolveRealHomedir();

export class CollabTestIsolationError extends Error {
	constructor(targetDir: string) {
		super(
			`Refusing to use unisolated collab directory "${targetDir}" under real home during bun test. ` +
				`Isolate home via installInMemoryRelay(), mock os.homedir() / getConfigRootDir(), or pass an explicit temp directory.`,
		);
		this.name = "CollabTestIsolationError";
	}
}

function isWithinRealConfigDir(targetDir: string, configDirName: string): boolean {
	const realConfigRoot = resolveEquivalentPath(path.join(REAL_HOMEDIR, configDirName), {
		throughMissing: true,
	});
	return pathIsWithin(realConfigRoot, targetDir, { throughMissing: true });
}

/**
 * Guard collab disk state (`~/.omp/collab`, `~/.omp/run/collab-hosts`) against
 * unisolated `bun test` suites so offending tests fail loudly instead of
 * touching the developer's `~/.omp` or leaking files into a shared temp dir.
 *
 * Checks containment against `REAL_HOMEDIR/<configDir>` rather than all of
 * `REAL_HOMEDIR` so temp directories inside the user home (e.g. Windows
 * `%USERPROFILE%\AppData\Local\Temp` or `TMPDIR=$HOME/tmp`) pass cleanly.
 */
export function assertIsolatedTestCollabDir(targetDir: string): string {
	if (!isBunTestRuntime()) return targetDir;
	const configuredDirName = getConfigDirName();
	if (
		isWithinRealConfigDir(targetDir, configuredDirName) ||
		(configuredDirName !== CONFIG_DIR_NAME && isWithinRealConfigDir(targetDir, CONFIG_DIR_NAME))
	) {
		throw new CollabTestIsolationError(targetDir);
	}
	return targetDir;
}
