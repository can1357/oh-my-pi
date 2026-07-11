/**
 * Contract tests for language detection from file paths.
 *
 * `getLanguageFromPath` returns the highlight language id for a given file
 * path, or undefined if unknown. `detectLanguageId` returns the LSP language
 * identifier, falling back to "plaintext".
 *
 * These tests defend observable contracts (special filenames, case handling,
 * unknown fallbacks, lookup ordering) — not individual entries from the
 * EXTENSION_LANG table, which would just re-state the lookup map.
 */
import { describe, expect, it } from "bun:test";
import { detectLanguageId, getLanguageFromPath } from "../../src/utils/lang-from-path";

describe("getLanguageFromPath", () => {
	it("detects Dockerfile by basename (case-insensitive)", () => {
		expect(getLanguageFromPath("Dockerfile")).toBe("dockerfile");
		expect(getLanguageFromPath("dockerfile")).toBe("dockerfile");
		expect(getLanguageFromPath("Dockerfile.dev")).toBe("dockerfile");
		expect(getLanguageFromPath("DOCKERFILE")).toBe("dockerfile");
	});

	it("detects Containerfile", () => {
		expect(getLanguageFromPath("Containerfile")).toBe("dockerfile");
	});

	it("detects .env files by prefix", () => {
		expect(getLanguageFromPath(".env.local")).toBe("env");
		expect(getLanguageFromPath(".env.production")).toBe("env");
		// .env itself — themeExtensionKey returns "env" which matches the table
		expect(getLanguageFromPath(".env")).toBe("env");
	});

	it("detects .emacs", () => {
		expect(getLanguageFromPath(".emacs")).toBe("emacs-lisp");
	});

	it("detects justfile", () => {
		expect(getLanguageFromPath("justfile")).toBe("just");
	});

	it("detects CMakeLists.txt as cmake (basename wins over .txt extension)", () => {
		// Without the basename-first check, .txt would match the extension table
		// and return "text" instead of "cmake". This test pins that the basename
		// check fires before the extension lookup.
		expect(getLanguageFromPath("CMakeLists.txt")).toBe("cmake");
		expect(getLanguageFromPath("cmakelists.txt")).toBe("cmake");
	});

	it("is case-insensitive on extensions", () => {
		expect(getLanguageFromPath("Main.TS")).toBe("typescript");
		expect(getLanguageFromPath("App.TSX")).toBe("tsx");
	});

	it("returns undefined for unknown extensions", () => {
		expect(getLanguageFromPath("file.unknownext")).toBeUndefined();
		expect(getLanguageFromPath("file.xyz123")).toBeUndefined();
	});

	it("returns undefined for files with no extension", () => {
		expect(getLanguageFromPath("README")).toBeUndefined();
	});

	it("returns the last extension when multiple dots are present", () => {
		expect(getLanguageFromPath("config.test.ts")).toBe("typescript");
	});

	it("handles full paths with directories", () => {
		expect(getLanguageFromPath("/home/user/project/src/index.ts")).toBe("typescript");
		expect(getLanguageFromPath("C:\\Users\\dev\\app\\main.rs")).toBe("rust");
	});
});

describe("detectLanguageId", () => {
	it("detects Dockerfile as dockerfile", () => {
		expect(detectLanguageId("Dockerfile")).toBe("dockerfile");
		expect(detectLanguageId("dockerfile.dev")).toBe("dockerfile");
	});

	it("detects Containerfile as dockerfile", () => {
		expect(detectLanguageId("Containerfile")).toBe("dockerfile");
	});

	it("detects .emacs as emacs-lisp", () => {
		expect(detectLanguageId(".emacs")).toBe("emacs-lisp");
	});

	it("detects Makefile as makefile", () => {
		expect(detectLanguageId("Makefile")).toBe("makefile");
		expect(detectLanguageId("makefile")).toBe("makefile");
		expect(detectLanguageId("gnumakefile")).toBe("makefile");
	});

	it("detects justfile as just", () => {
		expect(detectLanguageId("justfile")).toBe("just");
	});

	it("detects CMakeLists.txt as cmake", () => {
		expect(detectLanguageId("CMakeLists.txt")).toBe("cmake");
	});

	it("detects .cmake extension as cmake", () => {
		expect(detectLanguageId("FindPackage.cmake")).toBe("cmake");
	});

	it("falls back to plaintext for unknown extensions", () => {
		expect(detectLanguageId("file.unknownext")).toBe("plaintext");
	});

	it("falls back to plaintext for files with no extension", () => {
		expect(detectLanguageId("README")).toBe("plaintext");
	});
});
