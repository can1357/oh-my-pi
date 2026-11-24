import { describe, expect, it } from "bun:test";
import { Highlighter, highlightCode, highlightSpans, supportsLanguage } from "@oh-my-pi/pi-tui/text/highlight";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const theme = loadThemeSync("dark");

describe("languageFromPath", () => {
	it("detects special basenames case-insensitively before extensions", () => {
		for (const name of ["Dockerfile", "dockerfile", "Dockerfile.dev", "DOCKERFILE", "Containerfile"]) {
			expect(languageFromPath(name)).toBe("dockerfile");
		}
		expect(languageFromPath(".env")).toBe("env");
		expect(languageFromPath(".env.local")).toBe("env");
		expect(languageFromPath(".emacs")).toBe("emacs-lisp");
		expect(languageFromPath("justfile")).toBe("just");
		expect(languageFromPath("CMakeLists.txt")).toBe("cmake");
		expect(languageFromPath("Makefile")).toBe("make");
	});

	it("uses the last extension of the basename, case-insensitively", () => {
		expect(languageFromPath("Main.TS")).toBe("typescript");
		expect(languageFromPath("App.TSX")).toBe("tsx");
		expect(languageFromPath("config.test.ts")).toBe("typescript");
		expect(languageFromPath("/home/user/project/src/index.ts")).toBe("typescript");
		expect(languageFromPath("C:\\Users\\dev\\app\\main.rs")).toBe("rust");
		expect(languageFromPath("kernel.cu")).toBe("cpp");
	});

	it("returns undefined for unknown or missing extensions", () => {
		expect(languageFromPath("file.unknownext")).toBeUndefined();
		expect(languageFromPath("README")).toBeUndefined();
		expect(languageFromPath("/a.b/README")).toBeUndefined();
	});
});

describe("highlighting", () => {
	it("knows which languages have grammars", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		expect(supportsLanguage("ts")).toBe(true);
		expect(supportsLanguage("nolang")).toBe(false);
	});

	it("produces theme-token spans per line", () => {
		const [first, second] = highlightSpans("function f() {}\nreturn 1;", "typescript");
		expect(first!.map(span => span.t).join("")).toBe("function f() {}");
		expect(first![0]).toEqual({ t: "function", s: "syntaxKeyword" });
		expect(first!.some(span => span.s === "syntaxFunction" && span.t === "f")).toBe(true);
		expect(second!.some(span => span.s === "syntaxNumber" && span.t === "1")).toBe(true);
	});

	it("carries a multi-line comment across lines", () => {
		const lines = highlightSpans("/* start\n   end */ const x = 1;", "typescript");
		expect(lines[1]![0]).toEqual({ t: "   end ", s: "syntaxComment" });
		expect(highlightSpans("   end */ const x = 1;", "typescript")[0]![0]!.s).not.toBe("syntaxComment");
	});

	it("leaves unknown languages unstyled, one span per non-empty line", () => {
		expect(highlightSpans("a = 1\n\nb", "nolang")).toEqual([[{ t: "a = 1" }], [], [{ t: "b" }]]);
		expect(highlightCode("a\nb", undefined, theme)).toEqual(["a", "b"]);
	});

	it("renders spans with the theme's syntax colors", () => {
		const [line] = highlightCode("return x;", "typescript", theme);
		expect(line!.startsWith(theme.fg("syntaxKeyword", "return"))).toBe(true);
		expect(Bun.stripANSI(line!)).toBe("return x;");
	});

	it("colors diff insertions and deletions with the diff colors", () => {
		const lines = highlightSpans("+added\n-removed\n context", "diff");
		expect(lines[0]!.some(span => span.s === "toolDiffAdded")).toBe(true);
		expect(lines[1]!.some(span => span.s === "toolDiffRemoved")).toBe(true);
	});

	it("streams chunks to the same result as one call", () => {
		const code = "const a = 1;\n/* multi\nline */\nlet b = `x\ny`;\n";
		const whole = highlightSpans(code, "typescript");
		const stream = new Highlighter("typescript");
		expect(stream.supported).toBe(true);
		const lines = [
			...stream.push("const a = 1;\n/* multi\n"),
			...stream.push("line */\nlet b = `x\n"),
			...stream.push("y`;\n"),
			...stream.finish(),
		];
		expect(lines).toEqual(whole);
		expect(new Highlighter("nolang").supported).toBe(false);
	});
});
