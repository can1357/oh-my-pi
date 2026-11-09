/**
 * `/team` — start, list, status, and stop declarative agent teams
 * (`.omp/teams/*.md`). Members spawn through the shared subagent seam with
 * stable handles as registry ids; they see each other via `agent://<handle>`
 * and share the team workspace.
 */
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "../registry/agent-registry";
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
import { cfgTeamEnabled, cfgTeamMaxTeammates, cfgTeamStopAckTimeoutMs } from "../task/settings";
import { commandConsumed, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

const USAGE = [
	"Usage:",
	"  /team start <name> [assignment]    spawn every member of team <name>",
	"  /team list                         show discovered team files",
	"  /team status [name]                member handles + live registry status",
	"  /team stop [--force] <name|handle|all>  request stop (or force release)",
	"  /team approve <handle> [--rev N]   approve a submitted member plan",
	"  /team reject <handle> [--rev N] <reason>  reject a plan and require resubmission",
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
	for (let attempt = 0; attempt < 16; attempt++) {
		const snapshot = await client.members(key, team);
		if (snapshot?.generation !== generation) return false;
		const current = snapshot.members.find(([name]) => name === handle)?.[1];
		if (!current || current.reservation !== original.reservation || current.id !== original.id) return false;
		const next = update(current);
		const registered = next?.ref && AgentRegistry.global().get(next.id);
		if (next?.ref && (!registered || next.ref.id !== next.id || next.ref.generation !== registered.generation))
			return false;
		const changed = next
			? await client.putMember(key, team, generation, handle, current, next)
			: await client.deleteMember(key, team, generation, handle, current);
		if (changed) return true;
		const refreshed = await client.members(key, team);
		const latest = refreshed?.members.find(([name]) => name === handle)?.[1];
		if (
			refreshed?.generation === snapshot.generation &&
			latest?.id === current.id &&
			latest?.reservation === current.reservation &&
			latest?.failure === current.failure &&
			latest?.ref?.id === current.ref?.id &&
			latest?.ref?.generation === current.ref?.generation
		)
			return false;
	}
	return false;
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
			{
				name: "stop",
				description: "Request members to stop, or force release",
				usage: "[--force] <name|handle|all>",
			},
			{ name: "approve", description: "Approve a submitted member plan", usage: "<handle> [--rev N]" },
			{ name: "reject", description: "Reject a plan and request revision", usage: "<handle> [--rev N] <reason>" },
		],
		subcommandOptional: true,
		getTuiAutocompleteDescription: () => "Agent teams",
		handle: async (command, runtime: SlashCommandRuntime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || ["list", "status", "start", "stop", "approve", "reject"].includes(verb)) {
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
			if (verb === "approve" || verb === "reject") {
				const words = rest.trim().split(/\s+/).filter(Boolean);
				const handle = words.shift();
				// A `--rev` token in handle position is a usage error, not a handle:
				// `/team approve --rev 1` must reach usage, not an unknown-member error.
				if (handle === "--rev") return usage(USAGE, runtime);
				let revision: number | undefined;
				if (words[0] === "--rev") {
					words.shift();
					const value = words.shift();
					if (!value || !/^[1-9][0-9]*$/.test(value)) return usage(USAGE, runtime);
					revision = Number(value);
				}
				const reason = words.join(" ");
				if (!handle || (verb === "approve" ? reason !== "" : reason === "")) return usage(USAGE, runtime);
				if (words.includes("--rev")) return usage(USAGE, runtime);
				try {
					const client = getTeamClient();
					const key = runtime.session.instanceKey;
					if (verb === "approve") await client.approve(key, handle, revision);
					else await client.reject(key, handle, reason, revision);
					await runtime.output(`${handle}: plan ${verb === "approve" ? "approved" : "rejected"}`);
				} catch (error) {
					await runtime.output(teamRuntimeError(error instanceof Error ? error.message : String(error)));
				}
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
				const releaseReservations = async () => {
					for (const reservedHandle of newlyReserved)
						releaseStructuredSubagentId(toolSession, recorded.get(reservedHandle)!.id);
					for (const reservedHandle of newlyReserved)
						await client.deleteMember(
							key,
							team.name,
							started.generation,
							reservedHandle,
							recorded.get(reservedHandle)!,
						);
				};
				for (const member of members) {
					const handle = sanitizeTeamHandle(member.handle);
					let conflicts = 0;
					for (;;) {
						const snapshot = await client.members(key, team.name);
						if (snapshot?.generation !== started.generation) {
							await releaseReservations();
							await runtime.output(teamRuntimeError("Team generation is no longer active"));
							return commandConsumed();
						}
						const current = snapshot.members.find(([name]) => name === handle)?.[1];
						if (current && current.failure === undefined) {
							recorded.set(handle, current);
							ids.set(member, current.id);
							break;
						}
						if (conflicts >= 10) {
							await releaseReservations();
							await runtime.output(
								teamRuntimeError(`could not reserve member "${handle}" due to repeated conflicts`),
							);
							return commandConsumed();
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
						conflicts += 1;
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
							teamIdentity: await client.memberIdentity(key, team.name, started.generation, handle),
							teamIrc: true,
							...(team.workspace !== undefined ? { teamWorkspace: team.workspace } : {}),
						});
						await client.resolvePendingStop(key, team.name, started.generation, handle, entry, ref);
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
							// The registration promise, not a same-ID registry lookup, identifies the spawned ref.
							// Registration can finish after the command returns.
							void error.registration
								.then(
									async ref => {
										await client.resolvePendingStop(key, team.name, started.generation, handle, entry, ref);
									},
									async (failure: unknown) => {
										const message = failure instanceof Error ? failure.message : String(failure);
										const changed = await client.resolvePendingStop(
											key,
											team.name,
											started.generation,
											handle,
											entry,
											undefined,
											message,
										);
										if (changed) {
											releaseStructuredSubagentId(toolSession, entry.id);
											await runtime.output(teamRuntimeError(`${handle} failed to register: ${message}`));
										}
									},
								)
								.catch(error =>
									runtime.output(teamRuntimeError(error instanceof Error ? error.message : String(error))),
								);
							lines.push(`${handle} → pending (${error.agentId}); the run is still starting`);
							continue;
						}
						const message = error instanceof Error ? error.message : String(error);
						// The spawn ended without registering a ref: resolve any pending stop
						// through the same failure branch as a pending registration, so the
						// member is marked failed, the intent clears, and the lead is notified
						// instead of the stop waiting out the ack timeout.
						const resolved = await client.resolvePendingStop(
							key,
							team.name,
							started.generation,
							handle,
							entry,
							undefined,
							message,
						);
						if (!resolved) {
							// The member registered after all, was replaced, or the generation
							// ended: drop the stale membership rather than marking it failed.
							await updateMember(key, team.name, started.generation, handle, entry, () => undefined);
						}
						releaseStructuredSubagentId(toolSession, entry.id);
						failures += 1;
						lines.push(`${handle} → FAILED: ${message}`);
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
						const registered = entry?.ref && registry.get(entry.id);
						const ref =
							registered && registered.id === entry?.ref?.id && registered.generation === entry.ref.generation
								? registered
								: undefined;
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
				const args = rest.trim().split(/\s+/).filter(Boolean);
				const force = args[0] === "--force";
				if (force) args.shift();
				if (args.length !== 1 || args[0]!.startsWith("--")) return usage(USAGE, runtime);
				const target = args[0]!;
				const key = runtime.session.instanceKey;
				const client = getTeamClient();
				const names = await client.listTeams(key);
				const snapshots = await Promise.all(
					names.map(async name => ({ name, snapshot: await client.members(key, name) })),
				);
				const live = snapshots.filter(item => item.snapshot !== undefined);
				const wholeTeams = target === "all" ? live : live.filter(item => item.name === target);
				const matchingMembers =
					target === "all"
						? []
						: live.flatMap(item =>
								item
									.snapshot!.members.filter(([handle, member]) => handle === target || member.id === target)
									.map(([handle]) => ({ ...item, handle })),
							);
				if (
					matchingMembers.length > 1 ||
					(wholeTeams.length > 0 && matchingMembers.some(item => item.name !== target))
				) {
					await runtime.output(teamRuntimeError(`ambiguous member handle "${target}"`));
					return commandConsumed();
				}
				const selected = wholeTeams.length > 0 ? wholeTeams : matchingMembers;
				if (selected.length === 0) {
					await runtime.output(teamRuntimeError(`no live team or member named "${target}"`));
					return commandConsumed();
				}
				const lines: string[] = [];
				for (const item of selected) {
					const snapshot = item.snapshot!;
					lines.push(`${item.name}:`);
					const handle = "handle" in item ? item.handle : undefined;
					const members =
						handle === undefined ? snapshot.members : snapshot.members.filter(([name]) => name === handle);
					for (const [memberHandle, entry] of members) {
						if (entry.failure !== undefined) {
							lines.push(`  ${memberHandle} - failed before registering: ${entry.failure}`);
							await client.deleteMember(key, item.name, snapshot.generation, memberHandle, entry);
							continue;
						}
						try {
							const result = await client.requestStop(
								key,
								item.name,
								snapshot.generation,
								memberHandle,
								entry,
								force,
								cfgTeamStopAckTimeoutMs.get(runtime.settings),
								handle === undefined,
							);
							lines.push(`  ${memberHandle} - ${result}`);
						} catch (error) {
							lines.push(`  ${memberHandle} - ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					if (handle === undefined) {
						const current = await client.members(key, item.name);
						if (current?.generation === snapshot.generation && current.members.length === 0) {
							await client.stop(key, item.name, snapshot.generation);
							if (members.length === 0) lines.push("  team stopped (no active members)");
						}
					}
				}
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			}
			return usage(USAGE, runtime);
		},
	},
];
