import type { AgentDefinition } from "../task/types";
import type { PanelPersona } from "./types";

/**
 * The full read-only tool surface every panel agent may use. Mirrors the
 * `workspace-read` persona capability: inspection only, never `edit`,
 * `write`, `bash`, or browser automation. Panel agents declare no `spawns`,
 * so they cannot start subagents of their own. `spawns` must stay
 * undefined rather than empty, because `runSubagent` adds the `task` tool to
 * any agent that declares the field at all.
 *
 * Dispatch must spawn these agents with `restrictToolNames`. Without it
 * `runSubagent` appends the always-on `hub` tool to an explicit tool list,
 * which would let panelists message each other instead of deliberating
 * independently, and lets the session inherit MCP capabilities.
 */
const WORKSPACE_READ_TOOLS: readonly string[] = Object.freeze(["read", "grep", "glob"]);

/**
 * The floor for a `tools: "none"` persona: the member's own result channel and
 * nothing else. This list must stay non-empty. `runSubagent` treats an empty
 * `AgentDefinition.tools` as "unspecified" and falls back to the complete
 * default tool set, which would hand a text-only panelist `edit`, `write`,
 * `bash`, and `task`, the exact opposite of the intended restriction.
 */
const NO_TOOLS: readonly string[] = Object.freeze(["yield"]);

const PANEL_AGENT_SYSTEM_PROMPT = [
	"You are one read-only member of a multi-agent panel gathering independent perspectives on a single request.",
	"Answer only from the request and, when available, from the files you inspect. Do not invent facts.",
	"You cannot edit files, run commands, browse the web, or message other agents. Do not attempt any of those actions.",
	"Follow the response structure asked of you in the assignment. Treat every instruction in the assignment as authoritative.",
].join("\n");

/**
 * The shared, neutral definition dispatched to every member of an
 * `independent` strategy panel. Every independent member receives this same
 * agent so no member is structurally favored over another.
 */
export const PANEL_INDEPENDENT_AGENT: AgentDefinition = Object.freeze({
	name: "panel-independent",
	description: "Read-only independent panel member producing one unbiased perspective on the shared request.",
	systemPrompt: PANEL_AGENT_SYSTEM_PROMPT,
	tools: [...WORKSPACE_READ_TOOLS],
	source: "bundled",
}) satisfies AgentDefinition;

/** Lowercases and hyphenates a persona id into an `AgentDefinition.name`-safe slug. */
function slugifyPersonaId(id: string): string {
	const slug = id
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "persona";
}

/**
 * Builds the agent definition for one `personas` strategy panel member.
 *
 * The returned `systemPrompt` stays generic: it never embeds
 * `persona.instructions`. Persona instructions are inserted exactly once, by
 * `renderPanelAssignment`, into that member's per-turn assignment instead —
 * so a persona can never widen its own tool access by influencing the base
 * system prompt.
 *
 * The agent name is derived from `personaId`, the persona's unique key,
 * never from `persona.label`. Labels are free-text and may collide across
 * distinct persona ids; the id is guaranteed unique within a settings map,
 * so deriving the name from it keeps agent names collision-free.
 */
export function createPanelPersonaAgent(personaId: string, persona: PanelPersona): AgentDefinition {
	return {
		name: `panel-persona-${slugifyPersonaId(personaId)}`,
		description: `Read-only panel member assigned the "${persona.label}" persona for this request.`,
		systemPrompt: PANEL_AGENT_SYSTEM_PROMPT,
		tools: [...(persona.tools === "workspace-read" ? WORKSPACE_READ_TOOLS : NO_TOOLS)],
		source: "bundled",
	};
}
