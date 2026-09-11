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
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { TRUNCATE_LENGTHS } from "../tools/render-utils";
import type { SttStreamHandle, SttStreamOptions } from "./asr-client";
import { resolveCloudSttModel } from "./cloud-models";

const CODEX_STT_URL = `${CODEX_BASE_URL}${URL_PATHS.TRANSCRIBE}`;
/** Provider id the Codex ChatGPT-subscription credential is stored under. */
const CODEX_STT_PROVIDER = "openai-codex";
/** Provider id the platform API-key credential is stored under. */
const OPENAI_STT_PROVIDER = "openai";
const CLOUD_STT_TIMEOUT_MS = 60_000;

/** omp records at 16 kHz mono; the endpoint accepts 16-bit PCM WAV as-is. */
const MIC_SAMPLE_RATE = 16_000;
/** Keep the generated WAV below the transcription endpoint's 25 MiB upload limit. */
const MAX_AUDIO_SAMPLES = Math.floor((24 * 1024 * 1024 - 44) / 2);
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
	// Provider-scoped proxy (`PI_PROXY_OPENAI` / `PI_PROXY_OPENAI_CODEX`) is only
	// applied by this helper; the global fetch wrapper covers bare `PI_PROXY`.
	const provider = options.credential.kind === "codex" ? CODEX_STT_PROVIDER : OPENAI_STT_PROVIDER;
	const fetchImpl = wrapFetchForProxy(options.fetchImpl ?? fetch, provider);
	const requestAbort = new AbortController();
	const chunks: Float32Array[] = [];
	let queuedBytes = 0;
	let limitExceeded = false;
	let settled = false;
	let stopped = false;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	void promise.catch(() => {});

	const finish = (apply: () => void): void => {
		if (settled) return;
		settled = true;
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
					finish(() => reject(new Error("Cloud speech recording exceeds the 24 MiB upload limit.")));
				} else if (queuedBytes === 0) {
					finish(() => resolve(""));
				} else {
					const signal = options.signal
						? AbortSignal.any([options.signal, requestAbort.signal])
						: requestAbort.signal;
					void transcribeBuffer(fetchImpl, { ...options, signal }, concat(chunks, queuedBytes)).then(
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

function concat(chunks: Float32Array[], total: number): Float32Array {
	const out = new Float32Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function transcribeBuffer(
	fetchImpl: FetchImpl,
	options: CloudSttStreamOptions,
	audio: Float32Array,
): Promise<string> {
	// Encode once: a credential retry replays the upload, not the WAV encode.
	const wav = new Blob([encodeWav16k(audio)], { type: "audio/wav" });
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
	return await postTranscription(fetchImpl, CODEX_STT_URL, headers, form, options.signal);
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
	const overrides = sanitizeOverrideHeaders(credential.headers);
	return await withAuth(
		credential.apiKey,
		apiKey => {
			// Rebuilt per attempt: a retry needs its own multipart body.
			const form = new FormData();
			form.append("model", resolveCloudSttModel(options.model));
			if (options.language) form.append("language", options.language);
			if (options.keywords?.length) form.append("prompt", options.keywords.join(", "));
			form.append("response_format", "json");
			form.append("file", wav, "dictation.wav");
			return postTranscription(
				fetchImpl,
				`${baseUrl}/audio/transcriptions`,
				{ ...overrides, Authorization: `Bearer ${apiKey}` },
				form,
				options.signal,
			);
		},
		{
			signal: options.signal,
			missingKeyMessage: "No OpenAI API key is available for cloud dictation.",
		},
	);
}

/**
 * Drop the request-owned headers from a provider override, matching any casing.
 *
 * - `Content-Type`: the multipart body needs fetch to generate its own
 *   boundary, so a configured `application/json` would make the endpoint reject
 *   an otherwise valid recording.
 * - `Authorization`: a differently-cased override key would survive alongside
 *   the one this request sets, and fetch joins same-name headers into a single
 *   comma-separated value (`Custom old, Bearer new`) the endpoint rejects.
 */
function sanitizeOverrideHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const entries = Object.entries(headers).filter(([name]) => {
		const lower = name.toLowerCase();
		return lower !== "content-type" && lower !== "authorization";
	});
	return entries.length === Object.keys(headers).length ? headers : Object.fromEntries(entries);
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

async function postTranscription(
	fetchImpl: FetchImpl,
	url: string,
	headers: Record<string, string>,
	form: FormData,
	signal: AbortSignal | undefined,
): Promise<string> {
	const timeout = AbortSignal.timeout(CLOUD_STT_TIMEOUT_MS);
	const response = await fetchImpl(url, {
		method: "POST",
		headers,
		body: form,
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		const detail = displayableErrorDetail(await response.text().catch(() => ""));
		// Typed status so `withOAuthAccess` can classify 401 (refresh) and
		// 403/usage-limit (rotate) instead of seeing an opaque Error.
		throw new ProviderHttpError(`Cloud transcription failed (${response.status}): ${detail}`, response.status, {
			headers: response.headers,
		});
	}
	const body = (await response.json()) as { text?: string };
	return (body.text ?? "").trim();
}

/** Encode 16 kHz mono float samples as a PCM16 WAV file. */
export function encodeWav16k(audio: Float32Array): ArrayBuffer {
	const buffer = new ArrayBuffer(44 + audio.length * 2);
	const view = new DataView(buffer);
	writeWavHeader(view, audio.length);
	const pcm = new Int16Array(buffer, 44);
	for (let i = 0; i < audio.length; i++) {
		pcm[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i]! * 32767)));
	}
	return buffer;
}

function writeWavHeader(view: DataView, samples: number): void {
	const writeAscii = (offset: number, text: string): void => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + samples * 2, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, MIC_SAMPLE_RATE, true);
	view.setUint32(28, MIC_SAMPLE_RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, "data");
	view.setUint32(40, samples * 2, true);
}
