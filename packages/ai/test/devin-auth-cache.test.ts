import { describe, expect, it } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { AssistantMessageEventStream, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { logger } from "@oh-my-pi/pi-utils";

const fakeModel = buildModel({
	id: "swe-2",
	name: "SWE-2",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262000,
	maxTokens: 128000,
	compat: { supportsParallelToolCalls: true, modelRouter: false },
}) as Model<"devin-agent">;

const fakeContext: Context = {
	systemPrompt: ["test"],
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
};

function makeJwt(expSeconds: number): string {
	const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${b64({ alg: "none" })}.${b64({ exp: expSeconds })}.sig`;
}

function streamBody(frames: object[]): Uint8Array {
	const parts: Buffer[] = [];
	for (const f of frames) {
		const payload = gzipSync(
			Buffer.from(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, f as never))),
		);
		const head = Buffer.alloc(5);
		head[0] = 0x01; // compressed
		head.writeUInt32BE(payload.length, 1);
		parts.push(head, payload);
	}
	const trailer = Buffer.from("{}");
	const tail = Buffer.alloc(5);
	tail[0] = 0x02; // end-of-stream
	tail.writeUInt32BE(trailer.length, 1);
	parts.push(tail, trailer);
	return Buffer.concat(parts);
}
class DeferredQueue<T> {
	#waiters: ((val: T) => void)[] = [];
	#items: T[] = [];
	push(val: T): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter(val);
		else this.#items.push(val);
	}
	next(): Promise<T> {
		const item = this.#items.shift();
		if (item !== undefined) return Promise.resolve(item);
		return new Promise<T>((resolve) => this.#waiters.push(resolve));
	}
}

const AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";

function makeFetch(opts: { jwt: string; failFirstChat?: boolean }) {
	const calls = { auth: 0, chat: 0 };
	let chatAttempts = 0;
	const impl = async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
		const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		if (u.endsWith(AUTH_PATH)) {
			calls.auth++;
			return new Response(
				toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: opts.jwt })) as never,
			);
		}
		if (u.endsWith(CHAT_PATH)) {
			calls.chat++;
			chatAttempts++;
			if (opts.failFirstChat && chatAttempts === 1) {
				return new Response("unauthorized", { status: 401 });
			}
			return new Response(
				streamBody([
					{ messageId: "bot-x", requestId: "r1", latency: 0.05 },
					{ deltaText: "OK", deltaTokens: 1, latency: 0.12 },
				]) as never,
			);
		}
		return new Response("not found", { status: 404 });
	};
	return { impl: impl as unknown as typeof fetch, calls };
}

async function drain(stream: AssistantMessageEventStream) {
	let last: { type: string } | undefined;
	for await (const ev of stream) last = ev;
	return last;
}

describe("devin auth caching and turn timing", () => {
	it("shares a single GetUserJwt across subsequent turns", async () => {
		const { impl, calls } = makeFetch({ jwt: makeJwt(Math.floor(Date.now() / 1000) + 3600) });
		const s1 = await drain(streamDevin(fakeModel, fakeContext, { fetch: impl, apiKey: "k1" }));
		const s2 = await drain(streamDevin(fakeModel, fakeContext, { fetch: impl, apiKey: "k1" }));
		expect(s1?.type).toBe("done");
		expect(s2?.type).toBe("done");
		expect(calls.auth).toBe(1);
		expect(calls.chat).toBe(2);
	});

	it("recovers from 401 via single forced refresh and retry", async () => {
		const { impl, calls } = makeFetch({ jwt: makeJwt(Math.floor(Date.now() / 1000) + 3600), failFirstChat: true });
		const s = await drain(streamDevin(fakeModel, fakeContext, { fetch: impl, apiKey: "k2" }));
		expect(s?.type).toBe("done");
		expect(calls.auth).toBe(2);
		expect(calls.chat).toBe(2);
	});

	it("does not cache expired JWTs", async () => {
		const { impl, calls } = makeFetch({ jwt: makeJwt(Math.floor(Date.now() / 1000) - 10) });
		await drain(streamDevin(fakeModel, fakeContext, { fetch: impl, apiKey: "k3" }));
		await drain(streamDevin(fakeModel, fakeContext, { fetch: impl, apiKey: "k3" }));
		expect(calls.auth).toBe(2);
	});

	it("emits turn timing log with phase breakdown", async () => {
		const events: { message: string; context?: Record<string, unknown> }[] = [];
		const dispose = logger.registerLogSink((e) => {
			if (e.message.startsWith("devin:")) events.push({ message: e.message, context: e.context });
		});
		try {
			const { impl } = makeFetch({ jwt: makeJwt(Math.floor(Date.now() / 1000) + 3600) });
			await drain(streamDevin(fakeModel, fakeContext, { fetch: impl, apiKey: "k4" }));
		} finally {
			dispose();
		}
		const timing = events.find((e) => e.message === "devin: turn timing");
		expect(timing).toBeDefined();
		const ctx = timing!.context!;
		for (const key of ["authMs", "headersMs", "firstFrameMs", "serverLatencyMs", "ttftMs", "durationMs"]) {
			expect(key in ctx).toBe(true);
		}
		expect(ctx.serverLatencyMs).toBe(120);
	});

	it("shares cached bearer token across different fetch transports", async () => {
		const a = makeFetch({ jwt: makeJwt(Math.floor(Date.now() / 1000) + 3600) });
		const b = makeFetch({ jwt: makeJwt(Math.floor(Date.now() / 1000) + 3600) });
		await drain(streamDevin(fakeModel, fakeContext, { fetch: a.impl, apiKey: "k5" }));
		await drain(streamDevin(fakeModel, fakeContext, { fetch: b.impl, apiKey: "k5" }));
		expect(a.calls.auth).toBe(1);
		expect(b.calls.auth).toBe(0);
	});

	it("invalidates on double 401 and forces re-authentication next turn", async () => {
		const { impl, calls } = makeFetch({ jwt: makeJwt(Math.floor(Date.now() / 1000) + 3600) });
		let chatN = 0;
		const flaky = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
			if (u.endsWith(AUTH_PATH)) return impl(url, init);
			if (u.endsWith(CHAT_PATH)) {
				chatN++;
				if (chatN <= 2) return new Response("unauthorized", { status: 401 });
				return impl(url, init);
			}
			return new Response("not found", { status: 404 });
		};
		const s = await drain(
			streamDevin(fakeModel, fakeContext, { fetch: flaky as unknown as typeof fetch, apiKey: "k6" }),
		);
		expect(s?.type).toBe("error");
		expect(calls.auth).toBe(2);

		const s2 = await drain(
			streamDevin(fakeModel, fakeContext, { fetch: flaky as unknown as typeof fetch, apiKey: "k6" }),
		);
		expect(s2?.type).toBe("done");
		expect(calls.auth).toBe(3);
	});

	it("never caches JWT without exp claim", async () => {
		const noExp = `${Buffer.from('{"a":1}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.s`;
		const { impl, calls } = makeFetch({ jwt: noExp });
		await drain(streamDevin(fakeModel, fakeContext, { fetch: impl, apiKey: "k7" }));
		await drain(streamDevin(fakeModel, fakeContext, { fetch: impl, apiKey: "k7" }));
		expect(calls.auth).toBe(2);
	});

	it("guards against slow in-flight auth overwriting a refreshed token", async () => {
		const jwtOld = makeJwt(Math.floor(Date.now() / 1000) + 3600) + "-old";
		const jwtNew = makeJwt(Math.floor(Date.now() / 1000) + 3600) + "-new";
		const authQueue = new DeferredQueue<(r: Response) => void>();
		const chatJwts: string[] = [];
		let chatN = 0;
		const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
			if (u.endsWith(AUTH_PATH)) {
				return new Promise<Response>((resolve) => authQueue.push(resolve));
			}
			if (u.endsWith(CHAT_PATH)) {
				chatN++;
				const body = init?.body as Uint8Array;
				const flag = body[0];
				const len = (body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4];
				const payload = body.subarray(5, 5 + len);
				const raw = flag & 0x01 ? gunzipSync(payload) : payload;
				const req = fromBinary(GetChatMessageRequestSchema, raw);
				chatJwts.push(req.metadata?.userJwt ?? "");
				if (chatN === 1) return new Response("unauthorized", { status: 401 });
				return new Response(streamBody([{ deltaText: "OK", deltaTokens: 1, latency: 0.1 }]) as never);
			}
			return new Response("not found", { status: 404 });
		};
		const opts = { fetch: impl as unknown as typeof fetch, apiKey: "k8" };

		const t1 = drain(streamDevin(fakeModel, fakeContext, opts));
		const r1 = await authQueue.next();
		const t2 = drain(streamDevin(fakeModel, fakeContext, opts));
		const r2 = await authQueue.next();

		r2(new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: jwtNew })) as never));
		const r3 = await authQueue.next();
		r3(new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: jwtNew })) as never));
		await t2;

		r1(new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: jwtOld })) as never));
		await t1;

		await drain(streamDevin(fakeModel, fakeContext, opts));
		expect(chatJwts.at(-1)).toBe(jwtNew);
	});

	it("resolves race condition by letting the latest-issued auth win", async () => {
		const jwtOld = makeJwt(Math.floor(Date.now() / 1000) + 3600) + "-old";
		const jwtNew = makeJwt(Math.floor(Date.now() / 1000) + 3600) + "-new";
		const authQueue = new DeferredQueue<(r: Response) => void>();
		const chatJwts: string[] = [];
		const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
			if (u.endsWith(AUTH_PATH)) {
				return new Promise<Response>((resolve) => authQueue.push(resolve));
			}
			if (u.endsWith(CHAT_PATH)) {
				const body = init?.body as Uint8Array;
				const flag = body[0];
				const len = (body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4];
				const payload = body.subarray(5, 5 + len);
				const raw = flag & 0x01 ? gunzipSync(payload) : payload;
				chatJwts.push(fromBinary(GetChatMessageRequestSchema, raw).metadata?.userJwt ?? "");
				return new Response(streamBody([{ deltaText: "OK", deltaTokens: 1, latency: 0.1 }]) as never);
			}
			return new Response("not found", { status: 404 });
		};
		const opts = { fetch: impl as unknown as typeof fetch, apiKey: "k9" };

		const t1 = drain(streamDevin(fakeModel, fakeContext, opts));
		const r1 = await authQueue.next();
		const t2 = drain(streamDevin(fakeModel, fakeContext, opts));
		const r2 = await authQueue.next();

		r2(new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: jwtNew })) as never));
		r1(new Response(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: jwtOld })) as never));
		await t1;
		await t2;
		await drain(streamDevin(fakeModel, fakeContext, opts));
		expect(chatJwts.at(-1)).toBe(jwtNew);
	});
});
