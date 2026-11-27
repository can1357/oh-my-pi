/**
 * Pure handle-echo check for generated subagent labels.
 *
 * Kept separate from `./label` so dock views loaded during speculative
 * prepaint (`startup-composer.ts` -> `frame.tsx` -> `ui/dock/subagents.tsx`)
 * do not pull `model-resolver`, `model-registry`, `settings`, `discovery`,
 * `lsp`, and `mcp` into the first-frame module graph.
 */
export function labelEchoesHandle(handle: string | undefined, label: string): boolean {
	if (!handle) return false;
	if (label.localeCompare(handle, undefined, { sensitivity: "accent" }) === 0) return true;
	const separator = handle.lastIndexOf("-");
	if (separator <= 0) return false;
	const prefix = handle.slice(0, separator);
	const suffix = handle.slice(separator + 1);
	return /^\d+$/.test(suffix) && prefix.localeCompare(label, undefined, { sensitivity: "accent" }) === 0;
}
