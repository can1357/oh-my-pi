import type { TeamIdentity } from "../../task/team-runtime";
import type { AgentRef } from "../../registry/agent-registry";
import type { TeamDefinition } from "../../task/teams";
import type { RemoteObject } from "../rpc";
import type { TeamClient, TeamCommandMember, TeamProtocol } from "./team-protocol";

export class RemoteTeamClient implements TeamClient {
	constructor(readonly remote: RemoteObject<TeamProtocol>) {}
	listTeams(key: string) {
		return this.remote.call("listTeams", key);
	}
	start(key: string, team: TeamDefinition) {
		return this.remote.call("start", key, team);
	}
	members(key: string, team: string) {
		return this.remote.call("members", key, team);
	}
	putMember(
		key: string,
		team: string,
		generation: number,
		handle: string,
		expected: TeamCommandMember | null,
		entry: TeamCommandMember,
	) {
		return this.remote.call("putMember", key, team, generation, handle, expected, entry);
	}
	deleteMember(key: string, team: string, generation: number, handle: string, expected: TeamCommandMember) {
		return this.remote.call("deleteMember", key, team, generation, handle, expected);
	}
	stop(key: string, team: string, generation: number) {
		return this.remote.call("stop", key, team, generation);
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
		return this.remote.call("requestStop", key, team, generation, handle, expected, force, timeoutMs, wholeTeam);
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
		return this.remote.call("resolvePendingStop", key, team, generation, handle, expected, ref, failure);
	}
	leadIdentity(key: string, team: string) {
		return this.remote.call("leadIdentity", key, team);
	}
	memberIdentity(key: string, team: string, generation: number, handle: string) {
		return this.remote.call("memberIdentity", key, team, generation, handle);
	}
	planPending(key: string, identity: TeamIdentity) {
		return this.remote.call("planPending", key, identity);
	}
	submitPlan(key: string, identity: TeamIdentity, text: string) {
		return this.remote.call("submitPlan", key, identity, text);
	}
	approve(key: string, handle: string, revision?: number) {
		return this.remote.call("approve", key, handle, revision);
	}
	reject(key: string, handle: string, reason: string, revision?: number) {
		return this.remote.call("reject", key, handle, reason, revision);
	}
	respondStop(key: string, identity: TeamIdentity, requestId: string, body: string) {
		return this.remote.call("respondStop", key, identity, requestId, body);
	}
	readTasks(key: string, identity: TeamIdentity) {
		return this.remote.call("readTasks", key, identity);
	}
	addTask(key: string, identity: TeamIdentity, title: string) {
		return this.remote.call("addTask", key, identity, title);
	}
	claim(key: string, identity: TeamIdentity, id: string) {
		return this.remote.call("claim", key, identity, id);
	}
	releaseTask(key: string, identity: TeamIdentity, id: string) {
		return this.remote.call("releaseTask", key, identity, id);
	}
	completeTask(key: string, identity: TeamIdentity, id: string, note: string) {
		return this.remote.call("completeTask", key, identity, id, note);
	}
}
