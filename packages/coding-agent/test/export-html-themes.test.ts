import { describe, expect, it } from "bun:test";
import { generateThemeStyles, generateThemeVars, parseExportArgs } from "@oh-my-pi/pi-coding-agent/export/html";

describe("HTML export themes", () => {
	it("bundles dark, light, and auto-following web themes", async () => {
		const styles = await generateThemeStyles("web");

		expect(styles).toContain(':root, :root[data-theme="dark"] { color-scheme: dark;');
		expect(styles).toContain(':root[data-theme="light"] { color-scheme: light;');
		expect(styles).toContain("@media (prefers-color-scheme: light)");
		expect(styles).toContain("--bg: #0f0b14;");
		expect(styles).toContain("--bg: oklch(0.985 0.004 307);");
	});

	it("bundles independently selected dark and light TUI themes", async () => {
		const [styles, dark, light] = await Promise.all([
			generateThemeStyles("theme", { dark: "titanium", light: "light" }),
			generateThemeVars("theme", "titanium"),
			generateThemeVars("theme", "light"),
		]);

		expect(styles).toContain(`:root, :root[data-theme="dark"] { color-scheme: dark; ${dark} }`);
		expect(styles).toContain(`:root[data-theme="light"] { color-scheme: light; ${light} }`);
	});

	it("parses the optional user-theme flag before or after the output path", () => {
		expect(parseExportArgs("--themes export.html")).toEqual({ outputPath: "export.html", useUserThemes: true });
		expect(parseExportArgs("export.html --themes")).toEqual({ outputPath: "export.html", useUserThemes: true });
		expect(parseExportArgs("")).toEqual({ outputPath: undefined, useUserThemes: false });
		expect(() => parseExportArgs("one.html two.html")).toThrow("Usage: /export [--themes] [path]");
	});

	it("supports quoted output paths containing spaces and preserves path literals", () => {
		expect(parseExportArgs('--themes "my export.html"')).toEqual({
			outputPath: "my export.html",
			useUserThemes: true,
		});
		expect(parseExportArgs("'my report.html' --themes")).toEqual({
			outputPath: "my report.html",
			useUserThemes: true,
		});
		expect(parseExportArgs('"C:\\Users\\me\\My Reports\\session.html"')).toEqual({
			outputPath: "C:\\Users\\me\\My Reports\\session.html",
			useUserThemes: false,
		});
		expect(parseExportArgs('"\\\\server\\share\\My Reports\\session.html"')).toEqual({
			outputPath: "\\\\server\\share\\My Reports\\session.html",
			useUserThemes: false,
		});
	});

	it("recognizes flags separated by newlines while preserving quoted newlines", () => {
		expect(parseExportArgs('\n--themes\r\n"my export.html"\n')).toEqual({
			outputPath: "my export.html",
			useUserThemes: true,
		});
		expect(parseExportArgs('"line1\nline2.html"')).toEqual({
			outputPath: "line1\nline2.html",
			useUserThemes: false,
		});
	});

	it("unescapes quote characters without consuming Windows path separators", () => {
		expect(parseExportArgs('"my \\"quoted\\" report.html"')).toEqual({
			outputPath: 'my "quoted" report.html',
			useUserThemes: false,
		});
		expect(parseExportArgs("'my \\'quoted\\' report.html'")).toEqual({
			outputPath: "my 'quoted' report.html",
			useUserThemes: false,
		});
	});

	it("rejects multiple paths and incomplete quotes rather than exporting to a different path", () => {
		expect(() => parseExportArgs('"one file.html" "second file.html"')).toThrow("Usage: /export [--themes] [path]");
		expect(() => parseExportArgs('"unterminated path.html')).toThrow(/quote/i);
		expect(() => parseExportArgs("'unterminated path.html")).toThrow(/quote/i);
	});
});
