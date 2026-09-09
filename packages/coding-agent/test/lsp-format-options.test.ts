import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectIndentFromContent, resolveFormatOptions } from "@oh-my-pi/pi-coding-agent/lsp/format-options";
import { getProjectDir, removeWithRetries, Snowflake, setProjectDir } from "@oh-my-pi/pi-utils";

/**
 * Regression coverage for issue #2329 — the LSP format-on-write path used to
 * send a hardcoded `{ tabSize: 3, insertSpaces: true }` regardless of file
 * content or `.editorconfig`, which silently re-indented 2-space YAML to
 * 3-space on every write.
 *
 * The contract these tests defend:
 *
 *   1. `.editorconfig` always wins, including `indent_style = tab`.
 *   2. With no `.editorconfig`, the in-memory content the agent is about to
 *      write is sniffed — 2-space YAML stays 2-space, 4-space code stays
 *      4-space, tab-indented Go stays tab-indented.
 *   3. The fallback is `tabSize: 2`, NOT the renderer's `defaultTabWidth = 3`.
 *      A `3` regression on this default reintroduces the bug.
 */
describe("detectIndentFromContent", () => {
	it("returns empty for empty content", () => {
		expect(detectIndentFromContent("")).toEqual({});
	});

	it("returns empty when content has no indented lines", () => {
		expect(detectIndentFromContent("foo\nbar\nbaz\n")).toEqual({});
	});

	it("detects 2-space indent from YAML", () => {
		const yaml = ["metadata:", "  name: test", "  labels:", "    app: test", ""].join("\n");
		expect(detectIndentFromContent(yaml)).toEqual({ tabSize: 2, insertSpaces: true });
	});

	it("detects 4-space indent", () => {
		const py = ["def f():", "    x = 1", "    if x:", "        return x", ""].join("\n");
		expect(detectIndentFromContent(py)).toEqual({ tabSize: 4, insertSpaces: true });
	});

	it("collapses mixed multi-level space indents to their GCD", () => {
		const src = ["a", "  b", "    c", "      d", ""].join("\n");
		expect(detectIndentFromContent(src)).toEqual({ tabSize: 2, insertSpaces: true });
	});

	it("reports insertSpaces=false for tab indents and leaves tabSize unset", () => {
		const go = ["package main", "", "func main() {", '\tprintln("hi")', "}", ""].join("\n");
		expect(detectIndentFromContent(go)).toEqual({ insertSpaces: false });
	});

	it("ignores blank lines when picking the first indented line", () => {
		const src = ["root:", "", "  child: value", ""].join("\n");
		expect(detectIndentFromContent(src)).toEqual({ tabSize: 2, insertSpaces: true });
	});
});

describe("resolveFormatOptions", () => {
	let tempDir = "";
	let previousProjectDir = "";

	beforeEach(async () => {
		previousProjectDir = getProjectDir();
		tempDir = path.join(os.tmpdir(), "pi-coding-agent-format-options", Snowflake.next());
		await fs.mkdir(tempDir, { recursive: true });
		setProjectDir(tempDir);
	});

	afterEach(async () => {
		setProjectDir(previousProjectDir);
		await removeWithRetries(tempDir);
	});

	it("falls back to 2-space indent when no .editorconfig and no content signal exist", () => {
		const filePath = path.join(tempDir, "blank.yaml");
		const opts = resolveFormatOptions(filePath, "");
		expect(opts).toEqual({
			tabSize: 2,
			insertSpaces: true,
			trimTrailingWhitespace: true,
			insertFinalNewline: true,
			trimFinalNewlines: true,
		});
	});

	it("preserves 2-space YAML when no .editorconfig is present (issue #2329 repro)", () => {
		const filePath = path.join(tempDir, "deployment.yaml");
		const yaml = ["metadata:", "  name: test", "  labels:", "    app: test", ""].join("\n");
		const opts = resolveFormatOptions(filePath, yaml);
		// The pre-fix code returned tabSize=3 here and yaml-language-server
		// re-serialized the doc at 3-space stride. tabSize MUST track the
		// content's own indent.
		expect(opts.tabSize).toBe(2);
		expect(opts.insertSpaces).toBe(true);
	});

	it("preserves 4-space indent when no .editorconfig is present", () => {
		const filePath = path.join(tempDir, "module.py");
		const src = ["def f():", "    return 1", ""].join("\n");
		expect(resolveFormatOptions(filePath, src).tabSize).toBe(4);
	});

	it("preserves tab indentation when no .editorconfig is present", () => {
		const filePath = path.join(tempDir, "main.go");
		const go = ["package main", "", "func main() {", '\tprintln("hi")', "}", ""].join("\n");
		const opts = resolveFormatOptions(filePath, go);
		expect(opts.insertSpaces).toBe(false);
	});

	it("honours `.editorconfig` indent_size over content sniffing", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_size = 4", "indent_style = space", ""].join("\n"),
		);
		const filePath = path.join(tempDir, "thing.yaml");
		// Content has 2-space indent but editorconfig says 4 — editorconfig wins.
		const opts = resolveFormatOptions(filePath, "foo:\n  bar: baz\n");
		expect(opts.tabSize).toBe(4);
		expect(opts.insertSpaces).toBe(true);
	});

	it("honours `.editorconfig` indent_style = tab over content sniffing", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_style = tab", "tab_width = 8", ""].join("\n"),
		);
		const filePath = path.join(tempDir, "Makefile");
		// Content is space-indented — editorconfig still wins.
		const opts = resolveFormatOptions(filePath, "all:\n  echo hi\n");
		expect(opts.insertSpaces).toBe(false);
		expect(opts.tabSize).toBe(8);
	});

	it("infers insertSpaces from `indent_size = <n>` when indent_style is unset", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_size = 2", ""].join("\n"),
		);
		const filePath = path.join(tempDir, "a.yaml");
		// Empty content can't sniff anything; editorconfig's `indent_size = 2`
		// must pin both tabSize AND insertSpaces (matching VSCode / Sublime).
		const opts = resolveFormatOptions(filePath, "");
		expect(opts.tabSize).toBe(2);
		expect(opts.insertSpaces).toBe(true);
	});

	it("always sets the static trim/newline flags", () => {
		const opts = resolveFormatOptions(path.join(tempDir, "x.txt"), "x\n");
		expect(opts.trimTrailingWhitespace).toBe(true);
		expect(opts.insertFinalNewline).toBe(true);
		expect(opts.trimFinalNewlines).toBe(true);
	});
});
