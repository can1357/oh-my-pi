import * as os from "node:os";
import * as path from "node:path";
import {
	directoryExists,
	getAgentDir,
	getProjectDir,
	MAIN_CONFIG_FILENAMES,
	normalizePathForComparison,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { readFile } from "../capability/fs";
import { expandTilde } from "../tools/path-utils";
import type { Args } from "./args";

async function readScratchDir(home: string): Promise<string | undefined> {
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const content = await readFile(path.join(getAgentDir(), filename));
		if (content === null) continue;
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch {
			return undefined;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		// Keep these YAML keys aligned with cfgStartupScratchDir.
		const startup = "startup" in parsed ? parsed.startup : undefined;
		if (startup === null || typeof startup !== "object" || Array.isArray(startup)) {
			return undefined;
		}
		const raw = "scratchDir" in startup ? startup.scratchDir : undefined;
		if (typeof raw !== "string" || !raw.trim()) return undefined;
		return path.resolve(home, expandTilde(raw, home));
	}
	return undefined;
}

async function maybeAutoChdir(parsed: Args): Promise<string | undefined> {
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

	const scratchDir = await readScratchDir(home);
	let warning: string | undefined;
	if (scratchDir) {
		try {
			if (await directoryExists(scratchDir)) {
				setProjectDir(scratchDir);
				return undefined;
			}
		} catch {
			// Use the default fallback when the configured directory cannot be entered.
		}
		warning = `Scratch directory ${scratchDir} (startup.scratchDir) is not an existing directory; using the default fallback.`;
	}

	const candidates =
		process.platform === "win32" ? [path.join(home, "tmp")] : [path.join(home, "tmp"), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		try {
			if (!(await directoryExists(candidate))) {
				continue;
			}
			setProjectDir(candidate);
			return warning;
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
	return warning;
}

export async function applyStartupCwd(parsed: Args): Promise<string | undefined> {
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
		return undefined;
	}
	return await maybeAutoChdir(parsed);
}
