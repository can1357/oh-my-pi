/**
 * `/team` — start, list, status, and stop declarative agent teams
 * (`.omp/teams/*.md`). Members spawn through the shared subagent seam with
 * stable handles as registry ids; they see each other via `agent://<handle>`
 * and share the team workspace.
 */
import { AgentRegistry, type AgentRef } from "../registry/agent-registry";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { discoverAgents } from "../task/discovery";
import { isReadOnlyAgent } from "../task/read-only-policy";
import {
	discoverTeams,
	ensureTeamTasksFile,
	renderTeamMemberContext,
	renderTeamMemberPrompt,
	resolveTeamMembers,
	sanitizeTeamHandle,
	type TeamDefinition,
} from "../task/teams";
import { SpawnPendingError, spawnSubagentForSession } from "../task/spawn-subagent";
import { releaseStructuredSubagentId, reserveStructuredSubagentId } from "../task/structured-subagent";
import { cfgTeamEnabled, cfgTeamMaxTeammates } from "../task/settings";
import { commandConsumed, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

const USAGE = [
	"Usage:",
	"  /team start <name> [assignment]  spawn every member of team <name>",
	"  /team list                       show discovered team files",
	"  /team status [name]              member handles + live registry status",
	"  /team stop <name|all>            release the team's members (transcripts kept)",
].join("\n");

function teamRuntimeError(message: string): string {
	return `team: ${message}`;
}

interface TeamMembership {
	id: string;
	ref?: AgentRef;
	/** Why a pending spawn ended without registering. */
	failure?: string;
}

let teamMemberships = new WeakMap<object, Map<string, Map<string, TeamMembership>>>();

/** Test-only: clear recorded team membership between cases. */
export function resetTeamMembershipsForTests(): void {
	teamMemberships = new WeakMap();
}

function membershipsFor(session: object): Map<string, Map<string, TeamMembership>> {
	let memberships = teamMemberships.get(session);
	if (!memberships) {
		memberships = new Map();
		teamMemberships.set(session, memberships);
	}
	return memberships;
}

/** One `<team>:` block per selected team, filled from that team's members recorded in this session. */
async function teamReport(
	session: object,
	selected: readonly TeamDefinition[],
	describe: (team: TeamDefinition, recorded: Map<string, TeamMembership> | undefined) => string[] | Promise<string[]>,
): Promise<string> {
	const lines: string[] = [];
	for (const team of selected) {
		lines.push(`${team.name}:`, ...(await describe(team, membershipsFor(session).get(team.name))));
	}
	return lines.join("\n");
}

export const BUILTIN_TEAMS_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "team",
		description: "Start, watch, and stop declarative agent teams (.omp/teams/*.md)",
		acpDescription: "Manage agent teams",
		allowArgs: true,
		subcommands: [
			{ name: "start", description: "Spawn every member of a team", usage: "<name> [assignment]" },
			{ name: "list", description: "Show discovered team files" },
			{ name: "status", description: "Member handles + live status", usage: "[name]" },
			{ name: "stop", description: "Release a team's members", usage: "<name|all>" },
		],
		subcommandOptional: true,
		getTuiAutocompleteDescription: () => "Agent teams",
		handle: async (command, runtime: SlashCommandRuntime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "list" || verb === "status" || verb === "start" || verb === "stop") {
				if (!cfgTeamEnabled.get(runtime.settings)) {
					await runtime.output(
						teamRuntimeError(
							"agent teams are off. Enable the experimental gate with `team.enabled: true` (see /settings → Tasks → Teams).",
						),
					);
					return commandConsumed();
				}
			}
			if (!verb || verb === "list") {
				const teams = await discoverTeams(runtime.sessionManager.getCwd?.() ?? process.cwd());
				if (teams.length === 0) {
					await runtime.output(
						"No team files found. Create one at .omp/teams/<name>.md (see docs/agent-teams.md).",
					);
					return commandConsumed();
				}
				await runtime.output(
					teams
						.map(team => `${team.name} (${team.members.length} members, ${team.source}) — ${team.description}`)
						.join("\n"),
				);
				return commandConsumed();
			}
			if (verb === "start") {
				const [teamName, ...assignmentParts] = rest.trim().split(/\s+/).filter(Boolean);
				if (teamName === undefined) return usage(USAGE, runtime);
				const cwd = runtime.sessionManager.getCwd?.() ?? process.cwd();
				const teams = await discoverTeams(cwd);
				const team = teams.find(candidate => candidate.name === teamName);
				if (team === undefined) {
					await runtime.output(
						teamRuntimeError(
							`no team named "${teamName}". Discovered: ${teams.map(t => t.name).join(", ") || "none"}`,
						),
					);
					return commandConsumed();
				}
				const discovery = await discoverAgents(cwd, undefined, runtime.session.effectiveExtensionRoots);
				try {
					resolveTeamMembers(team, discovery.agents);
				} catch (error) {
					await runtime.output(teamRuntimeError(error instanceof Error ? error.message : String(error)));
					return commandConsumed();
				}
				const max = cfgTeamMaxTeammates.get(runtime.settings);
				const members = team.members.slice(0, Math.max(1, max));
				for (const member of members) {
					const agent = discovery.agents.find(candidate => candidate.name === member.agent)!;
					if (
						!agent.teamSystemPrompt &&
						(agent.team === false || agent.tools?.length === 0 || isReadOnlyAgent(agent))
					) {
						const reason = agent.team === false ? "team: false" : "read-only";
						await runtime.output(
							teamRuntimeError(
								`member "${member.handle}" (${member.agent}) is ${reason} and has no team prompt`,
							),
						);
						return commandConsumed();
					}
				}
				const handles = members.map(member => sanitizeTeamHandle(member.handle));
				if (new Set(handles).size !== handles.length) {
					await runtime.output(teamRuntimeError("team member handles collide after normalization"));
					return commandConsumed();
				}
				const skipped = team.members.length - members.length;
				const assignment = assignmentParts.length > 0 ? assignmentParts.join(" ") : undefined;
				await ensureTeamTasksFile(team);
				const lines: string[] = [];
				let failures = 0;
				const memberships = membershipsFor(runtime.session);
				let recorded = memberships.get(team.name);
				if (recorded === undefined) {
					recorded = new Map();
					memberships.set(team.name, recorded);
				}
				const toolSession = runtime.session.toolSession;
				if (!toolSession) {
					await runtime.output(
						teamRuntimeError("spawnSubagent is unavailable on a session without a tool session"),
					);
					return commandConsumed();
				}
				const ids = new Map<(typeof members)[number], string>();
				const newlyReserved = new Set<string>();
				for (const member of members) {
					const handle = sanitizeTeamHandle(member.handle);
					let entry = recorded.get(handle);
					// A member whose pending spawn failed is started again.
					if (!entry || entry.failure !== undefined) {
						// Registry-wide reservation: unique against live refs and every
						// other session's pending ids.
						entry = { id: await reserveStructuredSubagentId(toolSession, { label: handle }) };
						recorded.set(handle, entry);
						newlyReserved.add(handle);
					}
					ids.set(member, entry.id);
				}
				for (const member of members) {
					const handle = sanitizeTeamHandle(member.handle);
					const entry = recorded.get(handle)!;
					if (!newlyReserved.delete(handle)) {
						lines.push(`${handle} - already running as ${entry.id}`);
						continue;
					}
					try {
						const ref = await spawnSubagentForSession(runtime.session, {
							agent: member.agent,
							prompt: renderTeamMemberPrompt(team, assignment),
							context: renderTeamMemberContext({ ...team, members }, member, ids),
							handle,
							teamReservedId: entry.id,
							teamIrc: true,
							...(team.workspace !== undefined ? { teamWorkspace: team.workspace } : {}),
						});
						entry.id = ref.id;
						entry.ref = ref;
						lines.push(`${handle} → spawned (${ref.id})`);
					} catch (error) {
						if (error instanceof SpawnPendingError) {
							entry.id = error.agentId;
							entry.ref = AgentRegistry.global().get(entry.id);
							// The run keeps starting after the timeout: record whichever
							// outcome it reaches so status and stop never report a dead
							// member as still starting.
							error.registration.then(
								ref => {
									if (recorded.get(handle) === entry) entry.ref = ref;
								},
								(failure: unknown) => {
									if (recorded.get(handle) !== entry) return;
									entry.failure = failure instanceof Error ? failure.message : String(failure);
									releaseStructuredSubagentId(toolSession, entry.id);
								},
							);
							lines.push(`${handle} → pending (${error.agentId}); the run is still starting`);
							continue;
						}
						recorded.delete(handle);
						releaseStructuredSubagentId(toolSession, entry.id);
						failures += 1;
						lines.push(`${handle} → FAILED: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				if (skipped > 0) {
					lines.push(`team.maxTeammates=${max}: ${skipped} member(s) skipped — raise the setting to spawn them.`);
				}
				lines.push(
					failures === 0
						? "Team is live: message members with write agent://<handle>; watch them in the Agent Hub."
						: `${failures} member(s) failed to spawn; the spawned ones keep running.`,
				);
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			}
			if (verb === "status") {
				const [teamName] = rest.trim().split(/\s+/).filter(Boolean);
				const cwd = runtime.sessionManager.getCwd?.() ?? process.cwd();
				const teams = await discoverTeams(cwd);
				const selected = teamName !== undefined ? teams.filter(team => team.name === teamName) : teams;
				if (selected.length === 0) {
					await runtime.output(teamRuntimeError("no matching team files"));
					return commandConsumed();
				}
				const registry = AgentRegistry.global();
				const report = await teamReport(runtime.session, selected, (team, recorded) =>
					team.members.map(member => {
						const handle = sanitizeTeamHandle(member.handle);
						const entry = recorded?.get(handle);
						const ref = entry?.ref && registry.get(entry.id) === entry.ref ? entry.ref : undefined;
						const status = ref
							? `${ref.status} (${ref.kind})`
							: entry?.failure !== undefined
								? `failed: ${entry.failure}`
								: entry && !entry.ref
									? "pending"
									: "not spawned";
						return `  ${entry?.id ?? handle} - ${status} - agent: ${member.agent}`;
					}),
				);
				await runtime.output(report);
				return commandConsumed();
			}
			if (verb === "stop") {
				const [target] = rest.trim().split(/\s+/).filter(Boolean);
				if (target === undefined) return usage(USAGE, runtime);
				const cwd = runtime.sessionManager.getCwd?.() ?? process.cwd();
				const teams = await discoverTeams(cwd);
				const selected = target === "all" ? teams : teams.filter(team => team.name === target);
				if (selected.length === 0) {
					await runtime.output(teamRuntimeError(`no team named "${target}"`));
					return commandConsumed();
				}
				const registry = AgentRegistry.global();
				const lifecycle = AgentLifecycleManager.global();
				const report = await teamReport(runtime.session, selected, async (team, recorded) => {
					if (recorded === undefined || recorded.size === 0) {
						return ["  nothing to stop (team not started in this session)"];
					}
					const lines: string[] = [];
					for (const [handle, entry] of recorded) {
						if (entry.failure !== undefined) {
							lines.push(`  ${handle} - failed before registering: ${entry.failure}`);
							recorded.delete(handle);
							continue;
						}
						const ref = entry.ref;
						if (!ref) {
							lines.push(`  ${handle} - pending (${entry.id}); retry stop after registration`);
							continue;
						}
						if (registry.get(entry.id) !== ref) {
							lines.push(`  ${handle} - no longer a team member`);
							recorded.delete(handle);
							continue;
						}
						const released = await lifecycle.release(entry.id, ref, { tombstone: true });
						lines.push(
							`  ${handle} — ${released ? "released (transcripts kept; revive available)" : "release refused"}`,
						);
						if (released) recorded.delete(handle);
					}
					if (recorded.size === 0) membershipsFor(runtime.session).delete(team.name);
					return lines;
				});
				await runtime.output(report);
				return commandConsumed();
			}
			return usage(USAGE, runtime);
		},
	},
];
