import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import {
	directoryExists,
	getAgentDir,
	getProjectDir,
	isRecord,
	normalizePathForComparison,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { ConfigFile } from "../config/config-file";
import type { Args } from "./args";

async function maybeAutoChdir(parsed: Args): Promise<void> {
	if (parsed.allowHome || parsed.cwd) {
		return;
	}

	const home = os.homedir();
	if (!home) {
		return;
	}

	const normalizePath = normalizePathForComparison;

	const cwd = normalizePath(getProjectDir());
	const normalizedHome = normalizePath(home);
	if (cwd !== normalizedHome) {
		return;
	}

	// Project settings cannot be resolved until the startup directory is chosen.
	const config = new ConfigFile<unknown>("config", type("unknown"), path.join(getAgentDir(), "config.yml")).tryLoad();
	if (config.status === "ok" && isRecord(config.value)) {
		const startup = config.value.startup;
		const allowHome = config.value["startup.allowHome"] ?? (isRecord(startup) ? startup.allowHome : undefined);
		if (allowHome === true) return;
	}

	const candidates =
		process.platform === "win32" ? [path.join(home, "tmp")] : [path.join(home, "tmp"), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		try {
			if (!(await directoryExists(candidate))) {
				continue;
			}
			setProjectDir(candidate);
			return;
		} catch {
			// Try next candidate.
		}
	}

	try {
		const fallback = os.tmpdir();
		if (fallback && normalizePath(fallback) !== cwd && (await directoryExists(fallback))) {
			setProjectDir(fallback);
		}
	} catch {
		// Ignore fallback errors.
	}
}

export async function applyStartupCwd(parsed: Args): Promise<void> {
	if (parsed.cwd) {
		try {
			setProjectDir(parsed.cwd);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			// Permission denials are the macOS TCC case; a plain ENOENT typo
			// should not be told to grant Full Disk Access.
			const code = (error as NodeJS.ErrnoException | null)?.code;
			const hint =
				code === "EACCES" || code === "EPERM"
					? " On macOS, grant omp Files & Folders or Full Disk Access permission for the target directory."
					: "";
			throw new Error(`Cannot change working directory to ${parsed.cwd}: ${reason}.${hint}`);
		}
		// setProjectDir resolves the (possibly relative) target against the launch
		// cwd and chdirs into it. Re-sync parsed.cwd to the resolved absolute path
		// so downstream consumers (buildSessionOptions, settings/discovery, session
		// persistence) don't re-resolve a relative string against the new cwd.
		parsed.cwd = getProjectDir();
		return;
	}
	await maybeAutoChdir(parsed);
}
