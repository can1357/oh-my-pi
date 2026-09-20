import { afterEach, describe, expect, it, vi } from "bun:test";
import { createGrokbotChecksum } from "@oh-my-pi/pi-ai/providers/grokbot/auth";
import { loginGrokbotFlow, refreshGrokbotFlow, verifyInference } from "@oh-my-pi/pi-ai/oauth/grokbot";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const BACKEND = "https://api2.cursor.sh";
const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";
const TEXT_FRAME = Buffer.from("CgwKCkhFTExPLVdJUkU=", "base64");
const PONG_FRAME = Buffer.from([0x0a, 0x08, 0x0a, 0x06, ...Buffer.from("pong42")]);

function pongFrame(reply: string): Buffer {
	return wireField(1, wireField(1, Buffer.from(reply)));
}

function connectFrame(payload: Uint8Array, flags = 0): Buffer {
	const envelope = Buffer.alloc(5 + payload.length);
	envelope[0] = flags;
	envelope.writeUInt32BE(payload.length, 1);
	Buffer.from(payload).copy(envelope, 5);
	return envelope;
}

function wireField(fieldNo: number, payload: Uint8Array): Buffer {
	if (payload.length >= 128) throw new Error("test wire field is too large");
	return Buffer.concat([Buffer.from([(fieldNo << 3) | 2, payload.length]), Buffer.from(payload)]);
}

const RESPONSE_INFO_ERROR_FRAME = wireField(4, wireField(5, Buffer.from("response info failed")));
const ERROR_FRAME = wireField(8, wireField(1, Buffer.from("stream failed")));
async function drainMicrotasks(turns = 10): Promise<void> {
	for (let i = 0; i < turns; i++) await Promise.resolve();
}

const COMPLETE_INFERENCE_STREAM = Buffer.concat([connectFrame(PONG_FRAME), connectFrame(Buffer.from("{}"), 0b10)]);

function streamResponse(chunks: readonly Uint8Array[]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		}),
	);
}

function openStreamResponse(chunks: readonly Uint8Array[]): { response: Response; cancelled: () => boolean } {
	let wasCancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
		},
		cancel() {
			wasCancelled = true;
		},
	});
	return { response: new Response(body), cancelled: () => wasCancelled };
}

function inferenceFetch(chunks: readonly Uint8Array[]): FetchImpl {
	return async input => {
		const url = String(input);
		if (url === `${BACKEND}/sand-box/inference-credential`) {
			return new Response(JSON.stringify({ grokBotToken: "synthetic-minted-token" }), { status: 200 });
		}
		if (url === `${BACKEND}${STREAM_PATH}`) return streamResponse(chunks);
		throw new Error(`unexpected inference request: ${url}`);
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("Grok Bot OAuth verification", () => {
	it("requires the exact verification reply rather than any non-empty text", async () => {
		const result = await verifyInference("synthetic-renewal", "synthetic-machine", {
			fetch: inferenceFetch([Buffer.concat([connectFrame(TEXT_FRAME), connectFrame(Buffer.from("{}"), 0b10)])]),
		});

		expect(result.ok).toBeFalse();
	});

	it("rejects malformed end-stream metadata after the exact probe reply", async () => {
		const result = await verifyInference("synthetic-renewal", "synthetic-machine", {
			fetch: inferenceFetch([
				Buffer.concat([
					connectFrame(PONG_FRAME),
					connectFrame(Buffer.from('{"metadata":{"x-cursor-request":["ok",1]}}'), 0b10),
				]),
			]),
		});

		expect(result).toEqual({ ok: false, detail: "inference stream had invalid Connect framing" });
	});

	it("ignores an oversized header after a clean trailer in the same chunk", async () => {
		const oversizedHeader = Buffer.alloc(5);
		oversizedHeader.writeUInt32BE(64 * 1024 * 1024, 1);
		const stream = openStreamResponse([Buffer.concat([COMPLETE_INFERENCE_STREAM, oversizedHeader])]);
		const fetch: FetchImpl = async input => {
			const url = String(input);
			if (url === `${BACKEND}/sand-box/inference-credential`) {
				return new Response(JSON.stringify({ grokBotToken: "synthetic-minted-token" }), { status: 200 });
			}
			if (url === `${BACKEND}${STREAM_PATH}`) return stream.response;
			throw new Error(`unexpected inference request: ${url}`);
		};

		expect(await verifyInference("synthetic-renewal", "synthetic-machine", { fetch })).toEqual({
			ok: true,
			detail: "inference verified",
		});
		expect(stream.cancelled()).toBeTrue();
	});

	it("recognizes a complete Connect response split at every byte boundary", async () => {
		for (let split = 1; split < COMPLETE_INFERENCE_STREAM.length; split++) {
			const result = await verifyInference("synthetic-renewal", "synthetic-machine", {
				fetch: inferenceFetch([
					COMPLETE_INFERENCE_STREAM.subarray(0, split),
					COMPLETE_INFERENCE_STREAM.subarray(split),
				]),
			});

			expect(result).toEqual({ ok: true, detail: "inference verified" });
		}
	});

	it("rejects whitespace and oversized probe replies before the stream trailer", async () => {
		for (const reply of [" pong42", "pong42x"]) {
			const stream = openStreamResponse([connectFrame(pongFrame(reply))]);
			const fetch: FetchImpl = async input => {
				const url = String(input);
				if (url === `${BACKEND}/sand-box/inference-credential`) {
					return new Response(JSON.stringify({ grokBotToken: "synthetic-minted-token" }), { status: 200 });
				}
				if (url === `${BACKEND}${STREAM_PATH}`) return stream.response;
				throw new Error(`unexpected inference request: ${url}`);
			};

			const result = await verifyInference("synthetic-renewal", "synthetic-machine", { fetch });
			expect(result.ok).toBeFalse();
			expect(stream.cancelled()).toBeTrue();
		}
	});

	it("rejects decoded in-band errors even after receiving text", async () => {
		for (const payload of [RESPONSE_INFO_ERROR_FRAME, ERROR_FRAME]) {
			const result = await verifyInference("synthetic-renewal", "synthetic-machine", {
				fetch: inferenceFetch([Buffer.concat([connectFrame(PONG_FRAME), connectFrame(payload)])]),
			});

			expect(result.ok).toBeFalse();
			expect(result.detail).toContain("in-band error");
		}
	});

	it("interrupts the polling delay when login is cancelled", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const aborted = Promise.withResolvers<void>();
		const login = loginGrokbotFlow({
			onAuth: () =>
				queueMicrotask(() => {
					controller.abort();
					aborted.resolve();
				}),
			fetch: async () => {
				throw new Error("poll should not run after cancellation");
			},
			signal: controller.signal,
		});

		await aborted.promise;
		expect(vi.getTimerCount()).toBe(0);
		await expect(login).rejects.toBeDefined();
	});

	it("cancels a stalled account RPC body at its per-request deadline", async () => {
		vi.useFakeTimers();
		let cancelled = false;
		const authStarted = Promise.withResolvers<void>();
		const fetch: FetchImpl = async input => {
			const url = new URL(String(input));
			if (url.pathname === "/auth/poll") {
				return new Response(JSON.stringify({ accessToken: "account-token" }), { status: 200 });
			}
			if (url.pathname === "/aiserver.v1.DashboardService/RegisterSandMachine") {
				return new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
					}),
				);
			}
			throw new Error(`unexpected Grok Bot login request: ${url}`);
		};

		const login = loginGrokbotFlow({ onAuth: () => authStarted.resolve(), fetch });
		await authStarted.promise;
		vi.advanceTimersByTime(1_000);
		await drainMicrotasks();
		vi.advanceTimersByTime(30_000);
		await drainMicrotasks();
		const error = await login.catch(reason => reason);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("request timed out");
		expect(cancelled).toBeTrue();
	});

	it("rejects truncated and trailerless verification streams", async () => {
		const cases = [
			{
				name: "truncated Connect frame",
				chunks: [COMPLETE_INFERENCE_STREAM.subarray(0, COMPLETE_INFERENCE_STREAM.length - 1)],
				detail: "truncated",
			},
			{
				name: "missing Connect end-stream trailer",
				chunks: [connectFrame(PONG_FRAME)],
				detail: "end-stream trailer",
			},
		] as const;

		for (const fixture of cases) {
			const result = await verifyInference("synthetic-renewal", "synthetic-machine", {
				fetch: inferenceFetch(fixture.chunks),
			});
			expect(result.ok, fixture.name).toBeFalse();
			expect(result.detail).toContain(fixture.detail);
		}
	});

	it("rejects ignored Connect frames beyond the aggregate verifier budget", async () => {
		const ignoredFrames = Buffer.concat(Array.from({ length: 65 }, () => connectFrame(Buffer.alloc(0))));
		const primary = openStreamResponse([ignoredFrames]);
		const fallback = openStreamResponse([ignoredFrames]);
		const streams = [primary, fallback];
		const fetch: FetchImpl = async input => {
			const url = String(input);
			if (url === `${BACKEND}/sand-box/inference-credential`) {
				return new Response(JSON.stringify({ grokBotToken: "synthetic-minted-token" }), { status: 200 });
			}
			if (url === `${BACKEND}${STREAM_PATH}`) {
				const stream = streams.shift();
				if (stream) return stream.response;
			}
			throw new Error(`unexpected inference request: ${url}`);
		};

		expect(await verifyInference("synthetic-renewal", "synthetic-machine", { fetch })).toEqual({
			ok: false,
			detail: "inference stream exceeded verification response budget",
		});
		expect(primary.cancelled()).toBeTrue();
		expect(fallback.cancelled()).toBeTrue();
	});

	it("rejects ignored Connect bytes beyond the aggregate verifier budget", async () => {
		// Well-formed unknown protobuf field with a 1,019-byte nested payload.
		const ignoredPayload = Buffer.concat([Buffer.from([0x52, 0xfe, 0x07, 0x52, 0xfb, 0x07]), Buffer.alloc(1_019)]);
		const ignoredFrames = Buffer.concat(Array.from({ length: 64 }, () => connectFrame(ignoredPayload)));
		const primary = openStreamResponse([ignoredFrames]);
		const fallback = openStreamResponse([ignoredFrames]);
		const streams = [primary, fallback];
		const fetch: FetchImpl = async input => {
			const url = String(input);
			if (url === `${BACKEND}/sand-box/inference-credential`) {
				return new Response(JSON.stringify({ grokBotToken: "synthetic-minted-token" }), { status: 200 });
			}
			if (url === `${BACKEND}${STREAM_PATH}`) {
				const stream = streams.shift();
				if (stream) return stream.response;
			}
			throw new Error(`unexpected inference request: ${url}`);
		};

		expect(await verifyInference("synthetic-renewal", "synthetic-machine", { fetch })).toEqual({
			ok: false,
			detail: "inference stream exceeded verification response budget",
		});
		expect(primary.cancelled()).toBeTrue();
		expect(fallback.cancelled()).toBeTrue();
	});

	it("uses the exchanged account bearer for every RPC after rejected registration", async () => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, "fetch").mockImplementation((() => {
			throw new Error("Grok Bot login bypassed callbacks.fetch");
		}) as unknown as typeof fetch);

		const accountCalls: Array<{ path: string; authorization: string | null }> = [];
		const authStarted = Promise.withResolvers<void>();
		const fetchMock: FetchImpl = async (input, init) => {
			const url = new URL(String(input));
			const authorization = new Headers(init?.headers).get("authorization");
			if (url.origin === BACKEND) accountCalls.push({ path: url.pathname, authorization });

			switch (url.pathname) {
				case "/auth/poll":
					return new Response(
						JSON.stringify({
							accessToken: "synthetic-rejected-account-bearer",
							refreshToken: "synthetic-refresh-user-api-key",
						}),
						{ status: 200 },
					);
				case "/aiserver.v1.DashboardService/RegisterSandMachine":
					return authorization === "Bearer synthetic-rejected-account-bearer"
						? new Response("rejected", { status: 401 })
						: new Response("{}", { status: 200 });
				case "/auth/exchange_user_api_key":
					expect(authorization).toBe("Bearer synthetic-refresh-user-api-key");
					return new Response(JSON.stringify({ accessToken: "synthetic-exchanged-account-bearer" }), {
						status: 200,
					});
				case "/aiserver.v1.DashboardService/ListSandMachines":
					return new Response(JSON.stringify({ machines: [{ machineId: "synthetic-machine" }] }), { status: 200 });
				case "/aiserver.v1.GrokBotService/EnsureSandBox":
					return new Response(
						JSON.stringify({
							networkToken: "network-for-test",
							execDaemonUrl: "https://exec.grokbot.test",
							execDaemonAuthToken: "local",
						}),
						{ status: 200 },
					);
				case "/sand-box/inference-credential":
					return new Response(JSON.stringify({ grokBotToken: "synthetic-minted-token" }), { status: 200 });
				case STREAM_PATH:
					return streamResponse([COMPLETE_INFERENCE_STREAM]);
				case "/agent.v1.ExecService/Exec":
					expect(url.origin).toBe("https://exec.grokbot.test");
					expect(authorization).toBe("Bearer local");
					return new Response("sbi_synthetic_renewal_primary");
				default:
					throw new Error(`unexpected Grok Bot login request: ${url}`);
			}
		};

		const callbacks: OAuthController = {
			onAuth: () => authStarted.resolve(),
			fetch: fetchMock,
			grokbotMachineId: {
				read: () => "synthetic-machine",
				write: machineId => expect(machineId).toBe("synthetic-machine"),
			},
		};
		const login = loginGrokbotFlow(callbacks);
		await authStarted.promise;
		vi.advanceTimersByTime(1_000);
		const credentials = await login;

		expect(credentials).toMatchObject({
			access: "sbi_synthetic_renewal_primary",
			refresh: "synthetic-refresh-user-api-key",
			orgId: "synthetic-machine",
		});
		expect(accountCalls).toEqual([
			{ path: "/auth/poll", authorization: null },
			{
				path: "/aiserver.v1.DashboardService/RegisterSandMachine",
				authorization: "Bearer synthetic-rejected-account-bearer",
			},
			{ path: "/auth/exchange_user_api_key", authorization: "Bearer synthetic-refresh-user-api-key" },
			{
				path: "/aiserver.v1.DashboardService/RegisterSandMachine",
				authorization: "Bearer synthetic-exchanged-account-bearer",
			},
			{
				path: "/aiserver.v1.DashboardService/ListSandMachines",
				authorization: "Bearer synthetic-exchanged-account-bearer",
			},
			{
				path: "/aiserver.v1.GrokBotService/EnsureSandBox",
				authorization: "Bearer synthetic-exchanged-account-bearer",
			},
			{ path: "/sand-box/inference-credential", authorization: null },
			{ path: STREAM_PATH, authorization: "Bearer synthetic-minted-token" },
		]);
	});

	it("signs the refresh exchange with the stored machine checksum", async () => {
		const machineId = "synthetic-refresh-machine";
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
			const url = new URL(String(input));
			switch (url.pathname) {
				case "/auth/exchange_user_api_key":
					expect(new Headers(init?.headers).get("x-cursor-checksum")).toBe(createGrokbotChecksum(machineId));
					return new Response(JSON.stringify({ accessToken: "refreshed-account-bearer" }), { status: 200 });
				case "/aiserver.v1.GrokBotService/EnsureSandBox":
					return new Response(
						JSON.stringify({
							networkToken: "network-for-refresh",
							execDaemonUrl: "https://exec.grokbot.test",
							execDaemonAuthToken: "local",
						}),
						{ status: 200 },
					);
				case "/agent.v1.ExecService/Exec":
					return new Response("sbi_synthetic_renewal_secondary");
				case "/sand-box/inference-credential":
					return new Response(JSON.stringify({ grokBotToken: "synthetic-refreshed-token" }), { status: 200 });
				case STREAM_PATH:
					return streamResponse([COMPLETE_INFERENCE_STREAM]);
				default:
					throw new Error(`unexpected Grok Bot refresh request: ${url}`);
			}
		}) as typeof fetch);

		const refreshed = await refreshGrokbotFlow({
			access: "sbi_synthetic_renewal_primary",
			refresh: "synthetic-refresh-user-api-key",
			expires: Date.now(),
			orgId: machineId,
		});

		expect(refreshed).toMatchObject({
			access: "sbi_synthetic_renewal_secondary",
			refresh: "synthetic-refresh-user-api-key",
			orgId: machineId,
		});
	});

	it("redacts a rejected account bearer from registration errors", async () => {
		vi.useFakeTimers();
		const rejectedBearer = "synthetic-rejected-account-bearer";
		let errorBodyCancelled = false;
		const authStarted = Promise.withResolvers<void>();
		const fetchMock: FetchImpl = async input => {
			const url = new URL(String(input));
			if (url.pathname === "/auth/poll") {
				return new Response(JSON.stringify({ accessToken: rejectedBearer }), { status: 200 });
			}
			if (url.pathname === "/aiserver.v1.DashboardService/RegisterSandMachine") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(Buffer.from(`Bearer ${rejectedBearer} was rejected `));
							controller.enqueue(Buffer.alloc(64 * 1024, 0x61));
						},
						cancel() {
							errorBodyCancelled = true;
						},
					}),
					{ status: 401 },
				);
			}
			throw new Error(`unexpected Grok Bot login request: ${url}`);
		};

		const login = loginGrokbotFlow({ onAuth: () => authStarted.resolve(), fetch: fetchMock });
		await authStarted.promise;
		vi.advanceTimersByTime(1_000);
		const error = await login.catch(reason => reason);
		if (!(error instanceof Error)) throw new Error("expected login failure");
		expect(error.message).toContain("[redacted]");
		expect(error.message).not.toContain(rejectedBearer);
		expect(errorBodyCancelled).toBeTrue();
	});

	it("falls back to the bounded raw RPC body when error details are malformed", async () => {
		vi.useFakeTimers();
		const authStarted = Promise.withResolvers<void>();
		const malformed = JSON.stringify({
			details: [{ debug: { details: { detail: {}, title: 42 }, error: {} } }],
			error: {},
			message: [],
		});
		const fetch: FetchImpl = async input => {
			const url = new URL(String(input));
			if (url.pathname === "/auth/poll") return new Response(JSON.stringify({ accessToken: "account-token" }));
			if (url.pathname === "/aiserver.v1.DashboardService/RegisterSandMachine") {
				return new Response(malformed, { status: 401 });
			}
			throw new Error(`unexpected Grok Bot login request: ${url}`);
		};

		const login = loginGrokbotFlow({ onAuth: () => authStarted.resolve(), fetch });
		await authStarted.promise;
		vi.advanceTimersByTime(1_000);
		const error = await login.catch(reason => reason);
		if (!(error instanceof Error)) throw new Error("expected login failure");
		expect(error.message).toBe(`Machine registration failed: ${malformed}`);
	});
});
