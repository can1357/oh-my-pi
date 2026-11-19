/**
 * Prettier formatting utilities for edit benchmarks.
 */
import * as path from "node:path";
import * as prettier from "prettier";
import { listFiles } from "./shared";

const PRETTIER_OPTIONS: prettier.Options = {
	printWidth: 100,
	tabWidth: 2,
	useTabs: false,
	semi: true,
	singleQuote: true,
	quoteProps: "as-needed",
	trailingComma: "all",
	bracketSpacing: true,
	arrowParens: "always",
	endOfLine: "lf",
	proseWrap: "preserve",
};

const parserByExtension: Partial<Record<string, prettier.BuiltInParserName>> = {
	// Benchmark JS fixtures are Flow-typed; pin to flow to avoid parser-dependent formatting drift.
	".js": "flow",
	".jsx": "flow",
	".ts": "typescript",
	".tsx": "typescript",
	".json": "json",
	".jsonc": "json",
	".md": "markdown",
	".mdx": "mdx",
	".yml": "yaml",
	".yaml": "yaml",
	".css": "css",
	".scss": "scss",
	".html": "html",
};

export interface FormatResult {
	formatted: string;
	didFormat: boolean;
}

export async function formatContent(filePath: string, content: string): Promise<FormatResult> {
	const parser = parserByExtension[path.extname(filePath).toLowerCase()];
	if (!parser) {
		return { formatted: content, didFormat: false };
	}

	try {
		const formatted = await prettier.format(content, { ...PRETTIER_OPTIONS, parser });
		return { formatted, didFormat: true };
	} catch {
		return { formatted: content, didFormat: false };
	}
}

export async function formatDirectory(rootDir: string): Promise<void> {
	const files = await listFiles(rootDir);

	for (const file of files) {
		const fullPath = path.join(rootDir, file);
		const content = await Bun.file(fullPath).text();
		const result = await formatContent(fullPath, content);
		if (result.didFormat && result.formatted !== content) {
			await Bun.write(fullPath, result.formatted);
		}
	}
}
