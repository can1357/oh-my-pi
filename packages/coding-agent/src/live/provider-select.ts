import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { VoiceProviderId } from "./transport-types";

/** Settings / slash values for `/live` backend selection. */
export type LiveProviderSetting = "auto" | VoiceProviderId;

/** Built-in native-duplex ranking before user pins. */
export const NATIVE_DUPLEX_ORDER: readonly VoiceProviderId[] = ["codex", "grok"];

/** True when `value` is a native duplex live provider id. */
export function isVoiceProviderId(value: string): value is VoiceProviderId {
	return value === "codex" || value === "grok";
}

/** Parse `/live` args into a one-session pin, or undefined for settings/`auto`. */
export function parseLiveProviderArg(args: string): VoiceProviderId | undefined {
	const token = args.trim().split(/\s+/)[0]?.toLowerCase();
	if (!token) return undefined;
	if (token === "xai" || token === "grok") return "grok";
	if (token === "openai" || token === "openai-codex" || token === "codex") return "codex";
	return undefined;
}

/** True when the latest non-Spark usage window for `provider` is exhausted. */
export function liveProviderUsageExhausted(authStorage: AuthStorage, provider: string): boolean {
	const sinceMs = Date.now() - 14 * 86_400_000;
	const entries = authStorage.listUsageHistory?.({ provider, sinceMs }) ?? [];
	const latest: Record<string, (typeof entries)[number]> = {};
	for (const entry of entries) {
		latest[`${entry.accountKey}:${entry.limitId}`] = entry;
	}
	for (const entry of Object.values(latest)) {
		const label = `${entry.label ?? ""} ${entry.windowLabel ?? ""}`.toLowerCase();
		if (label.includes("spark") || label.includes("reserve")) continue;
		if (entry.status === "exhausted") return true;
		if ((entry.usedFraction ?? 0) >= 1) return true;
	}
	return false;
}
