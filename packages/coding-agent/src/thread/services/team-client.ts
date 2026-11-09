import { AgentRegistry } from "../../registry/agent-registry";
import { teamRuntime, type TeamIdentity } from "../../task/team-runtime";
import type { TeamDefinition } from "../../task/teams";
import { findLocalSession } from "../session-directory";
import type { TeamClient, TeamCommandMember } from "./team-protocol";

function sameMember(current: TeamCommandMember | undefined, expected: TeamCommandMember | null): boolean {
	if (!current || !expected) return !current && !expected;
	return (
		current.reservation === expected.reservation &&
		current.id === expected.id &&
		current.ref?.generation === expected.ref?.generation &&
		current.failure === expected.failure
	);
}

/** A per-peer endpoint resolves keys only against that peer's session bridge. */
export class TeamEndpoint implements TeamClient {
	constructor(readonly bridge?: { session(key: string): object | undefined }) {}
	#session(key: string): object {
		const session = this.bridge ? this.bridge.session(key) : findLocalSession(key);
		if (!session) throw new Error("Team caller session is not registered on this thread");
		return session;
	}
	async start(key: string, team: TeamDefinition) {
		const { generation, leadId } = await teamRuntime.start(this.#session(key), team);
		return { generation, leadId };
	}
	async members(key: string, team: string) {
		const session = this.#session(key);
		const identity = teamRuntime.identity(session, team);
		const members = teamRuntime.members(session, team);
		if (!identity || !members || !teamRuntime.isCurrentLead(session, team, identity.generation)) return undefined;
		return {
			generation: identity.generation,
			members: Array.from(members, ([handle, entry]) => [handle, { ...entry }] as [string, TeamCommandMember]),
		};
	}
	async putMember(
		key: string,
		team: string,
		generation: number,
		handle: string,
		expected: TeamCommandMember | null,
		entry: TeamCommandMember,
	) {
		const session = this.#session(key);
		if (!teamRuntime.isCurrentLead(session, team, generation)) return false;
		const members = teamRuntime.members(session, team);
		if (!members) return false;
		const current = members.get(handle) as TeamCommandMember | undefined;
		if (!sameMember(current, expected)) return false;
		const sameRef =
			entry.ref &&
			current?.ref &&
			entry.ref.id === current.ref.id &&
			entry.ref.generation === current.ref.generation;
		if (entry.ref && (entry.ref.id !== entry.id || (!sameRef && AgentRegistry.global().get(entry.id) !== entry.ref)))
			return false;
		members.set(handle, { ...entry, ...(sameRef ? { ref: current.ref } : {}) });
		return true;
	}
	async deleteMember(key: string, team: string, generation: number, handle: string, expected: TeamCommandMember) {
		const session = this.#session(key);
		if (!teamRuntime.isCurrentLead(session, team, generation)) return false;
		const members = teamRuntime.members(session, team);
		const current = members?.get(handle) as TeamCommandMember | undefined;
		if (!members || !sameMember(current, expected)) return false;
		return members.delete(handle);
	}
	async stop(key: string, team: string, generation: number) {
		const session = this.#session(key);
		if (!teamRuntime.isCurrentLead(session, team, generation) || teamRuntime.members(session, team)?.size !== 0)
			return false;
		await teamRuntime.stop(session, team);
		return true;
	}
	async leadIdentity(key: string, team: string) {
		return teamRuntime.identity(this.#session(key), team);
	}
	readTasks(key: string, identity: TeamIdentity) {
		return teamRuntime.readTasks(this.#session(key), identity);
	}
	addTask(key: string, identity: TeamIdentity, title: string) {
		return teamRuntime.addTask(this.#session(key), identity, title);
	}
	claim(key: string, identity: TeamIdentity, id: string) {
		return teamRuntime.claim(this.#session(key), identity, id);
	}
	releaseTask(key: string, identity: TeamIdentity, id: string) {
		return teamRuntime.releaseTask(this.#session(key), identity, id);
	}
	completeTask(key: string, identity: TeamIdentity, id: string, note: string) {
		return teamRuntime.completeTask(this.#session(key), identity, id, note);
	}
}

let client: TeamClient = new TeamEndpoint();
export function getTeamClient(): TeamClient {
	return client;
}
export function installTeamClient(remote: TeamClient): void {
	client = remote;
}
