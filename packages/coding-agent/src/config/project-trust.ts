import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { getCapability, listCapabilities, loadCapability } from "../capability";
import type { SourceMeta } from "../capability/types";
import { resolveActiveProjectRegistryPath } from "../discovery/helpers";
import { replaceFileAtomically } from "../utils/atomic-file";

const TRUSTED_PROJECTS_FILENAME = "trusted-projects.json";

function trustedProjectsPath(agentDir: string): string {
	return path.join(agentDir, TRUSTED_PROJECTS_FILENAME);
}

/**
 * Read the project roots the user trusts to run project-level code
 * (`~/.omp/agent/trusted-projects.json`). A missing file yields an empty set; a
 * corrupt one degrades to empty with a warning, which fails closed.
 */
export async function loadTrustedProjects(agentDir: string = getAgentDir()): Promise<Set<string>> {
	try {
		const roots: unknown = JSON.parse(await fs.readFile(trustedProjectsPath(agentDir), "utf-8"));
		if (!Array.isArray(roots)) return new Set();
		return new Set(roots.filter((root): root is string => typeof root === "string"));
	} catch (err) {
		if (isEnoent(err)) return new Set();
		logger.warn("Failed to read trusted projects", { error: err });
		return new Set();
	}
}

/** Persist trust for one project root; same lock + atomic replace as `session-pins.ts`. */
export async function trustProject(projectRoot: string, agentDir: string = getAgentDir()): Promise<void> {
	const filePath = trustedProjectsPath(agentDir);
	await fs.mkdir(agentDir, { recursive: true });
	await withFileLock(filePath, async () => {
		const trusted = await loadTrustedProjects(agentDir);
		if (trusted.has(projectRoot)) return;
		trusted.add(projectRoot);
		const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(tmpPath, JSON.stringify([...trusted], null, "\t"), { encoding: "utf-8", mode: 0o600 });
			await replaceFileAtomically(tmpPath, filePath);
		} catch (error) {
			await fs.rm(tmpPath, { force: true }).catch(() => {});
			throw error;
		}
	});
}

/** One project file that would run code: what it provides and where it lives. */
export interface ProjectCodeSource {
	kind: string;
	path: string;
}

/**
 * List the project-level files under `cwd` that run code at startup, regardless
 * of trust, so the trust prompt can show what the user is agreeing to.
 */
export async function listProjectCodeSources(cwd: string): Promise<ProjectCodeSource[]> {
	const sources: ProjectCodeSource[] = [];
	const seen = new Set<string>();
	const add = (kind: string, sourcePath: string) => {
		if (seen.has(sourcePath)) return;
		seen.add(sourcePath);
		sources.push({ kind, path: sourcePath });
	};
	for (const id of listCapabilities()) {
		const capability = getCapability(id);
		if (!capability?.executesCode) continue;
		const result = await loadCapability<{ _source: SourceMeta }>(id, {
			cwd,
			includeUntrusted: true,
			filter: item => item._source.level === "project",
		});
		for (const item of result.items) add(capability.displayName, item._source.path);
	}
	const registryPath = await resolveActiveProjectRegistryPath(cwd);
	if (registryPath && (await Bun.file(registryPath).exists())) add("Plugins", registryPath);
	return sources;
}
