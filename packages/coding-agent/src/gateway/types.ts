/**
 * Transport-neutral AgentSession gateway contract.
 *
 * This is a trusted-core command/event surface shared by terminal, API, mobile,
 * Slack/Telegram, and similar adapters. It intentionally does **not** perform
 * transport authentication, authorization, or rate limiting — remote adapters
 * MUST apply those controls before forwarding commands into the gateway.
 *
 * The gateway never widens session permissions or mutates model/config/policy
 * settings; adapters that need those controls must use other session APIs.
 */
import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import { isRecord } from "@pk-nerdsaver-ai/pi-utils";

export const GATEWAY_COMMAND_TYPES = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"abort_and_prompt",
	"get_state",
	"new_session",
] as const;

export type GatewayCommandType = (typeof GATEWAY_COMMAND_TYPES)[number];

/** Channel/session identity metadata carried on every command. */
export interface GatewayIdentity {
	channelId: string;
	sessionKey: string;
}

export type GatewayStreamingBehavior = "steer" | "followUp";

interface GatewayCommandBase {
	id: string;
	identity: GatewayIdentity;
}

export type GatewayCommand =
	| (GatewayCommandBase & {
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: GatewayStreamingBehavior;
	  })
	| (GatewayCommandBase & {
			type: "steer";
			message: string;
			images?: ImageContent[];
	  })
	| (GatewayCommandBase & {
			type: "follow_up";
			message: string;
			images?: ImageContent[];
	  })
	| (GatewayCommandBase & {
			type: "abort";
	  })
	| (GatewayCommandBase & {
			type: "abort_and_prompt";
			message: string;
			images?: ImageContent[];
	  })
	| (GatewayCommandBase & {
			type: "get_state";
	  })
	| (GatewayCommandBase & {
			type: "new_session";
			parentSession?: string;
	  });

/** Safe model projection — never includes headers, baseUrl, or credentials. */
export interface GatewayModelRef {
	provider: string;
	id: string;
	name: string;
}

export interface GatewaySessionState {
	sessionFile?: string;
	sessionId: string;
	isStreaming: boolean;
	thinkingLevel: ThinkingLevel | undefined;
	cwd: string;
	model?: GatewayModelRef;
}

export type GatewayResponseData = { agentInvoked: boolean } | { cancelled: boolean } | GatewaySessionState | undefined;

export type GatewaySessionEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "assistant_text_delta"; text: string }
	| { type: "assistant_end"; stopReason?: string; hasError: boolean }
	| { type: "tool_start"; toolCallId: string; toolName: string }
	| { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "thinking_level_changed"; thinkingLevel: ThinkingLevel | undefined };

export type GatewayEvent =
	| { type: "ready" }
	| { type: "session_event"; event: GatewaySessionEvent }
	| {
			type: "response";
			id: string;
			command: GatewayCommandType;
			success: true;
			data?: GatewayResponseData;
	  }
	| {
			type: "response";
			id: string;
			command: GatewayCommandType;
			success: false;
			error: string;
	  }
	| { type: "protocol_error"; id?: string; error: string };

export type GatewayEventListener = (event: GatewayEvent) => void;

export type ParseGatewayCommandResult = { ok: true; command: GatewayCommand } | { ok: false; error: string };

export const MAX_GATEWAY_ID_CHARS = 256;
export const MAX_GATEWAY_IDENTITY_CHARS = 512;
export const MAX_GATEWAY_MESSAGE_CHARS = 200_000;
export const MAX_GATEWAY_IMAGES = 8;
export const MAX_GATEWAY_IMAGE_DATA_CHARS = 20_000_000;

const IMAGE_DETAILS = new Set<string>(["auto", "low", "high", "original"]);

function isImageDetail(value: string): value is NonNullable<ImageContent["detail"]> {
	return IMAGE_DETAILS.has(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseIdentity(value: unknown): GatewayIdentity | string {
	if (!isRecord(value)) return "identity must be an object";
	if (!isNonEmptyString(value.channelId)) return "identity.channelId must be a non-empty string";
	if (value.channelId.length > MAX_GATEWAY_IDENTITY_CHARS) return "identity.channelId is too long";
	if (!isNonEmptyString(value.sessionKey)) return "identity.sessionKey must be a non-empty string";
	if (value.sessionKey.length > MAX_GATEWAY_IDENTITY_CHARS) return "identity.sessionKey is too long";
	return { channelId: value.channelId, sessionKey: value.sessionKey };
}

function parseImages(value: unknown): ImageContent[] | string | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return "images must be an array";
	if (value.length > MAX_GATEWAY_IMAGES) return `images must contain at most ${MAX_GATEWAY_IMAGES} items`;
	const images: ImageContent[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (!isRecord(item)) return `images[${i}] must be an object`;
		if (item.type !== "image") return `images[${i}].type must be "image"`;
		if (typeof item.data !== "string") return `images[${i}].data must be a string`;
		if (item.data.length > MAX_GATEWAY_IMAGE_DATA_CHARS) return `images[${i}].data is too large`;
		if (typeof item.mimeType !== "string") return `images[${i}].mimeType must be a string`;
		const image: ImageContent = {
			type: "image",
			data: item.data,
			mimeType: item.mimeType,
		};
		if (item.detail !== undefined) {
			if (typeof item.detail !== "string" || !isImageDetail(item.detail)) {
				return `images[${i}].detail must be one of auto|low|high|original`;
			}
			image.detail = item.detail;
		}
		images.push(image);
	}
	return images;
}

function parseStreamingBehavior(value: unknown): GatewayStreamingBehavior | undefined {
	if (value === undefined) return undefined;
	if (value === "steer" || value === "followUp") return value;
	return undefined;
}

function isGatewayCommandType(value: unknown): value is GatewayCommandType {
	return typeof value === "string" && (GATEWAY_COMMAND_TYPES as readonly string[]).includes(value);
}

/**
 * Pure runtime guard for untrusted adapter input. Rejects unknown shapes
 * instead of casting.
 */
export function parseGatewayCommand(input: unknown): ParseGatewayCommandResult {
	if (!isRecord(input)) {
		return { ok: false, error: "command must be an object" };
	}
	if (!isNonEmptyString(input.id)) {
		return { ok: false, error: "id must be a non-empty string" };
	}
	if (input.id.length > MAX_GATEWAY_ID_CHARS) {
		return { ok: false, error: "id is too long" };
	}
	if (!isGatewayCommandType(input.type)) {
		return { ok: false, error: `unknown command type: ${String(input.type)}` };
	}

	const identity = parseIdentity(input.identity);
	if (typeof identity === "string") {
		return { ok: false, error: identity };
	}

	const id = input.id;
	const type = input.type;

	switch (type) {
		case "abort":
		case "get_state":
			return { ok: true, command: { id, type, identity } };

		case "new_session": {
			if (input.parentSession !== undefined && typeof input.parentSession !== "string") {
				return { ok: false, error: "parentSession must be a string when provided" };
			}
			if (typeof input.parentSession === "string" && input.parentSession.length > MAX_GATEWAY_IDENTITY_CHARS) {
				return { ok: false, error: "parentSession is too long" };
			}
			return {
				ok: true,
				command: {
					id,
					type,
					identity,
					...(typeof input.parentSession === "string" ? { parentSession: input.parentSession } : {}),
				},
			};
		}

		case "prompt": {
			if (typeof input.message !== "string") {
				return { ok: false, error: "message must be a string" };
			}
			if (input.message.length > MAX_GATEWAY_MESSAGE_CHARS) {
				return { ok: false, error: "message is too long" };
			}
			const images = parseImages(input.images);
			if (typeof images === "string") return { ok: false, error: images };
			if (
				input.streamingBehavior !== undefined &&
				input.streamingBehavior !== "steer" &&
				input.streamingBehavior !== "followUp"
			) {
				return { ok: false, error: 'streamingBehavior must be "steer" or "followUp"' };
			}
			const streamingBehavior = parseStreamingBehavior(input.streamingBehavior);
			return {
				ok: true,
				command: {
					id,
					type,
					identity,
					message: input.message,
					...(images ? { images } : {}),
					...(streamingBehavior ? { streamingBehavior } : {}),
				},
			};
		}

		case "steer":
		case "follow_up":
		case "abort_and_prompt": {
			if (typeof input.message !== "string") {
				return { ok: false, error: "message must be a string" };
			}
			if (input.message.length > MAX_GATEWAY_MESSAGE_CHARS) {
				return { ok: false, error: "message is too long" };
			}
			const images = parseImages(input.images);
			if (typeof images === "string") return { ok: false, error: images };
			return {
				ok: true,
				command: {
					id,
					type,
					identity,
					message: input.message,
					...(images ? { images } : {}),
				},
			};
		}
	}
}
