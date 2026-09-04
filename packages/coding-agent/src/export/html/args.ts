/**
 * `/export` argument parsing, split from `./index.ts` so slash-command
 * registries can parse arguments without eagerly loading the export module's
 * embedded template/tool-view text.
 */

/** Dark and light TUI theme names bundled into a dual-theme export. */
export interface ExportThemeNames {
	dark: string;
	light: string;
}

/** Tokenize slash-command arguments supporting single and double quotes. */
function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;

	for (let index = 0; index < input.length; index++) {
		const ch = input[index];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else if (ch === "\\" && index + 1 < input.length && input[index + 1] === quote) {
				current += input[++index];
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "\\" && index + 1 < input.length && (input[index + 1] === '"' || input[index + 1] === "'")) {
			current += input[++index];
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Parse `/export [--themes] [path]`. Supports quoted paths with spaces. */
export function parseExportArgs(args: string): { outputPath?: string; useUserThemes: boolean } {
	const parts = tokenizeArgs(args.trim());
	const useUserThemes = parts.includes("--themes");
	const paths = parts.filter(part => part !== "--themes");
	if (paths.length > 1) throw new Error("Usage: /export [--themes] [path]");
	return { outputPath: paths[0], useUserThemes };
}
