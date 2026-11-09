import type { TeamClaimResult, TeamTask } from "../../task/team-ledger";
import type { AgentRef } from "../../registry/agent-registry";
import type { StartedTeam, TeamIdentity, TeamMembership, TeamStopResponse } from "../../task/team-runtime";
import type { TeamDefinition } from "../../task/teams";
import type { RpcMethod } from "../rpc";

export const TEAM_SERVICE_KIND = "team-runtime";
export type TeamCommandMember = TeamMembership & { reservation: string };

export interface TeamMembersSnapshot {
	generation: number;
	members: Array<[string, TeamCommandMember]>;
}

export type TeamProtocol = {
	listTeams: RpcMethod<[sessionKey: string], string[]>;
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
	requestStop: RpcMethod<
		[
			sessionKey: string,
			team: string,
			generation: number,
			handle: string,
			expected: TeamCommandMember,
			force: boolean,
			timeoutMs: number,
			wholeTeam?: boolean,
		],
		string
	>;
	resolvePendingStop: RpcMethod<
		[
			sessionKey: string,
			team: string,
			generation: number,
			handle: string,
			expected: TeamCommandMember,
			ref?: AgentRef,
			failure?: string,
		],
		boolean
	>;
	leadIdentity: RpcMethod<[sessionKey: string, team: string], TeamIdentity | undefined>;
	memberIdentity: RpcMethod<[sessionKey: string, team: string, generation: number, handle: string], TeamIdentity>;
	planPending: RpcMethod<[sessionKey: string, identity: TeamIdentity], boolean>;
	submitPlan: RpcMethod<[sessionKey: string, identity: TeamIdentity, text: string], void>;
	approve: RpcMethod<[sessionKey: string, handle: string, revision?: number], void>;
	reject: RpcMethod<[sessionKey: string, handle: string, reason: string, revision?: number], void>;
	respondStop: RpcMethod<
		[sessionKey: string, identity: TeamIdentity, requestId: string, body: string],
		TeamStopResponse
	>;
	readTasks: RpcMethod<[sessionKey: string, identity: TeamIdentity], TeamTask[]>;
	addTask: RpcMethod<[sessionKey: string, identity: TeamIdentity, title: string], TeamTask>;
	claim: RpcMethod<[sessionKey: string, identity: TeamIdentity, id: string], TeamClaimResult>;
	releaseTask: RpcMethod<[sessionKey: string, identity: TeamIdentity, id: string], TeamTask>;
	completeTask: RpcMethod<[sessionKey: string, identity: TeamIdentity, id: string, note: string], TeamTask>;
};

export interface TeamClient {
	listTeams(sessionKey: string): Promise<string[]>;
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
	requestStop(
		sessionKey: string,
		team: string,
		generation: number,
		handle: string,
		expected: TeamCommandMember,
		force: boolean,
		timeoutMs: number,
		wholeTeam?: boolean,
	): Promise<string>;
	resolvePendingStop(
		sessionKey: string,
		team: string,
		generation: number,
		handle: string,
		expected: TeamCommandMember,
		ref?: AgentRef,
		failure?: string,
	): Promise<boolean>;
	readTasks(sessionKey: string, identity: TeamIdentity): Promise<TeamTask[]>;
	respondStop(sessionKey: string, identity: TeamIdentity, requestId: string, body: string): Promise<TeamStopResponse>;
	leadIdentity(sessionKey: string, team: string): Promise<TeamIdentity | undefined>;
	memberIdentity(sessionKey: string, team: string, generation: number, handle: string): Promise<TeamIdentity>;
	planPending(sessionKey: string, identity: TeamIdentity): Promise<boolean>;
	submitPlan(sessionKey: string, identity: TeamIdentity, text: string): Promise<void>;
	approve(sessionKey: string, handle: string, revision?: number): Promise<void>;
	reject(sessionKey: string, handle: string, reason: string, revision?: number): Promise<void>;
	addTask(sessionKey: string, identity: TeamIdentity, title: string): Promise<TeamTask>;
	claim(sessionKey: string, identity: TeamIdentity, id: string): Promise<TeamClaimResult>;
	releaseTask(sessionKey: string, identity: TeamIdentity, id: string): Promise<TeamTask>;
	completeTask(sessionKey: string, identity: TeamIdentity, id: string, note: string): Promise<TeamTask>;
}
