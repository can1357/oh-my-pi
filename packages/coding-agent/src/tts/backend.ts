/**
 * Shared TTS backend selection, used by both the one-shot `tts` tool
 * (`tools/tts.ts`) and the live streaming vocalizer (`tts/vocalizer.ts`).
 * Lives under `tts/` (not `tools/`) so the vocalizer can depend on it without
 * a backwards import into `tools/`.
 */

export type TtsBackend = "local" | "xai" | "elevenlabs";

export interface ResolveTtsBackendOptions {
	preference: string;
	wantsMp3: boolean;
	hasXaiCreds: boolean;
}

/**
 * Pick the synthesis backend. Pure for testability.
 *
 * - `xai` / `local` / `elevenlabs` are honored verbatim (each backend still
 *   surfaces its own "no credentials" error when creds are missing).
 * - `auto` defaults to the local on-device backend, routing to xAI only when
 *   the caller asked for an `.mp3` and xAI credentials exist (only xAI/
 *   ElevenLabs can emit MP3 — the local backend never does). ElevenLabs is
 *   never auto-selected; use it by setting `providers.tts = "elevenlabs"`
 *   explicitly.
 */
export function resolveTtsBackend(opts: ResolveTtsBackendOptions): TtsBackend {
	if (opts.preference === "xai") return "xai";
	if (opts.preference === "local") return "local";
	if (opts.preference === "elevenlabs") return "elevenlabs";
	if (opts.wantsMp3 && opts.hasXaiCreds) return "xai";
	return "local";
}
