/**
 * Agent Teams: declarative team files (`.omp/teams/*.md`, `~/.omp/agent/teams/*.md`)
 * parsed into spawnable member lists. A team file references existing agent
 * definitions by name; `/team start` spawns each member through the shared
 * subagent seam with a stable handle as its registry id.
 *
 * Discovery mirrors agent discovery: project `.omp/teams/` wins over the user
 * `~/.omp/agent/teams/`, first-wins by team name, a malformed file is a
 * warning + skip that never breaks the rest.
 */
import type * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import { getConfigDirs, findAllNearestProjectConfigDirs } from "../config";
import teamTaskProtocolTemplate from "../prompts/system/team-task-protocol.md" with { type: "text" };
import { sanitizeAgentId } from "./name-generator";

/** One member entry from the team file's frontmatter. */
export interface TeamMember {
	/** Agent definition name resolved through standard discovery. */
	agent: string;
	/** Stable handle: becomes the spawn's registry id (`agent://<handle>`). */
	handle: string;
	/** Free-text role description rendered into the member's context. */
	role?: string;
}

/** A parsed team file. */
export interface TeamDefinition {
	/** Team name (unique across discovery scopes). */
	name: string;
	/** Short description for listings. */
	description: string;
	/** Shared workspace directory (absolute); omitted means the session cwd. */
	workspace?: string;
	/** Members to spawn on `/team start`. */
	members: TeamMember[];
	/** Initial task titles, seeded only when a ledger is first created. */
	tasks?: string[];
	/** Shared context block rendered into every member's prompt. */
	context?: string;
	/** The file's body: the team's standing instruction. */
	body: string;
	/** Where the file was found (user/project). */
	source: "user" | "project";
	/** Absolute path of the file (for error messages). */
	filePath: string;
}

/** Parse one team file's bytes; returns undefined (with a logged warning) when malformed. */
export function parseTeamFile(contents: string, filePath: string): TeamDefinition | undefined {
	const { frontmatter, body } = parseFrontmatter(contents, { source: filePath });
	if (typeof frontmatter.name !== "string" || frontmatter.name.trim().length === 0) {
		logger.warn(`team file ${filePath}: frontmatter 'name' is required; skipped`);
		return undefined;
	}
	if (typeof frontmatter.description !== "string" || frontmatter.description.trim().length === 0) {
		logger.warn(`team file ${filePath}: frontmatter 'description' is required; skipped`);
		return undefined;
	}
	const rawMembers = Array.isArray(frontmatter.members) ? frontmatter.members : [];
	const members: TeamMember[] = [];
	for (const raw of rawMembers) {
		if (typeof raw !== "object" || raw === null) {
			logger.warn(`team file ${filePath}: a member entry is not a mapping; skipped member`);
			continue;
		}
		const record = raw as Record<string, unknown>;
		if (typeof record.agent !== "string" || record.agent.trim().length === 0) {
			logger.warn(`team file ${filePath}: member 'agent' is required; skipped member`);
			continue;
		}
		if (typeof record.handle !== "string" || record.handle.trim().length === 0) {
			logger.warn(`team file ${filePath}: member 'handle' is required; skipped member`);
			continue;
		}
		members.push({
			agent: record.agent.trim(),
			handle: record.handle.trim(),
			...(typeof record.role === "string" && record.role.trim().length > 0 ? { role: record.role.trim() } : {}),
		});
	}
	if (members.length === 0) {
		logger.warn(`team file ${filePath}: no valid members; skipped`);
		return undefined;
	}
	let tasks: string[] | undefined;
	if ("tasks" in frontmatter) {
		if (
			!Array.isArray(frontmatter.tasks) ||
			frontmatter.tasks.some(task => typeof task !== "string" || task.trim().length === 0)
		) {
			logger.warn(`team file ${filePath}: frontmatter 'tasks' must be a list of non-empty strings; skipped`);
			return undefined;
		}
		tasks = frontmatter.tasks.map((task: string) => task.trim());
	}
	const workspace =
		typeof frontmatter.workspace === "string" && frontmatter.workspace.trim().length > 0
			? path.resolve(path.dirname(filePath), frontmatter.workspace.trim())
			: undefined;
	return {
		name: frontmatter.name.trim(),
		description: frontmatter.description.trim(),
		...(workspace !== undefined ? { workspace } : {}),
		members,
		...(tasks !== undefined ? { tasks } : {}),
		...(typeof frontmatter.context === "string" && frontmatter.context.trim().length > 0
			? { context: frontmatter.context }
			: {}),
		body: body.trim(),
		source: "project",
		filePath,
	};
}

async function loadTeamsFromDir(dir: string, source: "user" | "project"): Promise<TeamDefinition[]> {
	const teams: TeamDefinition[] = [];
	let entries: fsSync.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return teams;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const parsed = parseTeamFile(await fs.readFile(filePath, "utf8"), filePath);
			if (parsed !== undefined) teams.push({ ...parsed, source });
		} catch (error) {
			logger.warn(`team file ${filePath}: unreadable (${String(error)}); skipped`);
		}
	}
	return teams;
}

/** Discover team files: project `.omp/teams/` (nearest config dirs) first, then the user dir. First-wins by name. */
export async function discoverTeams(cwd: string): Promise<TeamDefinition[]> {
	const found = new Map<string, TeamDefinition>();
	const resolvedCwd = path.resolve(cwd);
	const teamsConfigSource = ".omp";
	const userDir = getConfigDirs("teams", { project: false })
		.filter(entry => entry.source === teamsConfigSource)
		.map(entry => path.resolve(entry.path))[0];
	const projectDir = findAllNearestProjectConfigDirs("teams", resolvedCwd)
		.filter(entry => entry.source === teamsConfigSource)
		.map(entry => path.resolve(entry.path))[0];
	const ordered: Array<{ dir: string; source: "user" | "project" }> = [];
	if (projectDir !== undefined) ordered.push({ dir: projectDir, source: "project" });
	if (userDir !== undefined) ordered.push({ dir: userDir, source: "user" });
	for (const { dir, source } of ordered) {
		for (const team of await loadTeamsFromDir(dir, source)) {
			if (!found.has(team.name)) found.set(team.name, team);
		}
	}
	return [...found.values()];
}

/** A member referencing an agent no discovery provides: `start` refuses with the available list. */
export class UnknownTeamAgentError extends Error {
	constructor(member: TeamMember, availableAgents: readonly string[]) {
		super(
			`Team member "${member.handle}" references unknown agent "${member.agent}". Available agents: ${
				availableAgents.join(", ") || "none"
			}`,
		);
		this.name = "UnknownTeamAgentError";
	}
}

/** Validate that every member's agent resolves; throws {@link UnknownTeamAgentError} on the first miss. */
export function resolveTeamMembers(team: TeamDefinition, availableAgents: readonly { name: string }[]): void {
	const names = new Set(availableAgents.map(agent => agent.name));
	for (const member of team.members) {
		if (!names.has(member.agent)) {
			throw new UnknownTeamAgentError(member, [...names]);
		}
	}
}

/**
 * Normalize a handle into the exact id the spawn seam reserves
 * (`sanitizeAgentId`, including its 48-character cap). Status, stop, the
 * rendered context and the peer list all use this one normalizer, so members
 * address each other by real `agent://` ids.
 */
export function sanitizeTeamHandle(handle: string): string {
	return sanitizeAgentId(handle) ?? "member";
}

/** Render the per-member context block: team identity, role, workspace, and task protocol. */
export function renderTeamMemberContext(
	team: TeamDefinition,
	member: TeamMember,
	memberIds?: ReadonlyMap<TeamMember, string>,
): string {
	const handle = memberIds?.get(member) ?? sanitizeTeamHandle(member.handle);
	const lines: string[] = [
		`Team: ${team.name} — ${team.description}`,
		`Your handle: ${handle} (peers message you via write agent://${handle})`,
	];
	if (member.role !== undefined) lines.push(`Your role: ${member.role}`);
	if (team.workspace !== undefined) {
		lines.push(`Team workspace: ${team.workspace}`);
	}
	lines.push(prompt.render(teamTaskProtocolTemplate, { teamName: team.name }).trim());
	const peers = team.members.filter(other => other.handle !== member.handle);
	if (peers.length > 0) {
		lines.push(
			`Teammates (message them directly with write agent://<handle>): ${peers
				.map(
					peer =>
						`${memberIds?.get(peer) ?? sanitizeTeamHandle(peer.handle)} (${peer.agent}${peer.role !== undefined ? ` - ${peer.role}` : ""})`,
				)
				.join("; ")}`,
		);
	}
	if (team.context !== undefined) lines.push("", team.context);
	return lines.join("\n");
}

/** The prompt handed to a member on `/team start [assignment]`. */
export function renderTeamMemberPrompt(team: TeamDefinition, assignment: string | undefined): string {
	const parts = [team.body];
	if (assignment !== undefined && assignment.trim().length > 0) {
		parts.push("", `Team assignment from the lead: ${assignment.trim()}`);
	}
	return parts.join("\n").trim();
}

export const TEAMS_DIR_MARKER = path.join(os.homedir(), ".omp");
