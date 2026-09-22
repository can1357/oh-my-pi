import { type MermaidRenderOptions, renderMermaidAscii } from "@oh-my-pi/pi-natives";

/**
 * Native Mermaid → ASCII/Unicode renderer (flowchart, state, sequence, class,
 * ER, xychart). Synchronous because callers render inside the compositor;
 * throws on empty input, an unknown flowchart header, or an invalid
 * `direction`/`colorMode` value.
 */
export { renderMermaidAscii };

/** Options for {@link renderMermaidAscii}; every field optional. */
export type MermaidAsciiRenderOptions = MermaidRenderOptions;

/** {@link renderMermaidAscii}, returning `null` instead of throwing. */
export function renderMermaidAsciiSafe(source: string, options?: MermaidAsciiRenderOptions): string | null {
	try {
		return renderMermaidAscii(source, options);
	} catch {
		return null;
	}
}

/**
 * Extract mermaid code blocks from markdown text.
 */
export function extractMermaidBlocks(markdown: string): { source: string; hash: bigint | number }[] {
	const blocks: { source: string; hash: bigint | number }[] = [];
	const regex = /```mermaid\s*\n([\s\S]*?)```/g;

	for (let match = regex.exec(markdown); match !== null; match = regex.exec(markdown)) {
		const source = match[1].trim();
		const hash = Bun.hash(source);
		blocks.push({ source, hash });
	}

	return blocks;
}
