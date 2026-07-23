#!/usr/bin/env bun
/**
 * Resolve (or deliberately create) the Linear project for this repository.
 *
 * Usage:
 *   bun scripts/resolve-project.ts            # resolve/adopt only; never creates
 *   bun scripts/resolve-project.ts --create   # permit creation (needs defaults.teamId)
 *
 * Requires LINEAR_API_TOKEN. Reads and writes `<repo-root>/.ompk/linear.json`;
 * commit that file — it is the shared repo → project truth for every agent.
 * Exit codes: 0 resolved, 1 usage/config error, 2 blocked (human decision).
 */

import { $ } from "bun";
import { createLinearProject, fetchProject, type LinearProject, listProjects } from "../src/linear";
import { normalizeRepoKey, type ProjectRegistry, resolveProject } from "../src/project-resolver";

const token = Bun.env.LINEAR_API_TOKEN;
if (!token) {
	console.error("LINEAR_API_TOKEN is required");
	process.exit(1);
}

const allowCreate = Bun.argv.includes("--create");
const remote = (await $`git remote get-url origin`.text()).trim();
const repoKey = normalizeRepoKey(remote);
if (!repoKey) {
	console.error(`cannot normalize remote '${remote}' to owner/repo`);
	process.exit(1);
}
const root = (await $`git rev-parse --show-toplevel`.text()).trim();
const registryPath = `${root}/.ompk/linear.json`;

async function listAllProjects(): Promise<LinearProject[]> {
	const all: LinearProject[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < 5; page++) {
		const { nodes, endCursor, hasNextPage } = await listProjects(token!, cursor);
		all.push(...nodes);
		if (!hasNextPage) return all;
		cursor = endCursor;
	}
	throw new Error("workspace has more than 500 projects; refusing unbounded scan");
}

const outcome = await resolveProject(
	{
		readRegistry: async () => {
			const file = Bun.file(registryPath);
			return (await file.exists()) ? ((await file.json()) as ProjectRegistry) : null;
		},
		writeRegistry: async registry => {
			await Bun.write(registryPath, `${JSON.stringify(registry, null, "\t")}\n`);
		},
		fetchProject: id => fetchProject(token!, id),
		listAllProjects,
		createProject: input => createLinearProject(token!, input),
		now: () => new Date(),
	},
	{ repoKey, allowCreate },
);

if (!outcome.ok) {
	switch (outcome.reason) {
		case "registry_project_missing":
			console.error(
				`registry maps ${repoKey} to a project Linear no longer knows. ` +
					`Decide manually: fix the projectId in .ompk/linear.json or remove the entry, then rerun.`,
			);
			break;
		case "registry_project_archived":
			console.error(
				`registry maps ${repoKey} to an ARCHIVED project. ` +
					`Unarchive it or point .ompk/linear.json at the successor; refusing to recreate silently.`,
			);
			break;
		case "multiple_matches":
			console.error(`multiple Linear projects claim '${repoKey}'; keep one repo-key line and rerun:`);
			for (const candidate of outcome.candidates ?? []) {
				console.error(`  - ${candidate.name} (${candidate.id})`);
			}
			break;
		case "creation_disabled":
			console.error(`no Linear project found for ${repoKey}. Rerun with --create to create one deliberately.`);
			break;
		case "missing_team_config":
			console.error(
				`creation needs a team: set { "defaults": { "teamId": "<linear-team-id>" } } in .ompk/linear.json and rerun.`,
			);
			break;
	}
	process.exit(2);
}

console.log(`${outcome.outcome}: ${repoKey} -> ${outcome.projectId}`);
const registry = (await Bun.file(registryPath).json()) as ProjectRegistry;
const allowlist = Object.values(registry.projects)
	.map(entry => entry.projectId)
	.join(",");
console.log(`worker allowlist (ALLOWED_PROJECT_IDS): ${allowlist}`);
