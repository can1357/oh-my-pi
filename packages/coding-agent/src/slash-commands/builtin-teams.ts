/**
 * `/team` — start, list, status, and stop declarative agent teams
 * (`.omp/teams/*.md`). Members spawn through the shared subagent seam with
 * stable handles as registry ids; they see each other via `agent://<handle>`
 * and share the team workspace.
 */
import { AgentRegistry } from "../registry/agent-registry";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { discoverAgents } from "../task/discovery";
import {
	discoverTeams,
	renderTeamMemberContext,
	renderTeamMemberPrompt,
	resolveTeamMembers,
	sanitizeTeamHandle,
} from "../task/teams";
import { spawnSubagentForSession } from "../task/spawn-subagent";
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
				const skipped = team.members.length - members.length;
				const assignment = assignmentParts.length > 0 ? assignmentParts.join(" ") : undefined;
				const lines: string[] = [];
				let failures = 0;
				for (const member of members) {
					try {
						const ref = await spawnSubagentForSession(runtime.session, {
							agent: member.agent,
							prompt: renderTeamMemberPrompt(team, assignment),
							context: renderTeamMemberContext(team, member),
							handle: sanitizeTeamHandle(member.handle),
							...(team.workspace !== undefined ? { teamWorkspace: team.workspace } : {}),
						});
						lines.push(`${member.handle} → spawned (${ref.id})`);
					} catch (error) {
						failures += 1;
						lines.push(`${member.handle} → FAILED: ${error instanceof Error ? error.message : String(error)}`);
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
				const lines: string[] = [];
				for (const team of selected) {
					lines.push(`${team.name}:`);
					for (const member of team.members) {
						const handle = sanitizeTeamHandle(member.handle);
						const ref = registry.get(handle);
						lines.push(
							`  ${handle} — ${ref ? `${ref.status} (${ref.kind})` : "not spawned"} — agent: ${member.agent}`,
						);
					}
				}
				await runtime.output(lines.join("\n"));
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
				const lines: string[] = [];
				for (const team of selected) {
					lines.push(`${team.name}:`);
					for (const member of team.members) {
						const handle = sanitizeTeamHandle(member.handle);
						const ref = registry.get(handle);
						if (ref === undefined) {
							lines.push(`  ${handle} — not spawned`);
							continue;
						}
						const released = await lifecycle.release(handle, ref, { tombstone: true });
						lines.push(
							`  ${handle} — ${released ? "released (transcripts kept; revive available)" : "release refused"}`,
						);
					}
				}
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			}
			return usage(USAGE, runtime);
		},
	},
];
