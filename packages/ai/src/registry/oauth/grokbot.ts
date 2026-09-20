/**
 * `/login grokbot` — self-contained Grok Bot sign-in.
 *
 * Walks the same flow the Grok Bot desktop app uses, entirely inside omp — no
 * secrets file, no manual steps:
 *
 *   1. browser:  cursor.com/loginDeepControl (PKCE, redirectTarget=sand)
 *   2. poll:     api2.cursor.sh/auth/poll → OAuth account token
 *   3. register: DashboardService/RegisterSandMachine → machine id
 *   4. bootstrap: EnsureSandBox → exec daemon reads the pod-scoped
 *                 SAND_INFERENCE_RENEWAL_CREDENTIAL out of box process env
 *   5. verify:   mint an inference token from the renewer and prove it drives
 *                 InferenceService/Stream
 *
 * Stored credential shape (`auth.json` `grokbot` OAuth row):
 *   access  = renewal credential (`sbi_…`) — long-lived, mints inference JWTs
 *   refresh = OAuth refresh token — proves the grant; refresh re-runs bootstrap
 *   expires = account token expiry (epoch ms); gates re-login only — the
 *             renewer itself has no clock lifetime
 *   orgId   = machine id (stable client-owned id needed for
 *             `x-cursor-checksum`; unused by any other grokbot code path)
 */
import { hostname } from "node:os";
import { GROKBOT_INFERENCE_PROBE_MODEL_IDS } from "@oh-my-pi/pi-catalog/provider-models/grokbot";
import * as AIError from "../../error";
import { createGrokbotChecksum, GROKBOT_BACKEND } from "../../providers/grokbot/auth";
import { readBoundedGrokbotResponseText, redactGrokbotSecrets } from "../../providers/grokbot/body";
import {
	CONNECT_END_STREAM_FLAG,
	ConnectFrameReader,
	frameConnectProto,
	parseEndStreamTrailer,
} from "../../providers/grokbot/connect";
import { decodeInferenceStreamResponse, encodeInferenceStreamRequest } from "../../providers/grokbot/wire";
import type { FetchImpl } from "../../types";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";
import inferenceProbePrompt from "./grokbot-inference-probe.md" with { type: "text" };

const BACKEND = GROKBOT_BACKEND;
const WEBSITE = "https://cursor.com";
const CLIENT_VERSION = "0.30.0";
const NAMESPACE = "prod";
const ENSURE_SANDBOX_PATH = "/aiserver.v1.GrokBotService/EnsureSandBox";
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF = 1.2;
const GROKBOT_OAUTH_REMOTE_TIMEOUT_MS = 30_000;
const INFERENCE_PROBE_REPLY = "pong42";
const INFERENCE_PROBE_PROMPT = inferenceProbePrompt.trim();
const INFERENCE_VERIFICATION_TIMEOUT_MS = 15_000;
const INFERENCE_VERIFICATION_MAX_CONNECT_BYTES = 64 * 1024;
const INFERENCE_VERIFICATION_MAX_CONNECT_FRAMES = 64;

// ---------------------------------------------------------------------------
// Account RPCs (Connect JSON unary, sand client headers)
// ---------------------------------------------------------------------------

function sandHeaders(token: string | undefined, machineId?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-cursor-client-type": "sand",
		"x-cursor-client-version": CLIENT_VERSION,
		"x-sand-box-namespace": NAMESPACE,
		"x-ghost-mode": "true",
	};
	if (machineId) headers["x-cursor-checksum"] = createGrokbotChecksum(machineId);
	if (token) headers.authorization = `Bearer ${token}`;
	return headers;
}

interface GrokbotRequestOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AIError.LoginCancelledError();
}

async function cancelResponseBody(response: Response | undefined): Promise<void> {
	await response?.body?.cancel().catch(() => {});
}

function awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) return Promise.reject(signal.reason);
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = () => {
		signal.removeEventListener("abort", onAbort);
		reject(signal.reason);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	void operation.then(
		value => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		error => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		},
	);
	return promise;
}

interface GrokbotRequestDeadline {
	signal: AbortSignal;
	timedOut(): boolean;
	dispose(): void;
}

function createGrokbotRequestDeadline(callerSignal: AbortSignal | undefined): GrokbotRequestDeadline {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), GROKBOT_OAUTH_REMOTE_TIMEOUT_MS);
	return {
		signal: callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal,
		timedOut: () => deadline.signal.aborted,
		dispose: () => {
			clearTimeout(timer);
			deadline.abort();
		},
	};
}

function inferenceVerificationTimeout(): { ok: false; detail: string } {
	return { ok: false, detail: "inference verification timed out" };
}

function inferenceVerificationBudgetExceeded(): { ok: false; detail: string } {
	return { ok: false, detail: "inference stream exceeded verification response budget" };
}

function sleepForPoll(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	throwIfCancelled(signal);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = () => {
		clearTimeout(timer);
		reject(new AIError.LoginCancelledError());
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, delayMs);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

interface RpcResult {
	ok: boolean;
	status: number;
	data: Record<string, unknown>;
	detail: string;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

async function rpc(
	servicePath: string,
	body: unknown,
	token: string | undefined,
	machineId?: string,
	options: GrokbotRequestOptions = {},
): Promise<RpcResult> {
	const deadline = createGrokbotRequestDeadline(options.signal);
	let response: Response | undefined;
	let text = "";
	try {
		throwIfCancelled(options.signal);
		response = await awaitAbortable(
			(options.fetch ?? fetch)(`${BACKEND}${servicePath}`, {
				method: "POST",
				headers: sandHeaders(token, machineId),
				body: JSON.stringify(body),
				signal: deadline.signal,
			}),
			deadline.signal,
		);
		text = (await readBoundedGrokbotResponseText(response, undefined, deadline.signal)).text;
		throwIfCancelled(options.signal);
		if (response.ok) {
			try {
				return { ok: true, status: response.status, data: JSON.parse(text) as Record<string, unknown>, detail: "" };
			} catch {
				return { ok: true, status: response.status, data: {}, detail: "" };
			}
		}
		let detail = text.slice(0, 200);
		try {
			const parsed = objectRecord(JSON.parse(text));
			const firstDetail = Array.isArray(parsed?.details) ? objectRecord(parsed.details[0]) : undefined;
			const debug = objectRecord(firstDetail?.debug);
			const debugDetails = objectRecord(debug?.details);
			for (const candidate of [
				debugDetails?.detail,
				debugDetails?.title,
				debug?.error,
				parsed?.error,
				parsed?.message,
			]) {
				if (typeof candidate === "string") {
					detail = candidate;
					break;
				}
			}
		} catch {
			/* keep raw text */
		}
		return {
			ok: false,
			status: response.status,
			data: {},
			detail: redactGrokbotSecrets(detail, [token]),
		};
	} catch {
		await cancelResponseBody(response);
		throwIfCancelled(options.signal);
		return { ok: false, status: 0, data: {}, detail: deadline.timedOut() ? "request timed out" : "request failed" };
	} finally {
		deadline.dispose();
	}
}

function pick(data: Record<string, unknown>, ...keys: string[]): string | undefined {
	const camel = (value: string) => value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
	for (const key of keys) {
		const value = data[key];
		if (typeof value === "string" && value) return value;
		const nested = data[camel(key)];
		if (typeof nested === "string" && nested) return nested;
	}
	return undefined;
}

function accountTokenExpiryMs(token: string): number {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { exp?: number };
		if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) return payload.exp * 1000;
	} catch {
		/* fall through */
	}
	return Date.now() + 30 * 24 * 60 * 60 * 1000;
}

function hostnameSlug(): string {
	return (
		hostname()
			.replace(/[^A-Za-z0-9_-]/g, "-")
			.slice(0, 40) || "omp"
	);
}

// ---------------------------------------------------------------------------
// Exec daemon bootstrap (reads the renewer out of box process environment)
// ---------------------------------------------------------------------------

function protoVarint(value: number): number[] {
	const out: number[] = [];
	let n = value >>> 0;
	while (n > 0x7f) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	out.push(n);
	return out;
}

function protoString(fieldNo: number, value: string): number[] {
	const bytes = [...new TextEncoder().encode(value)];
	return [...protoVarint((fieldNo << 3) | 2), ...protoVarint(bytes.length), ...bytes];
}

function protoMessage(fieldNo: number, payload: number[]): number[] {
	return [...protoVarint((fieldNo << 3) | 2), ...protoVarint(payload.length), ...payload];
}

function protoVarintField(fieldNo: number, value: number): number[] {
	return [...protoVarint((fieldNo << 3) | 0), ...protoVarint(value)];
}

/**
 * One Connect-protobuf `ExecService/Exec` round trip against the box's exec
 * daemon. `authToken` is the `execDaemonAuthToken` EnsureSandBox hands out
 * (shipped value: "local" — a routing value, not a secret);
 * `networkToken` scopes the request.
 */
async function execInBox(
	execDaemonUrl: string,
	networkToken: string,
	authToken: string,
	execId: string,
	command: string,
	options: GrokbotRequestOptions = {},
): Promise<string> {
	// ExecServerMessage { 13: id=1, 15: exec_id, 2: ShellArgs }
	// ShellArgs { 1: command, 8: parsing_result { 2: ExecutableCommand { 1: name, 3: full_text } } }
	const executable = [...protoString(1, command), ...protoString(3, command)];
	const parsingResult = protoMessage(2, executable);
	const shellArgs = [...protoString(1, command), ...protoMessage(8, parsingResult)];
	const message = [...protoVarintField(13, 1), ...protoString(15, execId), ...protoMessage(2, shellArgs)];
	const envelope = Buffer.concat([
		Buffer.from([0x00]),
		(() => {
			const length = Buffer.alloc(4);
			length.writeUInt32BE(message.length);
			return length;
		})(),
		Buffer.from(message),
	]);
	const deadline = createGrokbotRequestDeadline(options.signal);
	try {
		let response: Response | undefined;
		try {
			throwIfCancelled(options.signal);
			response = await awaitAbortable(
				(options.fetch ?? fetch)(`${execDaemonUrl}/agent.v1.ExecService/Exec`, {
					method: "POST",
					headers: {
						"content-type": "application/connect+proto",
						accept: "application/connect+proto",
						"connect-protocol-version": "1",
						authorization: `Bearer ${authToken}`,
						"x-anyrun-network-token": networkToken,
					},
					body: new Uint8Array(envelope),
					signal: deadline.signal,
				}),
				deadline.signal,
			);
			throwIfCancelled(options.signal);
		} catch {
			await cancelResponseBody(response);
			throwIfCancelled(options.signal);
			throw new AIError.OAuthError(deadline.timedOut() ? "Box exec request timed out" : "Box exec request failed", {
				kind: deadline.timedOut() ? "timeout" : "polling",
				provider: "grokbot",
			});
		}
		if (!response) {
			throw new AIError.OAuthError("Box exec request failed", {
				kind: "polling",
				provider: "grokbot",
			});
		}
		if (!response.ok) {
			await cancelResponseBody(response);
			throw new AIError.OAuthError(`Box exec failed (HTTP ${response.status})`, {
				kind: "polling",
				provider: "grokbot",
				status: response.status,
			});
		}

		let output: string;
		try {
			const body = await readBoundedGrokbotResponseText(response, undefined, deadline.signal);
			if (body.truncated) throw new Error("Box exec response exceeded the body limit");
			output = body.text;
			throwIfCancelled(options.signal);
		} catch {
			await cancelResponseBody(response);
			throwIfCancelled(options.signal);
			throw new AIError.OAuthError(
				deadline.timedOut() ? "Box exec response timed out" : "Box exec response could not be read",
				{
					kind: deadline.timedOut() ? "timeout" : "polling",
					provider: "grokbot",
				},
			);
		}
		const printable = output.replace(/[^\x20-\x7e]/g, " ");
		const match = printable.match(/sbi_[A-Za-z0-9_-]{20,}/);
		if (!match) {
			throw new AIError.OAuthError("Box exec succeeded but the environment carries no renewal credential", {
				kind: "polling",
				provider: "grokbot",
			});
		}
		return match[0];
	} finally {
		deadline.dispose();
	}
}

// ---------------------------------------------------------------------------
// Inference verification (proves the renewer actually drives the wire)
// ---------------------------------------------------------------------------

export async function verifyInference(
	renewal: string,
	machineId: string,
	options: GrokbotRequestOptions = {},
): Promise<{ ok: boolean; detail: string }> {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), INFERENCE_VERIFICATION_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
	try {
		return await verifyInferenceWithinDeadline(
			renewal,
			machineId,
			{ ...options, signal },
			options.signal,
			deadline.signal,
		);
	} finally {
		clearTimeout(timer);
		deadline.abort();
	}
}

async function verifyInferenceWithinDeadline(
	renewal: string,
	machineId: string,
	options: GrokbotRequestOptions,
	callerSignal: AbortSignal | undefined,
	deadlineSignal: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
	let mint: Response | undefined;
	try {
		throwIfCancelled(callerSignal);
		if (deadlineSignal.aborted) return inferenceVerificationTimeout();
		mint = await awaitAbortable(
			(options.fetch ?? fetch)(`${BACKEND}/sand-box/inference-credential`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ credential: renewal }),
				signal: options.signal,
			}),
			options.signal,
		);
		throwIfCancelled(callerSignal);
		if (deadlineSignal.aborted) {
			await cancelResponseBody(mint);
			return inferenceVerificationTimeout();
		}
	} catch {
		await cancelResponseBody(mint);
		throwIfCancelled(callerSignal);
		if (deadlineSignal.aborted) return inferenceVerificationTimeout();
		return { ok: false, detail: "renewer mint request failed" };
	}
	if (!mint) return { ok: false, detail: "renewer mint request failed" };
	if (!mint.ok) {
		await cancelResponseBody(mint);
		return { ok: false, detail: `renewer mint failed (HTTP ${mint.status})` };
	}
	let minted: { grokBotToken?: string };
	try {
		const body = await awaitAbortable(
			readBoundedGrokbotResponseText(mint, undefined, options.signal),
			options.signal,
		);
		if (body.truncated) throw new Error("Mint response exceeded the body limit");
		minted = JSON.parse(body.text) as { grokBotToken?: string };
		throwIfCancelled(callerSignal);
		if (deadlineSignal.aborted) return inferenceVerificationTimeout();
	} catch {
		await cancelResponseBody(mint);
		throwIfCancelled(callerSignal);
		if (deadlineSignal.aborted) return inferenceVerificationTimeout();
		return { ok: false, detail: "renewer mint returned an invalid response" };
	}
	const token = minted.grokBotToken;
	if (!token) return { ok: false, detail: "renewer mint returned no grokBotToken" };

	// Probe the KDL-owned routed default first, then its verified concrete
	// fallback. The catalog remains the single owner of those identities.
	let lastDetail = "";
	for (const modelId of GROKBOT_INFERENCE_PROBE_MODEL_IDS) {
		const result = await verifyInferenceWithModel(token, modelId, machineId, options, callerSignal, deadlineSignal);
		if (result.ok) return result;
		lastDetail = redactGrokbotSecrets(result.detail, [token]);
		throwIfCancelled(callerSignal);
		if (deadlineSignal.aborted) return inferenceVerificationTimeout();
	}
	return { ok: false, detail: lastDetail };
}

async function verifyInferenceWithModel(
	token: string,
	modelId: string,
	machineId: string,
	options: GrokbotRequestOptions,
	callerSignal: AbortSignal | undefined,
	deadlineSignal: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
	const requestBytes = encodeInferenceStreamRequest({
		messages: [{ role: 1, text: INFERENCE_PROBE_PROMPT }],
		requestedModel: { modelId },
		invocationId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
	});
	let stream: Response | undefined;
	try {
		throwIfCancelled(callerSignal);
		if (deadlineSignal.aborted) return inferenceVerificationTimeout();
		stream = await awaitAbortable(
			(options.fetch ?? fetch)(`${BACKEND}/aiserver.v1.InferenceService/Stream`, {
				method: "POST",
				headers: {
					"content-type": "application/connect+proto",
					accept: "application/connect+proto",
					"connect-protocol-version": "1",
					"x-cursor-client-type": "sand",
					"x-cursor-client-version": CLIENT_VERSION,
					"x-sand-box-namespace": NAMESPACE,
					"x-ghost-mode": "true",
					"x-request-id": crypto.randomUUID(),
					authorization: `Bearer ${token}`,
					"x-cursor-checksum": createGrokbotChecksum(machineId),
				},
				body: frameConnectProto(requestBytes),
				signal: options.signal,
			}),
			options.signal,
		);
		throwIfCancelled(callerSignal);
		if (deadlineSignal.aborted) {
			await cancelResponseBody(stream);
			return inferenceVerificationTimeout();
		}
	} catch {
		await cancelResponseBody(stream);
		throwIfCancelled(callerSignal);
		if (deadlineSignal.aborted) return inferenceVerificationTimeout();
		return { ok: false, detail: "inference request failed" };
	}
	if (!stream) return { ok: false, detail: "inference request failed" };
	if (!stream.ok || !stream.body) {
		await cancelResponseBody(stream);
		return { ok: false, detail: `inference stream rejected the minted token (HTTP ${stream.status})` };
	}
	const reader = new ConnectFrameReader({ maxPayload: INFERENCE_VERIFICATION_MAX_CONNECT_BYTES });
	const chunkReader = stream.body.getReader();
	let reply = "";
	let sawEndStream = false;
	let connectBytes = 0;
	let connectFrames = 0;
	try {
		streamRead: for (;;) {
			throwIfCancelled(callerSignal);
			if (deadlineSignal.aborted) return inferenceVerificationTimeout();
			const { done, value } = await awaitAbortable(chunkReader.read(), options.signal);
			if (done) {
				if (reader.buffered > 0) {
					return { ok: false, detail: "inference stream ended with a truncated Connect frame" };
				}
				return { ok: false, detail: "inference stream ended without a Connect end-stream trailer" };
			}
			for (const frame of reader.push(value)) {
				connectFrames++;
				connectBytes += 5 + frame.bytes.byteLength;
				if (connectBytes > INFERENCE_VERIFICATION_MAX_CONNECT_BYTES) return inferenceVerificationBudgetExceeded();
				if (connectFrames > INFERENCE_VERIFICATION_MAX_CONNECT_FRAMES) return inferenceVerificationBudgetExceeded();
				if (frame.flags & CONNECT_END_STREAM_FLAG) {
					sawEndStream = true;
					if (parseEndStreamTrailer(frame.bytes).error) {
						return { ok: false, detail: "inference stream returned a Connect error" };
					}
					break streamRead;
				}
				for (const part of decodeInferenceStreamResponse(frame.bytes)) {
					switch (part.kind) {
						case "text":
							if (
								part.text.length > INFERENCE_PROBE_REPLY.length - reply.length ||
								!INFERENCE_PROBE_REPLY.startsWith(reply + part.text)
							) {
								return { ok: false, detail: "inference stream returned an unexpected reply" };
							}
							reply += part.text;
							break;
						case "responseInfo":
							if (part.errorMessage) {
								return {
									ok: false,
									detail: `inference stream returned an in-band error: ${redactGrokbotSecrets(part.errorMessage, [token])}`,
								};
							}
							break;
						case "error":
							return {
								ok: false,
								detail: `inference stream returned an in-band error: ${redactGrokbotSecrets(
									part.message || part.code || "unknown error",
									[token],
								)}`,
							};
						default:
							break;
					}
				}
			}
			if (connectBytes + reader.buffered > INFERENCE_VERIFICATION_MAX_CONNECT_BYTES) {
				return inferenceVerificationBudgetExceeded();
			}
		}
	} catch {
		throwIfCancelled(callerSignal);
		if (deadlineSignal.aborted) return inferenceVerificationTimeout();
		return { ok: false, detail: "inference stream had invalid Connect framing" };
	} finally {
		await chunkReader.cancel().catch(() => {});
		chunkReader.releaseLock();
	}
	return sawEndStream && reply === INFERENCE_PROBE_REPLY
		? { ok: true, detail: "inference verified" }
		: { ok: false, detail: "inference stream completed without the expected reply" };
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

async function pollAccountToken(
	uuid: string,
	verifier: string,
	options: GrokbotRequestOptions,
): Promise<{ accessToken: string; refreshToken: string }> {
	let delay = POLL_BASE_DELAY_MS;
	let consecutiveErrors = 0;
	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		throwIfCancelled(options.signal);
		await sleepForPoll(delay, options.signal);
		throwIfCancelled(options.signal);
		const deadline = createGrokbotRequestDeadline(options.signal);
		let response: Response | undefined;
		try {
			response = await awaitAbortable(
				(options.fetch ?? fetch)(
					`${BACKEND}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
					{ signal: deadline.signal },
				),
				deadline.signal,
			);
			throwIfCancelled(options.signal);
			if (response.status === 404) {
				// Not approved yet.
				await cancelResponseBody(response);
				consecutiveErrors = 0;
				delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
				continue;
			}
			if (response.status >= 500) {
				await cancelResponseBody(response);
				consecutiveErrors = 0;
				delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
				continue;
			}
			if (!response.ok) {
				await cancelResponseBody(response);
				throw new AIError.OAuthError(`Grok Bot sign-in poll failed (HTTP ${response.status})`, {
					kind: "polling",
					provider: "grokbot",
					status: response.status,
				});
			}
			const body = await readBoundedGrokbotResponseText(response, undefined, deadline.signal);
			if (body.truncated) throw new Error("Grok Bot sign-in poll response exceeded the body limit");
			const data = JSON.parse(body.text) as { accessToken?: string; refreshToken?: string };
			throwIfCancelled(options.signal);
			const accessToken = data.accessToken ?? "";
			if (!accessToken) {
				throw new AIError.OAuthError("Grok Bot sign-in returned no access token", {
					kind: "validation",
					provider: "grokbot",
				});
			}
			return { accessToken, refreshToken: data.refreshToken ?? "" };
		} catch (error) {
			await cancelResponseBody(response);
			if (error instanceof AIError.OAuthError) throw error;
			throwIfCancelled(options.signal);
			consecutiveErrors++;
			if (consecutiveErrors >= 3) {
				throw new AIError.OAuthError("Too many consecutive errors during Grok Bot auth polling", {
					kind: "polling",
					provider: "grokbot",
				});
			}
			delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
		} finally {
			deadline.dispose();
		}
	}
	throw new AIError.OAuthError("Grok Bot authentication polling timeout", {
		kind: "timeout",
		provider: "grokbot",
	});
}

/**
 * Full login: browser sign-in → machine registration → box bootstrap (exec
 * daemon reads the renewer from the box environment) → inference verification.
 */
export async function loginGrokbotFlow(callbacks: OAuthController): Promise<OAuthCredentials> {
	if (callbacks.signal?.aborted) throw new AIError.LoginCancelledError();
	if (!callbacks.onAuth) throw new AIError.OnPromptRequiredError("Grok Bot");

	// --- 1. browser sign-in ---------------------------------------------------
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();
	const loginUrl = new URL("/loginDeepControl", WEBSITE);
	loginUrl.searchParams.set("challenge", challenge);
	loginUrl.searchParams.set("uuid", uuid);
	loginUrl.searchParams.set("mode", "login");
	loginUrl.searchParams.set("redirectTarget", "sand");
	loginUrl.searchParams.set("supportsSelectedTeamLogin", "true");

	callbacks.onAuth({
		url: loginUrl.toString(),
		instructions: "Sign in with the Cursor account that holds your Grok Bot plan.",
	});
	callbacks.onProgress?.("Waiting for browser authentication…");

	// --- 2. poll ----------------------------------------------------------------
	const requestOptions: GrokbotRequestOptions = { fetch: callbacks.fetch ?? fetch, signal: callbacks.signal };
	const { accessToken, refreshToken } = await pollAccountToken(uuid, verifier, requestOptions);
	callbacks.onProgress?.("Signed in. Registering machine…");

	// --- 3. register the machine ------------------------------------------------
	// The machine id is client-owned: reuse the id persisted for this install
	// when present (idempotent re-registration just refreshes the label), and
	// only generate a fresh UUID on a genuinely new install.
	const machineId = callbacks.grokbotMachineId?.read() ?? crypto.randomUUID();
	const label = `omp-${hostnameSlug()}`;
	const register = async (token: string) =>
		rpc("/aiserver.v1.DashboardService/RegisterSandMachine", { label }, token, machineId, requestOptions);
	let accountToken = accessToken;
	let registration = await register(accountToken);
	if (!registration.ok && refreshToken && (registration.status === 401 || registration.status === 403)) {
		// The exchange endpoint authenticates with the refresh token ("User API
		// Key") and returns a longer-lived bearer; retry with it.
		const exchange = await rpc("/auth/exchange_user_api_key", {}, refreshToken, machineId, requestOptions);
		const exchanged = exchange.ok ? pick(exchange.data, "accessToken", "access_token") : undefined;
		if (exchanged) {
			accountToken = exchanged;
			registration = await register(accountToken);
		}
	}
	if (!registration.ok) {
		throw new AIError.OAuthError(
			`Machine registration failed: ${registration.detail || `HTTP ${registration.status}`}`,
			{
				kind: "polling",
				provider: "grokbot",
				status: registration.status,
			},
		);
	}
	// Verify the checksum id actually registered (idempotent re-login: the same
	// machine id simply re-registers under omp's label).
	const machines = await rpc(
		"/aiserver.v1.DashboardService/ListSandMachines",
		{},
		accountToken,
		machineId,
		requestOptions,
	);
	const registered = machines.ok
		? ((machines.data.machines as Array<{ machineId?: string }> | undefined) ?? []).some(
				entry => entry.machineId === machineId,
			)
		: false;
	if (!registered) {
		throw new AIError.OAuthError("Machine registration did not take effect (id missing from roster)", {
			kind: "validation",
			provider: "grokbot",
		});
	}
	callbacks.onProgress?.("Machine registered. Bootstrapping the box…");

	// --- 4. box bootstrap: read the renewer from the box environment -------------
	const ensure = await rpc(ENSURE_SANDBOX_PATH, {}, accountToken, machineId, requestOptions);
	if (!ensure.ok) {
		throw new AIError.OAuthError(`Box provisioning failed: ${ensure.detail || `HTTP ${ensure.status}`}`, {
			kind: "polling",
			provider: "grokbot",
			status: ensure.status,
		});
	}
	const networkToken = pick(ensure.data, "networkToken", "network_token");
	const execDaemonUrl = pick(ensure.data, "execDaemonUrl", "exec_daemon_url");
	const execAuthToken = pick(ensure.data, "execDaemonAuthToken", "exec_daemon_auth_token") ?? "local";
	if (!networkToken || !execDaemonUrl) {
		throw new AIError.OAuthError("EnsureSandBox returned an incomplete box descriptor", {
			kind: "validation",
			provider: "grokbot",
		});
	}
	const renewal = await execInBox(
		execDaemonUrl,
		networkToken,
		execAuthToken,
		`omp-${uuid.slice(0, 8)}`,
		"grep -aoh 'sbi_[A-Za-z0-9_-]*' /proc/[0-9]*/environ 2>/dev/null | head -1",
		requestOptions,
	);
	callbacks.onProgress?.("Renewal credential extracted. Verifying inference…");

	// --- 5. verify the renewer end-to-end ----------------------------------------
	const verdict = await verifyInference(renewal, machineId, requestOptions);
	if (!verdict.ok) {
		throw new AIError.OAuthError(`Grok Bot credential verification failed: ${verdict.detail}`, {
			kind: "validation",
			provider: "grokbot",
		});
	}
	callbacks.onProgress?.("Grok Bot ready.");
	callbacks.grokbotMachineId?.write(machineId);

	return {
		access: renewal,
		refresh: refreshToken || accessToken,
		expires: accountTokenExpiryMs(accountToken),
		orgId: machineId,
	};
}

/**
 * Refresh: re-run bootstrap against the stored account identity. The stored
 * `refresh` token re-authenticates the account RPCs; the renewer itself does
 * not expire, so refresh is only needed when the box was recreated with a new
 * pod (new `sbi_…`) or the stored one was revoked.
 */
export async function refreshGrokbotFlow(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (signal?.aborted) throw new AIError.LoginCancelledError();
	const machineId = credentials.orgId;
	if (!machineId) {
		throw new AIError.OAuthError("Stored Grok Bot credential has no machine id; sign in again", {
			kind: "validation",
			provider: "grokbot",
		});
	}

	// Re-authenticate the account with the refresh token (same exchange the
	// login flow uses when the poll token is rejected).
	const requestOptions: GrokbotRequestOptions = { signal };
	const exchange = await rpc("/auth/exchange_user_api_key", {}, credentials.refresh, machineId, requestOptions);
	const accountToken = exchange.ok ? pick(exchange.data, "accessToken", "access_token") : undefined;
	if (!accountToken) {
		throw new AIError.OAuthError(
			`Grok Bot account token refresh failed (${exchange.detail || `HTTP ${exchange.status}`}); sign in again`,
			{ kind: "token-exchange", provider: "grokbot", status: exchange.status },
		);
	}

	const ensure = await rpc(ENSURE_SANDBOX_PATH, {}, accountToken, machineId, requestOptions);
	if (!ensure.ok) {
		throw new AIError.OAuthError(`Box provisioning failed: ${ensure.detail || `HTTP ${ensure.status}`}`, {
			kind: "polling",
			provider: "grokbot",
			status: ensure.status,
		});
	}
	const networkToken = pick(ensure.data, "networkToken", "network_token");
	const execDaemonUrl = pick(ensure.data, "execDaemonUrl", "exec_daemon_url");
	const execAuthToken = pick(ensure.data, "execDaemonAuthToken", "exec_daemon_auth_token") ?? "local";
	if (!networkToken || !execDaemonUrl) {
		throw new AIError.OAuthError("EnsureSandBox returned an incomplete box descriptor", {
			kind: "validation",
			provider: "grokbot",
		});
	}
	const renewal = await execInBox(
		execDaemonUrl,
		networkToken,
		execAuthToken,
		`omp-refresh-${Date.now().toString(36)}`,
		"grep -aoh 'sbi_[A-Za-z0-9_-]*' /proc/[0-9]*/environ 2>/dev/null | head -1",
		requestOptions,
	);

	// The stored renewer may still be valid (box not recreated) — only rewrite
	// the row when the bootstrap produced a different, working credential.
	if (renewal === credentials.access) {
		const verdict = await verifyInference(renewal, machineId, requestOptions);
		if (verdict.ok) {
			return { ...credentials, expires: accountTokenExpiryMs(accountToken) };
		}
	} else {
		const verdict = await verifyInference(renewal, machineId, requestOptions);
		if (verdict.ok) {
			return { ...credentials, access: renewal, expires: accountTokenExpiryMs(accountToken) };
		}
	}
	// Fall back to the stored renewer if it still works even though bootstrap
	// returned something different (e.g. a second box for another machine).
	const storedVerdict = await verifyInference(credentials.access, machineId, requestOptions);
	if (storedVerdict.ok) {
		return { ...credentials, expires: accountTokenExpiryMs(accountToken) };
	}
	throw new AIError.OAuthError("Grok Bot credential refresh could not obtain a working renewer; sign in again", {
		kind: "token-exchange",
		provider: "grokbot",
	});
}
