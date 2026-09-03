import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	cursorEditOwnedReadPath,
	cursorRawReadPath,
	omitUndefinedArgs,
	piGrepSkip,
	piReadPath,
} from "../src/providers/cursor-pi-args";

import type { Tool } from "../src/types";
import { validateToolArguments } from "../src/utils/validation";

describe("omitUndefinedArgs", () => {
	it("drops keys whose value is undefined and keeps defined optionals", () => {
		expect(
			omitUndefinedArgs({
				command: "pwd",
				cwd: undefined,
				timeout: 30,
			}),
		).toEqual({ command: "pwd", timeout: 30 });
		expect(
			omitUndefinedArgs({
				pattern: "needle",
				path: ".",
				case: false,
				skip: piGrepSkip(undefined),
			}),
		).toEqual({ pattern: "needle", path: ".", case: false });
	});

	it("makes Cursor-style bash/grep frames pass ArkType optional-field validation", () => {
		const bashTool: Tool = {
			name: "bash",
			description: "",
			parameters: type({
				command: type("string").describe("command to execute"),
				"timeout?": type("number").describe("timeout"),
				"cwd?": type("string").describe("working directory"),
			}),
		};
		const grepTool: Tool = {
			name: "grep",
			description: "",
			parameters: type({
				pattern: type("string").describe("regex pattern"),
				"path?": type("string").describe("path"),
				"case?": type("boolean").describe("case-sensitive search"),
				"skip?": type("number").or("null").describe("files to skip"),
			}),
		};

		// Mirrors the Cursor bridge: empty workingDirectory → `cwd: undefined`.
		const workingDirectory = "";
		const rawBash = {
			command: "git status",
			cwd: workingDirectory || undefined,
			timeout: 30,
		};
		expect(() =>
			validateToolArguments(bashTool, { type: "toolCall", id: "b1", name: "bash", arguments: rawBash }),
		).toThrow(/cwd must be working directory \(was undefined\)/);
		expect(
			validateToolArguments(bashTool, {
				type: "toolCall",
				id: "b2",
				name: "bash",
				arguments: omitUndefinedArgs(rawBash),
			}),
		).toEqual({ command: "git status", timeout: 30 });

		// Mirrors the Cursor bridge: caseInsensitive unset → `case: undefined`.
		const caseInsensitive: boolean | undefined = undefined;
		const rawGrep = {
			pattern: "needle",
			path: ".",
			case: caseInsensitive === true ? false : undefined,
			skip: piGrepSkip(undefined),
		};
		expect(() =>
			validateToolArguments(grepTool, { type: "toolCall", id: "g1", name: "grep", arguments: rawGrep }),
		).toThrow(/case must be case-sensitive search \(was undefined\)/);
		expect(
			validateToolArguments(grepTool, {
				type: "toolCall",
				id: "g2",
				name: "grep",
				arguments: omitUndefinedArgs(rawGrep),
			}),
		).toEqual({ pattern: "needle", path: "." });
	});
});

describe("cursorRawReadPath", () => {
	it("appends :raw to a whole-file path so hashline markup is not returned", () => {
		expect(cursorRawReadPath("/tmp/note.txt")).toBe("/tmp/note.txt:raw");
	});

	it("inserts raw before an existing line range instead of dropping the range", () => {
		expect(cursorRawReadPath("/tmp/note.txt:10-20")).toBe("/tmp/note.txt:raw:10-20");
	});

	it("leaves a path that already carries raw alone", () => {
		expect(cursorRawReadPath("/tmp/note.txt:raw")).toBe("/tmp/note.txt:raw");
		expect(cursorRawReadPath("/tmp/note.txt:raw:2+3")).toBe("/tmp/note.txt:raw:2+3");
	});

	it("does not stack a second :raw when a range is composed onto a raw path", () => {
		expect(piReadPath("/tmp/note.txt:raw", 2, 1)).toBe("/tmp/note.txt:raw:2+1");
		expect(cursorEditOwnedReadPath("/tmp/note.txt", 2, 1)).toBe("/tmp/note.txt:raw:2+1");
	});
});
