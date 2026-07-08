/**
 * Bundled builtin skills shipped with the coding agent.
 *
 * Each markdown source is embedded via `with { type: "text" }` so it survives
 * `bun build --compile` (the compiled binary ships no loose skill files; only
 * the embedded text). The native source/tarball installs read the same modules.
 *
 * Registered by the lowest-priority `builtin-skills` provider so any
 * user/project/tool skill with the same name overrides the bundled copy.
 */
import agenticMapreduce from "./agentic-mapreduce.md" with { type: "text" };
import ompkSwarmCore from "./ompk-swarm-core.md" with { type: "text" };
import promptbtwHandoff from "./promptbtw-handoff.md" with { type: "text" };
import treeOfThoughts from "./tree-of-thoughts.md" with { type: "text" };

/** A bundled skill's stable name and raw markdown (frontmatter + body). */
export interface BuiltinSkillSource {
	name: string;
	content: string;
}

/** All bundled builtin skills, ordered by name. */
export const BUILTIN_SKILL_SOURCES: readonly BuiltinSkillSource[] = [
	{ name: "agentic-mapreduce", content: agenticMapreduce },
	{ name: "ompk-swarm-core", content: ompkSwarmCore },
	{ name: "promptbtw-handoff", content: promptbtwHandoff },
	{ name: "tree-of-thoughts", content: treeOfThoughts },
];
