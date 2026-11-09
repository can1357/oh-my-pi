import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentRef } from "../../registry/agent-registry";
import { isMainThread } from "node:worker_threads";
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
	async listTeams(key: string) {
		return teamRuntime.listTeams(this.#session(key));
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
		const ref = entry.ref && AgentRegistry.global().get(entry.id);
		if (entry.ref && (!ref || entry.ref.id !== entry.id || ref.generation !== entry.ref.generation)) return false;
		members.set(handle, { ...entry, ...(ref ? { ref } : {}) });
		teamRuntime.memberUpdated(session, team, generation, handle, current, entry);
		return true;
	}
	async deleteMember(key: string, team: string, generation: number, handle: string, expected: TeamCommandMember) {
		const session = this.#session(key);
		if (!teamRuntime.isCurrentLead(session, team, generation)) return false;
		const members = teamRuntime.members(session, team);
		const current = members?.get(handle) as TeamCommandMember | undefined;
		if (!members || !sameMember(current, expected)) return false;
		members.delete(handle);
		teamRuntime.memberUpdated(session, team, generation, handle, current, undefined);
		return true;
	}
	async stop(key: string, team: string, generation: number) {
		const session = this.#session(key);
		if (!teamRuntime.isCurrentLead(session, team, generation) || teamRuntime.members(session, team)?.size !== 0)
			return false;
		await teamRuntime.stop(session, team);
		return true;
	}
	requestStop(
		key: string,
		team: string,
		generation: number,
		handle: string,
		expected: TeamCommandMember,
		force: boolean,
		timeoutMs: number,
		wholeTeam = false,
	) {
		return teamRuntime.requestStop(
			this.#session(key),
			team,
			generation,
			handle,
			expected,
			force,
			timeoutMs,
			wholeTeam,
		);
	}
	resolvePendingStop(
		key: string,
		team: string,
		generation: number,
		handle: string,
		expected: TeamCommandMember,
		ref?: AgentRef,
		failure?: string,
	) {
		return teamRuntime.resolvePendingStop(this.#session(key), team, generation, handle, expected, ref, failure);
	}
	async leadIdentity(key: string, team: string) {
		return teamRuntime.identity(this.#session(key), team);
	}
	async memberIdentity(key: string, team: string, generation: number, handle: string) {
		return teamRuntime.memberIdentity(this.#session(key), team, generation, handle);
	}
	planPending(key: string, identity: TeamIdentity) {
		return teamRuntime.planPending(this.#session(key), identity);
	}
	submitPlan(key: string, identity: TeamIdentity, text: string) {
		return teamRuntime.submitPlan(this.#session(key), identity, text);
	}
	approve(key: string, handle: string, revision?: number) {
		return teamRuntime.approve(this.#session(key), handle, revision);
	}
	reject(key: string, handle: string, reason: string, revision?: number) {
		return teamRuntime.reject(this.#session(key), handle, reason, revision);
	}
	respondStop(key: string, identity: TeamIdentity, requestId: string, body: string) {
		return teamRuntime.respondStop(this.#session(key), identity, requestId, body);
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

let client: TeamClient | undefined = isMainThread ? new TeamEndpoint() : undefined;
export function getTeamClient(): TeamClient {
	if (!client) throw new Error("Team client has not been installed in this worker");
	return client;
}
export function installTeamClient(remote: TeamClient): void {
	client = remote;
}
