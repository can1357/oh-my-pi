/**
 * `~/.omp/agent/projects.yml` — the machine-local map from a logical project id
 * to this machine's checkout path, plus the per-project sync toggle.
 *
 * This file is deliberately **never replicated** (see the exclusion list in
 * `state-broker/config-files.ts`): its whole purpose is to record what is
 * machine-*specific*. Machine A may hold `~/projects/foo` while machine B holds
 * the same logical project at `~/dev/foo`; both register the same `id`, and the
 * replication boundary translates paths through it.
 *
 * Ids are resolved to git remotes at registration time (`omp project enable`),
 * never at sync time — replication runs on synchronous code paths and must not
 * shell out to git.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { ConfigFile, stringifyYamlConfig } from "./config-file";

/** One registered project on this machine. */
export interface ProjectEntry {
	/**
	 * Machine-independent project identity. Shared verbatim by every machine
	 * that holds this project. Derived from the git origin remote when one
	 * exists (`git:github.com/owner/repo`), otherwise user-assigned.
	 */
	id: string;
	/** Absolute path to this machine's checkout. */
	path: string;
	/** Whether this project's sessions and prompt history replicate. */
	sync: boolean;
}

export interface ProjectsConfig {
	version?: number;
	projects?: ProjectEntry[];
}

const projectEntrySchema = type({
	id: type("string").atLeastLength(1).atMostLength(512),
	path: type("string").atLeastLength(1),
	sync: "boolean",
	"+": "reject",
});

const projectsConfigSchema = type({
	"version?": "number.integer >= 1",
	"projects?": projectEntrySchema.array(),
	"+": "reject",
});

export const PROJECTS_CONFIG_ID = "projects";

/** Current on-disk schema version. */
export const PROJECTS_CONFIG_VERSION = 1;

/**
 * Template instance. `ConfigFile` freezes its path at construction, so this is
 * never read directly — {@link projectsFileFor} relocates it against the agent
 * dir that is active at call time.
 */
export const ProjectsConfigFile = new ConfigFile<ProjectsConfig>(PROJECTS_CONFIG_ID, projectsConfigSchema);

/** Absolute path of the projects registry for the given (or active) agent dir. */
export function getProjectsConfigPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, `${PROJECTS_CONFIG_ID}.yml`);
}

let relocated: ConfigFile<ProjectsConfig> | undefined;
let relocatedPath: string | undefined;

/**
 * The registry file bound to the *currently active* agent dir.
 *
 * A module-level `ConfigFile` captures `getAgentDir()` at import time, which is
 * wrong twice over: `refreshDirsFromEnv()` re-resolves the agent dir after
 * `.env` loading, and a named profile moves it to
 * `~/.omp/profiles/<name>/agent`. Reading a stale path would silently load
 * another profile's project map, and since resolution fails closed the symptom
 * would be "replication mysteriously does nothing". `model-registry.ts:355`
 * solves the same problem the same way, via `relocate()`.
 *
 * `relocate()` returns the receiver unchanged when the path already matches, so
 * the common single-profile case keeps one instance and its parse cache.
 */
function projectsFileFor(agentDir?: string): ConfigFile<ProjectsConfig> {
	const target = getProjectsConfigPath(agentDir);
	if (!relocated || relocatedPath !== target) {
		relocated = ProjectsConfigFile.relocate(target);
		relocatedPath = target;
	}
	return relocated;
}

/**
 * Read the registry. A missing or malformed file yields an empty list rather
 * than throwing: an unreadable registry must degrade to "nothing is synced"
 * (fail closed), never to a crashed session.
 *
 * Reads through `ConfigFile`'s parse cache deliberately. `omp project enable`
 * runs in a *different process*, so its `invalidate()` cannot reach a running
 * TUI; without dropping the cache here the caller-side snapshot TTL in
 * `state-broker/project-scope.ts` would expire against a permanently stale
 * parse and never observe the change. Callers already throttle (that TTL), so
 * the cost is one small YAML parse per interval rather than per row.
 */
export function loadProjects(agentDir?: string): ProjectEntry[] {
	const file = projectsFileFor(agentDir);
	file.invalidate();
	const result = file.tryLoad();
	if (result.status === "error") {
		logger.warn("projects.yml unreadable; treating every project as unsynced", {
			error: String(result.error),
		});
		return [];
	}
	if (result.status === "not-found") return [];
	return result.value.projects ?? [];
}

/**
 * Replace the registry.
 *
 * Atomic temp-file + rename, mirroring `Settings.#writeYamlAtomically`, so a
 * crash mid-write cannot leave a half-serialized registry — which, because
 * resolution fails closed, would silently stop all replication.
 */
export function saveProjects(entries: readonly ProjectEntry[], agentDir: string = getAgentDir()): void {
	const target = getProjectsConfigPath(agentDir);
	const payload: ProjectsConfig = {
		version: PROJECTS_CONFIG_VERSION,
		projects: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
	};
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, stringifyYamlConfig(payload), "utf-8");
		fs.renameSync(tmp, target);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
	// Invalidate the instance actually bound to `target`, not the import-time
	// template, or the next read serves the pre-write parse from cache.
	projectsFileFor(agentDir).invalidate();
}

/**
 * Normalize a git remote URL into a stable project id.
 *
 * Both `git@github.com:owner/repo.git` and
 * `https://github.com/owner/repo` collapse to `git:github.com/owner/repo`, so
 * two machines that cloned the same repo over different transports still agree.
 * Returns undefined for a URL shape we cannot normalize confidently — better to
 * make the user name the project than to invent an id that will not match.
 */
export function projectIdFromRemoteUrl(remoteUrl: string): string | undefined {
	const trimmed = remoteUrl.trim().replace(/\.git$/, "");
	if (!trimmed) return undefined;

	// scp-like syntax: git@host:owner/repo
	const scp = /^[^@/]+@([^:]+):(.+)$/.exec(trimmed);
	if (scp) return `git:${scp[1].toLowerCase()}/${stripLeadingSlash(scp[2])}`;

	// URL syntax: scheme://[user@]host[:port]/owner/repo
	const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
	if (url) return `git:${url[1].toLowerCase()}/${stripLeadingSlash(url[2])}`;

	return undefined;
}

function stripLeadingSlash(value: string): string {
	return value.replace(/^\/+/, "").replace(/\/+$/, "");
}
