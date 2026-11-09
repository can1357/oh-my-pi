import type { WorkerThreadLink } from "../protocol";
import { teamRuntime } from "../../task/team-runtime";
import type { RpcServe } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import { getTeamSessionBridge } from "./team-bridge";
import { installTeamClient, TeamEndpoint } from "./team-client";
import { TEAM_SERVICE_KIND, type TeamProtocol } from "./team-protocol";
import { RemoteTeamClient } from "./team-remote";

const serve: RpcServe<TeamEndpoint, TeamProtocol> = {
	listTeams: (endpoint, key) => endpoint.listTeams(key),
	start: (endpoint, key, team) => endpoint.start(key, team),
	members: (endpoint, key, team) => endpoint.members(key, team),
	putMember: (endpoint, key, team, generation, handle, expected, entry) =>
		endpoint.putMember(key, team, generation, handle, expected, entry),
	deleteMember: (endpoint, key, team, generation, handle, expected) =>
		endpoint.deleteMember(key, team, generation, handle, expected),
	stop: (endpoint, key, team, generation) => endpoint.stop(key, team, generation),
	requestStop: (endpoint, key, team, generation, handle, expected, force, timeoutMs, wholeTeam) =>
		endpoint.requestStop(key, team, generation, handle, expected, force, timeoutMs, wholeTeam),
	resolvePendingStop: (endpoint, key, team, generation, handle, expected, ref, failure) =>
		endpoint.resolvePendingStop(key, team, generation, handle, expected, ref, failure),
	leadIdentity: (endpoint, key, team) => endpoint.leadIdentity(key, team),
	memberIdentity: (endpoint, key, team, generation, handle) => endpoint.memberIdentity(key, team, generation, handle),
	planPending: (endpoint, key, identity) => endpoint.planPending(key, identity),
	submitPlan: (endpoint, key, identity, text) => endpoint.submitPlan(key, identity, text),
	approve: (endpoint, key, handle, revision) => endpoint.approve(key, handle, revision),
	reject: (endpoint, key, handle, reason, revision) => endpoint.reject(key, handle, reason, revision),
	respondStop: (endpoint, key, identity, requestId, body) => endpoint.respondStop(key, identity, requestId, body),
	readTasks: (endpoint, key, identity) => endpoint.readTasks(key, identity),
	addTask: (endpoint, key, identity, title) => endpoint.addTask(key, identity, title),
	claim: (endpoint, key, identity, id) => endpoint.claim(key, identity, id),
	releaseTask: (endpoint, key, identity, id) => endpoint.releaseTask(key, identity, id),
	completeTask: (endpoint, key, identity, id, note) => endpoint.completeTask(key, identity, id, note),
};

const endpoints = new Map<WorkerPeer["threadId"], TeamEndpoint>();

export const teamThreadService: ThreadService = {
	name: "team",
	installMain(peer: WorkerPeer) {
		const bridge = getTeamSessionBridge(peer);
		if (!bridge) throw new Error("Team service requires an agent session bridge");
		bridge.onSessionClosed = session => teamRuntime.sessionClosed(session);
		endpoints.set(peer.threadId, new TeamEndpoint(bridge));
		peer.link.exportClass(TEAM_SERVICE_KIND, (value): value is TeamEndpoint => value instanceof TeamEndpoint, serve);
	},
	globals(peer: WorkerPeer) {
		const endpoint = endpoints.get(peer.threadId);
		if (!endpoint) throw new Error("Missing team endpoint");
		return endpoint;
	},
	onWorkerExit(peer: WorkerPeer) {
		endpoints.delete(peer.threadId);
	},
	installWorker(link: WorkerThreadLink) {
		link.importClass<RemoteTeamClient, TeamProtocol>(TEAM_SERVICE_KIND, remote => new RemoteTeamClient(remote));
	},
	boot(globals: unknown) {
		if (!(globals instanceof RemoteTeamClient)) throw new Error("Malformed team thread globals");
		installTeamClient(globals);
	},
};
