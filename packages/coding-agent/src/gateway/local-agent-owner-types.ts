import type { GatewayCommand, GatewayEvent, GatewaySessionState } from "./types";

export const LOCAL_AGENT_OWNER_PROTOCOL = 1 as const;
export const MAX_OWNER_FRAME_BYTES = 1_048_576;
export const MAX_OWNER_TRANSCRIPT_BYTES = 262_144;
export const MAX_OWNER_REPLAY_EVENTS = 512;
export const MAX_OWNER_REQUEST_CACHE = 512;

export type LocalAgentStatus = "running" | "idle" | "parked" | "aborted";
export type LocalAgentOwnerLifecycle = "starting" | "running" | "idle" | "stopping";

/** Public discovery record. It names the token file but never contains the bearer token. */
export interface LocalAgentRuntimeDescriptor {
	readonly protocol: typeof LOCAL_AGENT_OWNER_PROTOCOL;
	readonly sessionId: string;
	readonly agentId: string;
	readonly ownerId: string;
	readonly ownerPid: number;
	readonly ownerEpoch: number;
	readonly endpoint: string;
	readonly tokenFilePath: string;
	readonly transcriptPath: string;
	readonly leaseExpiresAt: number;
	readonly eventSeq: number;
	readonly lifecycle: LocalAgentOwnerLifecycle;
	readonly ref: LocalAgentRefSnapshot;
}

export interface LocalAgentRefSnapshot {
	readonly id: string;
	readonly sessionId: string;
	readonly displayName: string;
	readonly kind: string;
	readonly parentId?: string;
	readonly cwd: string;
	readonly status: LocalAgentStatus;
	readonly activity?: string;
	readonly needsAttention: boolean;
	readonly attentionReason?: string;
}

export type LocalAgentOwnerEvent =
	| { readonly type: "snapshot"; readonly descriptor: LocalAgentRuntimeDescriptor }
	| { readonly type: "gateway"; readonly event: GatewayEvent }
	| { readonly type: "heartbeat"; readonly leaseExpiresAt: number }
	| { readonly type: "status"; readonly status: LocalAgentStatus; readonly at: number }
	| { readonly type: "owner_stopping"; readonly reason: "settled" | "shutdown" | "error" };

export interface SequencedLocalAgentOwnerEvent {
	readonly ownerEpoch: number;
	readonly seq: number;
	readonly event: LocalAgentOwnerEvent;
}

export type LocalAgentOwnerCommand =
	| { readonly type: "status" }
	| { readonly type: "list" }
	| { readonly type: "chat"; readonly text: string }
	| { readonly type: "abort" }
	| { readonly type: "revive" }
	| { readonly type: "gateway"; readonly command: GatewayCommand };

export type LocalAgentOwnerResponseData =
	| LocalAgentRuntimeDescriptor
	| readonly LocalAgentRefSnapshot[]
	| GatewaySessionState
	| { readonly accepted: boolean }
	| { readonly cancelled: boolean }
	| undefined;

export type LocalAgentOwnerErrorCode =
	| "unauthorized"
	| "stale_epoch"
	| "invalid"
	| "not_found"
	| "owner_stopping"
	| "internal";

export type LocalAgentOwnerClientFrame =
	| {
			readonly t: "hello";
			readonly protocol: typeof LOCAL_AGENT_OWNER_PROTOCOL;
			readonly sessionId: string;
			readonly ownerEpoch: number;
			readonly token: string;
			readonly afterSeq: number;
	  }
	| {
			readonly t: "command";
			readonly requestId: string;
			readonly ownerEpoch: number;
			readonly command: LocalAgentOwnerCommand;
	  }
	| {
			readonly t: "read_transcript";
			readonly requestId: string;
			readonly ownerEpoch: number;
			readonly fromByte: number;
			readonly maxBytes: number;
	  };

export type LocalAgentOwnerServerFrame =
	| {
			readonly t: "hello_ok";
			readonly descriptor: LocalAgentRuntimeDescriptor;
			readonly latestSeq: number;
	  }
	| ({ readonly t: "event" } & SequencedLocalAgentOwnerEvent)
	| {
			readonly t: "response";
			readonly requestId: string;
			readonly ownerEpoch: number;
			readonly ok: true;
			readonly data?: LocalAgentOwnerResponseData;
	  }
	| {
			readonly t: "response";
			readonly requestId: string;
			readonly ownerEpoch: number;
			readonly ok: false;
			readonly code: LocalAgentOwnerErrorCode;
			readonly error: string;
	  }
	| {
			readonly t: "transcript";
			readonly requestId: string;
			readonly ownerEpoch: number;
			readonly text: string;
			readonly newSize: number;
			readonly eof: boolean;
	  };

export interface LocalAgentTranscriptChunk {
	readonly text: string;
	readonly newSize: number;
	readonly eof: boolean;
}

export class LocalAgentOwnerProtocolError extends Error {
	readonly code: LocalAgentOwnerErrorCode;

	constructor(code: LocalAgentOwnerErrorCode, message: string) {
		super(message);
		this.name = "LocalAgentOwnerProtocolError";
		this.code = code;
	}
}
