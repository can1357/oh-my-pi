// ElevenLabs is TTS-only in this harness — it is not a chat/completion
// provider, so it is intentionally NOT registered in the shared
// ModelRegistry/AuthStorage catalog (that cascade backs OAuth + config +
// stored-credential resolution for actual model providers; adding a
// TTS-only provider there would imply chat/model-listing support it doesn't
// have). Credential resolution here is scoped and deliberately simple:
// environment variable only. No settings-stored key: unlike model provider
// API keys, this key has no OAuth alternative, and keeping it out of
// settings.json avoids ever writing it to a config file that might be
// synced, backed up, or accidentally committed.

import { $env, APP_NAME } from "@pk-nerdsaver-ai/pi-utils";

export const ELEVENLABS_DEFAULT_BASE_URL = "https://api.elevenlabs.io/v1";

/** Sample rate requested via `output_format=pcm_24000` — matches Kokoro's 24 kHz output, no resampling needed. */
export const ELEVENLABS_PCM_SAMPLE_RATE = 24_000;

/** ElevenLabs' lowest-latency model (~75 ms budget) — the right default for live speech. */
export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";

/** ElevenLabs' "Rachel" voice — a stable, broadly available default. */
export const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

export function ohMyPkElevenLabsUserAgent(): string {
	return `${APP_NAME}/elevenlabs`;
}

/**
 * Resolve the ElevenLabs API key from the environment. Returns `undefined`
 * when unset — callers should treat that as "ElevenLabs unavailable" and
 * fall back rather than throw, matching the rest of the TTS backend
 * selection contract (`resolveTtsBackend`).
 */
export function resolveElevenLabsApiKey(): string | undefined {
	return $env.ELEVENLABS_API_KEY || undefined;
}

export function resolveElevenLabsBaseUrl(): string {
	return $env.ELEVENLABS_BASE_URL || ELEVENLABS_DEFAULT_BASE_URL;
}

export function hasElevenLabsCredentials(): boolean {
	return resolveElevenLabsApiKey() !== undefined;
}

/**
 * Run one ElevenLabs request with a bounded lifetime. The explicit timer is
 * cleared on every exit path; Bun's AbortSignal.timeout/any combination can
 * otherwise leave stalled requests (and test processes) alive.
 */
export async function withElevenLabsRequestTimeout<T>(
	parentSignal: AbortSignal | undefined,
	timeoutMs: number,
	request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const abortFromParent = (): void => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) abortFromParent();
	else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error(`ElevenLabs request timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);

	try {
		return await request(controller.signal);
	} finally {
		clearTimeout(timeout);
		parentSignal?.removeEventListener("abort", abortFromParent);
	}
}
