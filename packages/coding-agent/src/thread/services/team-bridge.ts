import type { WorkerPeer } from "../services";

export interface TeamSessionBridge {
	session(key: string): object | undefined;
	onSessionClosed?: (session: object) => void;
}

const bridges = new Map<WorkerPeer["threadId"], TeamSessionBridge>();
export function setTeamSessionBridge(peer: WorkerPeer, bridge: TeamSessionBridge): void {
	bridges.set(peer.threadId, bridge);
}
export function getTeamSessionBridge(peer: WorkerPeer): TeamSessionBridge | undefined {
	return bridges.get(peer.threadId);
}
export function deleteTeamSessionBridge(peer: WorkerPeer): void {
	bridges.delete(peer.threadId);
}
