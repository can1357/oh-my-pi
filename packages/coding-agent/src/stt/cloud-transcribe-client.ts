import {
	type ApiKey,
	type FetchImpl,
	type OAuthAccess,
	type OAuthAccessSource,
	withAuth,
	withOAuthAccess,
} from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { getCodexAttestationHeader } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
	URL_PATHS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { logger, sanitizeText, wrapFetchForExtraCa } from "@oh-my-pi/pi-utils";
import { resolveConfigHeaders } from "../config/model-config-values";
import { TRUNCATE_LENGTHS } from "../tools/render-utils";
import { concatenatePcm, encodeWav } from "../tts/wav";
import type { SttStreamHandle, SttStreamOptions } from "./asr-client";
import { resolveCloudSttModel } from "./cloud-models";

const CODEX_STT_URL = `${CODEX_BASE_URL}${URL_PATHS.TRANSCRIBE}`;
/** Provider id the Codex ChatGPT-subscription credential is stored under. */
const CODEX_STT_PROVIDER = "openai-codex";
/** Provider id the platform API-key credential is stored under. */
const OPENAI_STT_PROVIDER = "openai";
const CLOUD_STT_PROCESSING_TIMEOUT_MS = 60_000;
/** Conservative floor: keep the request alive long enough to upload at 1 Mibit/s. */
const CLOUD_STT_ERROR_BODY_MAX_BYTES = 16 * 1024;
const CLOUD_STT_MIN_UPLOAD_BYTES_PER_SECOND = 128 * 1024;

/** omp records at 16 kHz mono; the endpoint accepts 16-bit PCM WAV as-is. */
const MIC_SAMPLE_RATE = 16_000;
/**
 * Keep the generated WAV below the transcription endpoint's 25 MiB upload
 * limit. Shared with the controller's pre-stream buffer so audio held while
 * the backend is still starting is bounded the same way.
 */
export const MAX_AUDIO_SAMPLES = Math.floor((24 * 1024 * 1024 - 44) / 2);
export const AUDIO_LIMIT_MESSAGE = "Cloud speech recording exceeds the 24 MiB upload limit.";
/**
 * A resolved cloud STT credential with its provenance intact.
 *
 * The `codex` variant carries the OAuth *source* (not just a bearer) so the
 * request runs through {@link withOAuthAccess}: a server-rejected but
 * unexpired session-sticky token gets force-refreshed and, on an
 * account-scoped denial, rotated to a sibling account instead of dropping the
 * dictation.
 */
export type CloudSttCredential =
	| { kind: "codex"; access: OAuthAccess; source: OAuthAccessSource; sessionId?: string }
	| {
			kind: "openai";
			/** Resolver form gets the central refresh/rotate retry; a string is a single attempt. */
			apiKey: ApiKey;
			baseUrl?: string;
			headers?: Record<string, string>;
	  }
	| {
			kind: "openai";
			/** Explicit `auth: none`; provider headers remain authoritative. */
			keyless: true;
			baseUrl?: string;
			headers?: Record<string, string>;
	  };
export interface CloudSttStreamOptions extends SttStreamOptions {
	credential: CloudSttCredential;
	/** Transcription model id; resolved with {@link resolveCloudSttModel}. */
	model?: string;
	/** Domain hints; forwarded as the endpoint `prompt` when set. */
	keywords?: string[];
	/** Fetch implementation; defaults to global fetch. Tests inject a stub. */
	fetchImpl?: typeof fetch;
}

/**
 * Buffering cloud stream. Same {@link SttStreamHandle} shape as the local
 * worker client so `STTController` drives both backends through one path:
 * `pushAudio` accumulates, `stop()` transcribes the buffer and resolves with
 * the text (empty when silent), `cancel()` resolves "" without a request.
 */
export function startCloudSttStream(options: CloudSttStreamOptions): SttStreamHandle {
	// Same transport layers `transportFetch` applies to inference requests, for a
	// request that has no Model to route through it: `NODE_EXTRA_CA_CERTS` (Bun
	// fetch does not read it itself) and the provider-scoped proxy
	// (`PI_PROXY_OPENAI` / `PI_PROXY_OPENAI_CODEX`; the global wrapper only
	// covers bare `PI_PROXY`).
	const provider = options.credential.kind === "codex" ? CODEX_STT_PROVIDER : OPENAI_STT_PROVIDER;
	const fetchImpl = wrapFetchForProxy(wrapFetchForExtraCa(options.fetchImpl ?? fetch), provider);
	const requestAbort = new AbortController();
	const chunks: Float32Array[] = [];
	let queuedBytes = 0;
	let limitExceeded = false;
	let settled = false;
	let stopped = false;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	void promise.catch(() => {});

	// Detach from the caller's signal on every outcome, not only on abort: a
	// long-lived signal shared across dictations would otherwise accumulate one
	// listener (and this closure's buffered audio) per completed stream.
	const finish = (apply: () => void): void => {
		if (settled) return;
		settled = true;
		options.signal?.removeEventListener("abort", abort);
		apply();
	};
	const abort = (): void => {
		requestAbort.abort();
		finish(() => resolve(""));
	};
	if (options.signal?.aborted) abort();
	else options.signal?.addEventListener("abort", abort, { once: true });

	return {
		pushAudio(audio: Float32Array): void {
			if (settled || stopped || limitExceeded || audio.length === 0) return;
			if (queuedBytes + audio.length > MAX_AUDIO_SAMPLES) {
				limitExceeded = true;
				chunks.length = 0;
				queuedBytes = 0;
				return;
			}
			chunks.push(audio.slice());
			queuedBytes += audio.length;
		},
		stop: () => {
			if (!settled && !stopped) {
				stopped = true;
				if (limitExceeded) {
					finish(() => reject(new Error(AUDIO_LIMIT_MESSAGE)));
				} else if (queuedBytes === 0) {
					finish(() => resolve(""));
				} else {
					const signal = options.signal
						? AbortSignal.any([options.signal, requestAbort.signal])
						: requestAbort.signal;
					void transcribeBuffer(fetchImpl, { ...options, signal }, concatenatePcm(chunks, queuedBytes)).then(
						text => finish(() => resolve(text)),
						err => {
							const msg = err instanceof Error ? err.message : String(err);
							logger.error("STT cloud transcription failed", { error: msg });
							finish(() => reject(err instanceof Error ? err : new Error(msg)));
						},
					);
				}
			}
			return promise;
		},
		cancel: abort,
	};
}

async function transcribeBuffer(
	fetchImpl: FetchImpl,
	options: CloudSttStreamOptions,
	audio: Float32Array,
): Promise<string> {
	// Encode once: a credential retry replays the upload, not the WAV encode.
	const wav = new Blob([encodeWav(audio, MIC_SAMPLE_RATE)], { type: "audio/wav" });
	const credential = options.credential;
	if (credential.kind === "openai") return await transcribeWithApiKey(fetchImpl, options, credential, wav);
	return await withOAuthAccess(
		credential.source,
		CODEX_STT_PROVIDER,
		access => transcribeWithCodexAccess(fetchImpl, options, access, wav),
		{
			sessionId: credential.sessionId,
			signal: options.signal,
			seed: credential.access,
			missingAccessMessage: "No Codex OAuth credential is available for cloud dictation.",
		},
	);
}

/** ChatGPT-subscription route: Codex transcribe endpoint with identity headers. */
async function transcribeWithCodexAccess(
	fetchImpl: FetchImpl,
	options: CloudSttStreamOptions,
	access: OAuthAccess,
	wav: Blob,
): Promise<string> {
	const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
	if (!accountId) throw new Error("OpenAI Codex authentication is missing an account id.");
	const headers: Record<string, string> = {
		Authorization: `Bearer ${access.accessToken}`,
		[OPENAI_HEADERS.ACCOUNT_ID]: accountId,
		[OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
		[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
		"User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
	};
	applyCodexResidencyHeader(headers, access.accessToken);
	const attestation = await getCodexAttestationHeader(accountId);
	if (attestation) headers[OPENAI_HEADERS.ATTESTATION] = attestation;
	const form = new FormData();
	form.append("file", wav, "dictation.wav");
	return await postTranscription(fetchImpl, CODEX_STT_URL, headers, form, wav.size, options.signal);
}

/**
 * Platform route: honours a provider override's base URL and headers, and runs
 * the upload through {@link withAuth} so a resolver-backed credential
 * (command-backed, broker-refreshed, or one of several stored keys) gets the
 * central force-refresh/rotate treatment instead of failing on a stale key.
 * A static string key stays a single attempt.
 */
async function transcribeWithApiKey(
	fetchImpl: FetchImpl,
	options: CloudSttStreamOptions,
	credential: Extract<CloudSttCredential, { kind: "openai" }>,
	wav: Blob,
): Promise<string> {
	const baseUrl = credential.baseUrl?.replace(/\/$/, "") ?? "https://api.openai.com/v1";
	if ("keyless" in credential) {
		return await postTranscription(
			fetchImpl,
			`${baseUrl}/audio/transcriptions`,
			sanitizeOverrideHeaders(credential.headers, false),
			createTranscriptionForm(options, wav),
			wav.size,
			options.signal,
		);
	}
	return await withAuth(
		credential.apiKey,
		apiKey =>
			postTranscription(
				fetchImpl,
				`${baseUrl}/audio/transcriptions`,
				{ ...sanitizeOverrideHeaders(credential.headers, true), Authorization: `Bearer ${apiKey}` },
				createTranscriptionForm(options, wav),
				wav.size,
				options.signal,
			),
		{
			signal: options.signal,
			missingKeyMessage: "No OpenAI API key is available for cloud dictation.",
		},
	);
}

function createTranscriptionForm(options: CloudSttStreamOptions, wav: Blob): FormData {
	const form = new FormData();
	form.append("model", resolveCloudSttModel(options.model));
	if (options.language) form.append("language", options.language);
	if (options.keywords?.length) form.append("prompt", options.keywords.join(", "));
	form.append("response_format", "json");
	form.append("file", wav, "dictation.wav");
	return form;
}

/**
 * Drop request-owned headers from a provider override, matching any casing.
 *
 * `Content-Type` always belongs to fetch because it generates the multipart
 * boundary. Authenticated requests also replace `Authorization` with the
 * resolved bearer; keyless requests preserve a configured authorization
 * scheme because provider headers are their only authentication mechanism.
 */
function sanitizeOverrideHeaders(
	headers: Record<string, string> | undefined,
	stripAuthorization: boolean,
): Record<string, string> {
	const resolved = resolveConfigHeaders(headers);
	if (!resolved) return {};
	const entries = Object.entries(resolved).filter(([name]) => {
		const lower = name.toLowerCase();
		return lower !== "content-type" && (!stripAuthorization || lower !== "authorization");
	});
	return entries.length === Object.keys(resolved).length ? resolved : Object.fromEntries(entries);
}

/**
 * Make a provider/proxy error body safe to render: this message reaches the
 * TUI through `showWarning`, so ANSI escapes and control characters are
 * stripped, tabs become spaces, the body collapses to one line, and the result
 * is truncated to display width rather than a raw character count.
 */
function displayableErrorDetail(body: string): string {
	const flattened = replaceTabs(sanitizeText(body))
		.replace(/\s*\n+\s*/g, " ")
		.trim();
	return truncateToWidth(flattened, TRUNCATE_LENGTHS.CONTENT);
}

async function readBoundedResponseText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let remaining = CLOUD_STT_ERROR_BODY_MAX_BYTES;
	let text = "";
	try {
		while (remaining > 0) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			if (!value) continue;
			const chunk = value.subarray(0, remaining);
			text += decoder.decode(chunk, { stream: chunk.byteLength === value.byteLength });
			remaining -= chunk.byteLength;
			if (chunk.byteLength < value.byteLength) break;
		}
		await reader.cancel();
		return text + decoder.decode();
	} catch {
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

async function postTranscription(
	fetchImpl: FetchImpl,
	url: string,
	headers: Record<string, string>,
	form: FormData,
	uploadBytes: number,
	signal: AbortSignal | undefined,
): Promise<string> {
	const uploadTimeoutMs = Math.ceil((uploadBytes / CLOUD_STT_MIN_UPLOAD_BYTES_PER_SECOND) * 1000);
	const timeout = AbortSignal.timeout(CLOUD_STT_PROCESSING_TIMEOUT_MS + uploadTimeoutMs);
	const response = await fetchImpl(url, {
		method: "POST",
		headers,
		body: form,
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		const detail = displayableErrorDetail(await readBoundedResponseText(response));
		// Typed status so `withOAuthAccess` can classify 401 (refresh) and
		// 403/usage-limit (rotate) instead of seeing an opaque Error.
		throw new ProviderHttpError(`Cloud transcription failed (${response.status}): ${detail}`, response.status, {
			headers: response.headers,
		});
	}
	const body = (await response.json()) as { text?: string };
	return (body.text ?? "").trim();
}
