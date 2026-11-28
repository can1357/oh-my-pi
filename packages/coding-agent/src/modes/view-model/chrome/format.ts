import { providerConnectedName } from "@oh-my-pi/pi-catalog/compat/auth";

/**
 * What a surface about a linked account calls `provider`: its declared
 * `connected-name` (`Acme Pro plan`), else `fallback` (the bare id).
 */
export function connectedProviderName(provider: string, fallback: string = provider): string {
	return providerConnectedName(provider) ?? fallback;
}

/** A provider's display name: its connected name, else its id title-cased (`openai-codex` → `Openai Codex`). */
export function formatProviderName(provider: string): string {
	return connectedProviderName(
		provider,
		provider
			.split(/[-_]/g)
			.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
			.join(" "),
	);
}

/** Format a millisecond duration as a coarse-grained human label. */
export function formatCoarseDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	const days = Math.round(hours / 24);
	return `${days}d`;
}

/**
 * A plain-text progress bar with a trailing percent label (`[██████░░░░] 60%`).
 * `fraction` is clamped to `[0, 1]`; `undefined` draws a dotted placeholder without a label.
 */
export function renderAsciiBar(fraction: number | undefined, width = 24): string {
	const cells = Math.max(0, Math.trunc(width));
	if (fraction === undefined || !Number.isFinite(fraction)) return `[${"·".repeat(cells)}]`;
	const value = Math.min(1, Math.max(0, fraction));
	const filled = Math.round(value * cells);
	return `[${"█".repeat(filled)}${"░".repeat(cells - filled)}] ${Math.round(value * 100)}%`;
}
