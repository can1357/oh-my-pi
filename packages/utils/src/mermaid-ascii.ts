import { type AsciiRenderOptions, renderMermaidASCII } from "./vendor/mermaid-ascii";

export type { AsciiRenderOptions as MermaidAsciiRenderOptions };

export function renderMermaidAscii(source: string, options?: AsciiRenderOptions): string {
	return renderMermaidASCII(source, options);
}

export function renderMermaidAsciiSafe(source: string, options?: AsciiRenderOptions): string | null {
	try {
		return renderMermaidASCII(source, options);
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
