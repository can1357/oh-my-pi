/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register, type ScopeLike } from "../config/registry";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS } from "./voices";

export const cfgLiveVoice = register({
	id: "live.voice",
	type: "string",
	default: DEFAULT_LIVE_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Voice",
		description: "Voice of realtime voice sessions; a custom live endpoint may take other names (set in config)",
		options: LIVE_VOICE_OPTIONS,
	},
});

function validateLiveEndpoint(raw: unknown): void {
	if (typeof raw !== "string" || !raw.trim()) return;
	let protocol: string;
	try {
		protocol = new URL(raw.trim()).protocol;
	} catch {
		throw new Error(`live.endpoint must be an http(s) URL, got ${JSON.stringify(raw)}`);
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`live.endpoint must be an http(s) URL, got ${JSON.stringify(raw)}`);
	}
}

export const cfgLiveEndpoint = register({
	id: "live.endpoint",
	type: "string",
	default: undefined,
	validate: validateLiveEndpoint,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Endpoint",
		description:
			"Base URL of an OpenAI Realtime WebRTC-compatible server (e.g. http://127.0.0.1:8080/v1) used for live voice instead of Codex; empty uses Codex",
	},
});

export const cfgLiveApiKey = register({
	id: "live.apiKey",
	type: "string",
	default: undefined,
	credential: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Endpoint API Key",
		description: "Bearer key sent only to the live endpoint: a literal, an environment variable name, or !command",
	},
});

/** The voice a live session uses: an explicit choice, else the `live.voice` setting, else the default. */
export function resolveLiveVoice(scope: ScopeLike, voice?: string): string {
	return voice?.trim() || cfgLiveVoice.get(scope).trim() || DEFAULT_LIVE_VOICE;
}
