/**
 * `/team` — start, list, status, and stop declarative agent teams
 * (`.omp/teams/*.md`). Members spawn through the shared subagent seam with
 * stable handles as registry ids; they see each other via `agent://<handle>`
 * and share the team workspace.
 */
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "../registry/agent-registry";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { discoverAgents } from "../task/discovery";
import { isReadOnlyAgent } from "../task/read-only-policy";
import {
	discoverTeams,
	renderTeamMemberContext,
	renderTeamMemberPrompt,
	resolveTeamMembers,
	sanitizeTeamHandle,
	type TeamDefinition,
} from "../task/teams";
import { SpawnPendingError, spawnSubagentForSession } from "../task/spawn-subagent";
import { teamRuntime } from "../task/team-runtime";
import { getTeamClient } from "../thread/services/team-client";
import type { TeamCommandMember, TeamMembersSnapshot } from "../thread/services/team-protocol";
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

/** Test-only: clear recorded team membership between cases. */
export function resetTeamMembershipsForTests(): void {
	teamRuntime.resetForTests();
}

/** One `<team>:` block per selected team, filled from that team's members recorded in this session. */
async function teamReport(
	key: string,
	selected: readonly TeamDefinition[],
	describe: (team: TeamDefinition, snapshot: TeamMembersSnapshot | undefined) => string[] | Promise<string[]>,
): Promise<string> {
	const lines: string[] = [];
	for (const team of selected) {
		lines.push(`${team.name}:`, ...(await describe(team, await getTeamClient().members(key, team.name))));
	}
	return lines.join("\n");
}

/** Update only the original reservation, even if a registration callback arrives late. */
async function updateMember(
	key: string,
	team: string,
	generation: number,
	handle: string,
	original: TeamCommandMember,
	update: (entry: TeamCommandMember) => TeamCommandMember | undefined,
): Promise<boolean> {
	const client = getTeamClient();
	for (;;) {
		const snapshot = await client.members(key, team);
		if (snapshot?.generation !== generation) return false;
		const current = snapshot.members.find(([name]) => name === handle)?.[1];
		if (!current || current.reservation !== original.reservation || current.id !== original.id) return false;
		const next = update(current);
		if (
			next?.ref &&
			(next.ref.id !== next.id || (next.ref !== current.ref && AgentRegistry.global().get(next.id) !== next.ref))
		)
			return false;
		const changed = next
			? await client.putMember(key, team, generation, handle, current, next)
			: await client.deleteMember(key, team, generation, handle, current);
		if (changed) return true;
	}
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
					if (agent.teamPromptError !== undefined) {
						await runtime.output(
							teamRuntimeError(`member "${member.handle}" (${member.agent}): ${agent.teamPromptError}`),
						);
						return commandConsumed();
					}
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
				const toolSession = runtime.session.toolSession;
				if (!toolSession) {
					await runtime.output(
						teamRuntimeError("spawnSubagent is unavailable on a session without a tool session"),
					);
					return commandConsumed();
				}
				const key = runtime.session.instanceKey;
				const client = getTeamClient();
				let started: { generation: number; leadId: string };
				try {
					started = await client.start(key, team);
				} catch (error) {
					await runtime.output(teamRuntimeError(error instanceof Error ? error.message : String(error)));
					return commandConsumed();
				}
				const lines: string[] = [];
				let failures = 0;
				const recorded = new Map<string, TeamCommandMember>();
				const ids = new Map<(typeof members)[number], string>();
				const newlyReserved = new Set<string>();
				for (const member of members) {
					const handle = sanitizeTeamHandle(member.handle);
					for (;;) {
						const snapshot = await client.members(key, team.name);
						if (snapshot?.generation !== started.generation)
							throw new Error("Team generation is no longer active");
						const current = snapshot.members.find(([name]) => name === handle)?.[1];
						if (current && current.failure === undefined) {
							recorded.set(handle, current);
							ids.set(member, current.id);
							break;
						}
						const entry: TeamCommandMember = {
							id: await reserveStructuredSubagentId(toolSession, { label: handle }),
							reservation: randomUUID(),
						};
						if (await client.putMember(key, team.name, started.generation, handle, current ?? null, entry)) {
							recorded.set(handle, entry);
							ids.set(member, entry.id);
							newlyReserved.add(handle);
							break;
						}
						releaseStructuredSubagentId(toolSession, entry.id);
					}
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
							teamIdentity: { team: team.name, generation: started.generation, memberId: entry.id },
							teamIrc: true,
							...(team.workspace !== undefined ? { teamWorkspace: team.workspace } : {}),
						});
						await updateMember(key, team.name, started.generation, handle, entry, current => ({
							...current,
							id: ref.id,
							ref,
						}));
						lines.push(`${handle} → spawned (${ref.id})`);
					} catch (error) {
						if (error instanceof SpawnPendingError) {
							if (error.agentId !== entry.id) {
								const updated = await updateMember(
									key,
									team.name,
									started.generation,
									handle,
									entry,
									current => ({
										...current,
										id: error.agentId,
									}),
								);
								if (updated) entry.id = error.agentId;
							}
							const pendingRef = AgentRegistry.global().get(error.agentId);
							if (pendingRef) {
								await updateMember(key, team.name, started.generation, handle, entry, current => ({
									...current,
									ref: pendingRef,
								}));
							}
							// Registration can finish after the command returns.
							void error.registration
								.then(
									async ref => {
										await updateMember(key, team.name, started.generation, handle, entry, current => ({
											...current,
											ref,
										}));
									},
									async (failure: unknown) => {
										const changed = await updateMember(
											key,
											team.name,
											started.generation,
											handle,
											entry,
											current => ({
												...current,
												failure: failure instanceof Error ? failure.message : String(failure),
											}),
										);
										if (changed) releaseStructuredSubagentId(toolSession, entry.id);
									},
								)
								.catch(error =>
									runtime.output(teamRuntimeError(error instanceof Error ? error.message : String(error))),
								);
							lines.push(`${handle} → pending (${error.agentId}); the run is still starting`);
							continue;
						}
						await updateMember(key, team.name, started.generation, handle, entry, () => undefined);
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
				const report = await teamReport(runtime.session.instanceKey, selected, (team, snapshot) =>
					team.members.map(member => {
						const handle = sanitizeTeamHandle(member.handle);
						const entry = snapshot?.members.find(([name]) => name === handle)?.[1];
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
				const key = runtime.session.instanceKey;
				const client = getTeamClient();
				const report = await teamReport(key, selected, async (team, snapshot) => {
					if (snapshot === undefined) return ["  nothing to stop (team not started in this session)"];
					if (snapshot.members.length === 0) {
						const stopped = await client.stop(key, team.name, snapshot.generation);
						return [stopped ? "  team stopped (no active members)" : "  team changed; retry stop"];
					}
					const lines: string[] = [];
					for (const [handle, entry] of snapshot.members) {
						if (entry.failure !== undefined) {
							lines.push(`  ${handle} - failed before registering: ${entry.failure}`);
							await client.deleteMember(key, team.name, snapshot.generation, handle, entry);
							continue;
						}
						const ref = entry.ref;
						if (!ref) {
							lines.push(`  ${handle} - pending (${entry.id}); retry stop after registration`);
							continue;
						}
						if (registry.get(entry.id) !== ref) {
							lines.push(`  ${handle} - no longer a team member`);
							await client.deleteMember(key, team.name, snapshot.generation, handle, entry);
							continue;
						}
						const released = await lifecycle.release(entry.id, ref, { tombstone: true });
						lines.push(
							`  ${handle} — ${released ? "released (transcripts kept; revive available)" : "release refused"}`,
						);
						if (released) await client.deleteMember(key, team.name, snapshot.generation, handle, entry);
					}
					await client.stop(key, team.name, snapshot.generation);
					return lines;
				});
				await runtime.output(report);
				return commandConsumed();
			}
			return usage(USAGE, runtime);
		},
	},
];
