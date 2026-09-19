import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import { GrokLiveTransport } from "./grok-transport";
import { LIVE_MODEL } from "./protocol";
import {
	liveProviderUsageExhausted,
	NATIVE_DUPLEX_ORDER,
	type LiveProviderSetting,
} from "./provider-select";
import { CodexLiveTransport } from "./transport";
import type { ILiveTransport, LiveTransportOptions, VoiceProviderId } from "./transport-types";
import { DEFAULT_GROK_LIVE_VOICE, DEFAULT_LIVE_VOICE } from "./voices";

export type { LiveProviderSetting } from "./provider-select";
export { isVoiceProviderId, liveProviderUsageExhausted, parseLiveProviderArg } from "./provider-select";

export interface ResolveLiveTransportConfig {
	authStorage: AuthStorage;
	sessionId: string;
	instructions: string;
	callbacks: LiveTransportOptions["callbacks"];
	signal?: AbortSignal;
	/** `auto` or an explicit pin from settings / `/live grok`. */
	provider: LiveProviderSetting;
	codexVoice?: string;
	grokVoice?: string;
}



async function grokAvailable(authStorage: AuthStorage, sessionId: string): Promise<boolean> {
	if ($env.XAI_API_KEY) return true;
	if (authStorage.hasNonEnvCredential("xai-oauth")) return true;
	if (await authStorage.getApiKey("xai-oauth", sessionId)) return true;
	if (await authStorage.getApiKey("xai", sessionId)) return true;
	return false;
}

function codexAvailable(authStorage: AuthStorage): boolean {
	return (
		authStorage.hasNonEnvCredential("openai-codex") ||
		Boolean($env.OPENAI_OAUTH_TOKEN || $env.CODEX_OAUTH_TOKEN)
	);
}

function createTransport(id: VoiceProviderId, options: LiveTransportOptions): ILiveTransport {
	if (id === "grok") return new GrokLiveTransport(options);
	return new CodexLiveTransport(options);
}

/**
 * Resolve a native-duplex live transport.
 * `auto` skips backends whose latest non-Spark usage window is exhausted.
 * An explicit pin fails closed.
 */
export async function resolveLiveTransport(config: ResolveLiveTransportConfig): Promise<ILiveTransport> {
	const base = {
		authStorage: config.authStorage,
		sessionId: config.sessionId,
		instructions: config.instructions,
		callbacks: config.callbacks,
		signal: config.signal,
	};

	const create = (id: VoiceProviderId): ILiveTransport => {
		const voice =
			id === "grok"
				? config.grokVoice?.trim() || DEFAULT_GROK_LIVE_VOICE
				: config.codexVoice?.trim() || DEFAULT_LIVE_VOICE;
		const model = id === "grok" ? undefined : LIVE_MODEL;
		return createTransport(id, { ...base, voice, model });
	};

	if (config.provider !== "auto") {
		if (config.provider === "grok" && !(await grokAvailable(config.authStorage, config.sessionId))) {
			throw new Error(
				"Grok live requires xAI Grok OAuth (/login xai-oauth) or XAI_API_KEY. No xAI credential is configured.",
			);
		}
		if (config.provider === "codex" && !codexAvailable(config.authStorage)) {
			throw new Error("No Codex OAuth credential is available for a live call.");
		}
		return create(config.provider);
	}

	const errors: string[] = [];
	for (const id of NATIVE_DUPLEX_ORDER) {
		if (id === "codex" && !codexAvailable(config.authStorage)) continue;
		if (id === "grok" && !(await grokAvailable(config.authStorage, config.sessionId))) continue;
		const quotaProvider = id === "codex" ? "openai-codex" : "xai-oauth";
		if (liveProviderUsageExhausted(config.authStorage, quotaProvider)) {
			errors.push(`${id} skipped (usage exhausted)`);
			continue;
		}
		return create(id);
	}

	throw new Error(
		`No realtime voice provider is available. ${errors.join("; ") || "Configure Codex OAuth or xAI Grok OAuth."}`,
	);
}
