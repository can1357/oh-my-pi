import type { TeamClaimResult, TeamTask } from "../../task/team-ledger";
import type { StartedTeam, TeamIdentity, TeamMembership } from "../../task/team-runtime";
import type { TeamDefinition } from "../../task/teams";
import type { RpcMethod } from "../rpc";

export const TEAM_SERVICE_KIND = "team-runtime";
export type TeamCommandMember = TeamMembership & { reservation: string };

export interface TeamMembersSnapshot {
	generation: number;
	members: Array<[string, TeamCommandMember]>;
}

export type TeamProtocol = {
	start: RpcMethod<[sessionKey: string, team: TeamDefinition], Pick<StartedTeam, "generation" | "leadId">>;
	members: RpcMethod<[sessionKey: string, team: string], TeamMembersSnapshot | undefined>;
	putMember: RpcMethod<
		[
			sessionKey: string,
			team: string,
			generation: number,
			handle: string,
			expected: TeamCommandMember | null,
			entry: TeamCommandMember,
		],
		boolean
	>;
	deleteMember: RpcMethod<
		[sessionKey: string, team: string, generation: number, handle: string, expected: TeamCommandMember],
		boolean
	>;
	stop: RpcMethod<[sessionKey: string, team: string, generation: number], boolean>;
	leadIdentity: RpcMethod<[sessionKey: string, team: string], TeamIdentity | undefined>;
	readTasks: RpcMethod<[sessionKey: string, identity: TeamIdentity], TeamTask[]>;
	addTask: RpcMethod<[sessionKey: string, identity: TeamIdentity, title: string], TeamTask>;
	claim: RpcMethod<[sessionKey: string, identity: TeamIdentity, id: string], TeamClaimResult>;
	releaseTask: RpcMethod<[sessionKey: string, identity: TeamIdentity, id: string], TeamTask>;
	completeTask: RpcMethod<[sessionKey: string, identity: TeamIdentity, id: string, note: string], TeamTask>;
};

export interface TeamClient {
	start(sessionKey: string, team: TeamDefinition): Promise<Pick<StartedTeam, "generation" | "leadId">>;
	members(sessionKey: string, team: string): Promise<TeamMembersSnapshot | undefined>;
	putMember(
		sessionKey: string,
		team: string,
		generation: number,
		handle: string,
		expected: TeamCommandMember | null,
		entry: TeamCommandMember,
	): Promise<boolean>;
	deleteMember(
		sessionKey: string,
		team: string,
		generation: number,
		handle: string,
		expected: TeamCommandMember,
	): Promise<boolean>;
	stop(sessionKey: string, team: string, generation: number): Promise<boolean>;
	readTasks(sessionKey: string, identity: TeamIdentity): Promise<TeamTask[]>;
	leadIdentity(sessionKey: string, team: string): Promise<TeamIdentity | undefined>;
	addTask(sessionKey: string, identity: TeamIdentity, title: string): Promise<TeamTask>;
	claim(sessionKey: string, identity: TeamIdentity, id: string): Promise<TeamClaimResult>;
	releaseTask(sessionKey: string, identity: TeamIdentity, id: string): Promise<TeamTask>;
	completeTask(sessionKey: string, identity: TeamIdentity, id: string, note: string): Promise<TeamTask>;
}
