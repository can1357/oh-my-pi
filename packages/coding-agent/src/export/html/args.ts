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

/** Parse `/export [--themes] [path]`; paths containing spaces were never supported. */
export function parseExportArgs(args: string): { outputPath?: string; useUserThemes: boolean } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const useUserThemes = parts.includes("--themes");
	const paths = parts.filter(part => part !== "--themes");
	if (paths.length > 1) throw new Error("Usage: /export [--themes] [path]");
	return { outputPath: paths[0], useUserThemes };
}
