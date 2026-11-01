import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { gunzipSync } from "node:zlib";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AssignModelResponseSchema,
	type GetChatMessageRequest,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
	ModelAssignmentSchema,
	StopReason,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { DevinCompat } from "@oh-my-pi/pi-catalog/types";
import { stream } from "../src/stream";
import type { DispatchHold, FetchImpl, Model } from "../src/types";

/**
 * Round 3 of the PR #17399 review (R3-5) found Bedrock signing a request
 * before the transport's dispatch hold, so a request parked by `/pause` went
 * out on resume with an authorization too old to accept. Devin had the same
 * shape twice over: the user JWT from `GetUserJwt` and, for a router model,
 * the assignment JWT from `AssignModel` both ride in the chat request's
 * protobuf body, and both were minted before the chat request's hold. Each
 * must be valid at the moment the request leaves, so the body that carries
 * them is built after the holds open.
 */

const MINTED = new Date("2026-10-30T10:00:00Z");
const RESUMED = new Date("2026-10-30T10:10:00Z");
/** Shorter than the pause, so a token minted before it has expired at resume. */
const TOKEN_LIFETIME_S = 120;

const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const ASSIGN_PATH = "/exa.api_server_pb.ApiServerService/AssignModel";
const AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";

const realSetImmediate = globalThis.setImmediate;

/** Lets every pending async chain run to its next I/O wait. */
async function settle(): Promise<void> {
	for (let round = 0; round < 25; round++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetImmediate(resolve);
		await promise;
	}
}

/** Lets the async chains run until `ready` holds; a cold module load takes real time. */
async function settleUntil(ready: () => boolean): Promise<void> {
	const deadline = Bun.nanoseconds() + 5e9;
	while (!ready() && Bun.nanoseconds() < deadline) await settle();
	expect(ready()).toBe(true);
}

/** `/pause`: closed, its hold parks until reopened, and its probe says so. */
interface PauseGate {
	hold: DispatchHold;
	close(): void;
	open(): void;
	readonly closed: boolean;
}

function pauseGate(): PauseGate {
	let closed = false;
	let reopened = Promise.withResolvers<void>();
	const hold: DispatchHold = () => (closed ? reopened.promise : undefined);
	hold.isClosed = () => closed;
	return {
		hold,
		close() {
			if (closed) return;
			closed = true;
			reopened = Promise.withResolvers<void>();
		},
		open() {
			closed = false;
			reopened.resolve();
		},
		get closed() {
			return closed;
		},
	};
}

/** `HHMM` of the fake clock: the moment a token was minted. */
function clock(): string {
	const now = new Date();
	return `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
}

/** A JWT the server minted now, named `<kind>-HHMM`, that expires `TOKEN_LIFETIME_S` later. */
function mintJwt(kind: string): string {
	const claims = { name: `${kind}-${clock()}`, exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_S };
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

/** The name a {@link mintJwt} token carries; the token itself when it has none. */
function tokenName(token: string | undefined): string | undefined {
	const payload = token?.split(".")[1];
	if (!payload) return token;
	const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	return claims && typeof claims === "object" && "name" in claims ? String(claims.name) : token;
}

function devinModel(compat: DevinCompat, requestModelId: string): Model<"devin-agent"> {
	return buildModel({
		id: "devin-pause-fixture",
		name: "Devin pause fixture",
		api: "devin-agent",
		provider: "devin",
		baseUrl: "https://server.codeium.com",
		requestModelId,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		compat,
	});
}

function decodeChatRequest(body: RequestInit["body"]): GetChatMessageRequest {
	const framed = new Uint8Array(body as ArrayBuffer);
	const length = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(1, false);
	const message = framed.subarray(5, 5 + length);
	return fromBinary(GetChatMessageRequestSchema, framed[0] & 0x01 ? gunzipSync(message) : message);
}

function chatFrame(): Uint8Array {
	const payload = toBinary(
		GetChatMessageResponseSchema,
		create(GetChatMessageResponseSchema, { messageId: "msg-1", stopReason: StopReason.STOP_PATTERN }),
	);
	const out = new Uint8Array(5 + payload.length);
	new DataView(out.buffer).setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

interface ChatOnWire {
	userJwt: string | undefined;
	assignmentJwt: string | undefined;
	paused: boolean;
}

/**
 * A Devin edge that mints every token at the fake clock's time. `onMint` runs
 * as each auth or assignment answers, so a test can engage the pause there.
 */
function devinServer(options: { pause: PauseGate; userJwt?: () => string; onMint?: (path: string) => void }) {
	const paths: string[] = [];
	const chats: ChatOnWire[] = [];
	const fetch: FetchImpl = async (input, init) => {
		const path = new URL(String(input)).pathname;
		paths.push(path);
		if (path === AUTH_PATH) {
			const userJwt = options.userJwt?.() ?? mintJwt("user");
			options.onMint?.(path);
			return new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt })));
		}
		if (path === ASSIGN_PATH) {
			const assignment = create(ModelAssignmentSchema, {
				assignmentJwt: mintJwt("assignment"),
				modelUid: "claude-sonnet-4-5",
			});
			options.onMint?.(path);
			return new Response(toBinary(AssignModelResponseSchema, create(AssignModelResponseSchema, { assignment })));
		}
		const chat = decodeChatRequest(init?.body);
		chats.push({
			userJwt: tokenName(chat.metadata?.userJwt),
			assignmentJwt: tokenName(chat.modelAssignmentJwt),
			paused: options.pause.closed,
		});
		return new Response(chatFrame());
	};
	return { fetch, paths, chats };
}

const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

afterEach(() => {
	setSystemTime();
});

describe("Devin authorizes a held chat request where it leaves", () => {
	it("re-mints a user JWT that expired while the request was held", async () => {
		setSystemTime(MINTED);
		const pause = pauseGate();
		let exchanges = 0;
		// `/pause` engages as the first session-token exchange answers.
		const server = devinServer({
			pause,
			onMint: path => {
				if (path === AUTH_PATH && ++exchanges === 1) pause.close();
			},
		});
		const result = stream(devinModel({}, "claude-sonnet-4-5"), context, {
			apiKey: "token",
			beforeDispatch: pause.hold,
			fetch: server.fetch,
		}).result();

		await settleUntil(() => exchanges > 0);
		await settle();
		expect(server.chats).toEqual([]);
		setSystemTime(RESUMED);
		pause.open();
		const message = await result;

		expect(message.stopReason).toBe("stop");
		expect(server.chats).toEqual([{ userJwt: "user-1010", assignmentJwt: undefined, paused: false }]);
	});

	it("assigns a router model again when the assignment expired while the request was held", async () => {
		setSystemTime(MINTED);
		const pause = pauseGate();
		let assignments = 0;
		// `/pause` engages as the first assignment answers.
		const server = devinServer({
			pause,
			onMint: path => {
				if (path === ASSIGN_PATH && ++assignments === 1) pause.close();
			},
		});
		const result = stream(devinModel({ modelRouter: true }, "adaptive"), context, {
			apiKey: "token",
			beforeDispatch: pause.hold,
			fetch: server.fetch,
		}).result();

		await settleUntil(() => assignments > 0);
		await settle();
		expect(server.chats).toEqual([]);
		setSystemTime(RESUMED);
		pause.open();
		const message = await result;

		expect(message.stopReason).toBe("stop");
		expect(message.upstreamModel).toBe("claude-sonnet-4-5");
		expect(server.chats).toEqual([{ userJwt: "user-1010", assignmentJwt: "assignment-1010", paused: false }]);
	});

	it("keeps a user JWT that is still valid when the request leaves", async () => {
		setSystemTime(MINTED);
		const pause = pauseGate();
		const server = devinServer({ pause });

		await stream(devinModel({ modelRouter: true }, "adaptive"), context, {
			apiKey: "token",
			beforeDispatch: pause.hold,
			fetch: server.fetch,
		}).result();

		expect(server.paths).toEqual([AUTH_PATH, ASSIGN_PATH, CHAT_PATH]);
		expect(server.chats).toEqual([{ userJwt: "user-1000", assignmentJwt: "assignment-1000", paused: false }]);
	});

	// A token that states no expiry cannot be shown to outlive whatever wait
	// came before the request, so it is exchanged again where the request leaves.
	it("exchanges a user JWT with no expiry again where the request leaves", async () => {
		setSystemTime(MINTED);
		const pause = pauseGate();
		let exchanges = 0;
		const server = devinServer({ pause, userJwt: () => `opaque-user-jwt-${++exchanges}` });

		await stream(devinModel({}, "claude-sonnet-4-5"), context, {
			apiKey: "token",
			beforeDispatch: pause.hold,
			fetch: server.fetch,
		}).result();

		expect(server.paths).toEqual([AUTH_PATH, AUTH_PATH, CHAT_PATH]);
		expect(server.chats).toEqual([{ userJwt: "opaque-user-jwt-2", assignmentJwt: undefined, paused: false }]);
	});
});
