/**
 * Remote Skill Provider
 *
 * Discovers skills registered by `omp skill remote add` from the local
 * descriptor index. Nothing is fetched here: `path` points at the content cache
 * location for the pinned commit, and `skill://` materializes a file on first
 * read (see `src/skills/remote/store.ts`).
 *
 * Priority 25 sits below every authored provider (native 100 through github 30)
 * and above auto-learned managed skills, so a local skill always wins a name
 * collision without a special collision rule: a remote source is a
 * distribution channel, not an authored skill.
 */
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	loadRemoteSkillDescriptors,
	remoteSkillCachePath,
	REMOTE_SKILL_PROVIDER_ID,
	type RemoteSkillIndexEntry,
} from "../skills/remote/store";
import { createSourceMeta } from "./helpers";

const PRIORITY = 25;

/** Single-token namespace for collision aliases (`skill://owner-repo/name`). */
function repositoryNamespace(repository: string): string {
	return repository.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
}

async function loadRemoteSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const agentDir = ctx.agentDir ?? getAgentDir();
	const warnings: string[] = [];
	let entries: RemoteSkillIndexEntry[];
	try {
		entries = await loadRemoteSkillDescriptors(ctx.cwd, agentDir);
	} catch (error) {
		return { items: [], warnings: [`[remote] ${error instanceof Error ? error.message : String(error)}`] };
	}

	const items: Skill[] = entries.map(({ descriptor, level }) => {
		const skillPath = remoteSkillCachePath(descriptor, "SKILL.md", agentDir);
		return {
			name: descriptor.name,
			path: skillPath,
			// Body stays remote: `skill://` fetches it at the pinned commit on first read.
			content: "",
			frontmatter: { name: descriptor.name, description: descriptor.description },
			level,
			remote: {
				origin: descriptor.origin,
				repository: descriptor.repository,
				directory: descriptor.directory,
				commit: descriptor.commit,
			},
			_source: createSourceMeta(
				REMOTE_SKILL_PROVIDER_ID,
				skillPath,
				level,
				descriptor.repository,
				repositoryNamespace(descriptor.repository),
			),
		};
	});

	return { items, warnings };
}

registerProvider<Skill>(skillCapability.id, {
	id: REMOTE_SKILL_PROVIDER_ID,
	displayName: "Remote Skills (GitHub)",
	description: "Skills pinned to an immutable commit of a GitHub repository",
	priority: PRIORITY,
	load: loadRemoteSkills,
});
