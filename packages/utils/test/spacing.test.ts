import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { getEditorConfigFormatting } from "@oh-my-pi/pi-utils/tab-spacing";

describe("getEditorConfigFormatting", () => {
	let tempDir = "";
	let previousProjectDir = "";

	beforeEach(async () => {
		previousProjectDir = getProjectDir();
		tempDir = path.join(os.tmpdir(), "pi-utils-editorconfig-formatting", Snowflake.next());
		await fs.mkdir(tempDir, { recursive: true });
		setProjectDir(tempDir);
	});

	afterEach(async () => {
		setProjectDir(previousProjectDir);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("returns an empty object when no .editorconfig is present", () => {
		expect(getEditorConfigFormatting(path.join(tempDir, "a.yaml"))).toEqual({});
	});

	it("derives tabSize and insertSpaces from `indent_size = <n>` (insertSpaces inferred)", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_size = 2", ""].join("\n"),
		);
		expect(getEditorConfigFormatting(path.join(tempDir, "a.yaml"))).toEqual({
			tabSize: 2,
			insertSpaces: true,
		});
	});

	it("derives insertSpaces=false and tabSize from `indent_style = tab` + `tab_width`", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_style = tab", "tab_width = 4", ""].join("\n"),
		);
		expect(getEditorConfigFormatting(path.join(tempDir, "Makefile"))).toEqual({
			tabSize: 4,
			insertSpaces: false,
		});
	});

	it("treats `indent_size = tab` as tabs", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_size = tab", "tab_width = 8", ""].join("\n"),
		);
		expect(getEditorConfigFormatting(path.join(tempDir, "x.go"))).toEqual({
			tabSize: 8,
			insertSpaces: false,
		});
	});

	it("leaves tabSize undefined when only indent_style = tab is set (no tab_width)", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_style = tab", ""].join("\n"),
		);
		const result = getEditorConfigFormatting(path.join(tempDir, "x.go"));
		expect(result.insertSpaces).toBe(false);
		expect(result.tabSize).toBeUndefined();
	});

	it("returns the deepest section's values when sections overlap", async () => {
		// `[*.md]` should win for markdown files; the more general `[*]` block
		// supplies the indent_style default.
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_size = 2", "", "[*.md]", "indent_size = 4", ""].join("\n"),
		);
		expect(getEditorConfigFormatting(path.join(tempDir, "README.md")).tabSize).toBe(4);
		expect(getEditorConfigFormatting(path.join(tempDir, "a.yaml")).tabSize).toBe(2);
	});

	it("never throws on null/empty paths or paths with overlong components", () => {
		expect(getEditorConfigFormatting(null)).toEqual({});
		expect(getEditorConfigFormatting("")).toEqual({});
		const overlong = `${"a".repeat(2048)}/leaf.ts`;
		expect(() => getEditorConfigFormatting(overlong)).not.toThrow();
		expect(getEditorConfigFormatting(overlong)).toEqual({});
	});

	it("tolerates filesystem errors while walking the editorconfig chain (ENOTDIR)", async () => {
		const notADir = path.join(tempDir, "not-a-dir");
		await fs.writeFile(notADir, "");
		const fakeChild = path.join(notADir, "inner.ts");
		expect(() => getEditorConfigFormatting(fakeChild)).not.toThrow();
		expect(getEditorConfigFormatting(fakeChild)).toEqual({});
	});
});
