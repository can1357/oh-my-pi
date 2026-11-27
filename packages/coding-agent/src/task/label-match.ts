/**
 * Pure handle-echo check for generated subagent labels, kept separate from
 * `./label` so dock views loaded during speculative prepaint do not pull
 * `model-resolver`, `model-registry`, `settings`, `lsp`, and `mcp` into the
 * first-frame module graph.
 */

/** True when a generated label is just the spawn handle, including `Name-2`. */
export function labelEchoesHandle(handle: string | undefined, label: string): boolean {
	if (!handle) return false;
	if (label.localeCompare(handle, undefined, { sensitivity: "accent" }) === 0) return true;
	const separator = handle.lastIndexOf("-");
	if (separator <= 0) return false;
	const prefix = handle.slice(0, separator);
	const suffix = handle.slice(separator + 1);
	return /^\d+$/.test(suffix) && prefix.localeCompare(label, undefined, { sensitivity: "accent" }) === 0;
}
