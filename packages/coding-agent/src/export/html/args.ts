/**
 * `/export` argument parsing, split from `./index.ts` so slash-command
 * registries can parse arguments without eagerly loading the export module's
 * embedded template/tool-view text.
 */

import { parseCommandArgs } from "../../utils/command-args";

/** Dark and light TUI theme names bundled into a dual-theme export. */
export interface ExportThemeNames {
	dark: string;
	light: string;
}

/** Parse `/export [--themes] [path]`; supports quoted paths containing spaces. */
export function parseExportArgs(args: string): { outputPath?: string; useUserThemes: boolean } {
	const parts = parseCommandArgs(args, {
		rejectUnterminatedQuotes: true,
		escapeQuotes: true,
		splitAllWhitespace: true,
	});
	const useUserThemes = parts.includes("--themes");
	const paths = parts.filter(part => part !== "--themes");
	if (paths.length > 1) throw new Error("Usage: /export [--themes] [path]");
	return { outputPath: paths[0], useUserThemes };
}
