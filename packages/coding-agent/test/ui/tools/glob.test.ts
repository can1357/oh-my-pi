import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import "../../../src/ui/styles/tools/glob";
import type { ToolViewState } from "../../../src/ui/tools/contract";
import { type GlobArgs, globPresenter } from "../../../src/ui/tools/glob";
import { toolScreenSuite } from "./presenter-corpus";

toolScreenSuite("glob", "glob", globPresenter);

describe("glob head target", () => {
	const state: ToolViewState = { expanded: false, isPartial: false, argsComplete: true, executionStarted: false };
	const target = (args: GlobArgs) => globPresenter.call!(args, state)?.head?.target;
	const operator = (t: string) => ({ t, s: "syntaxKeyword" });

	it("highlights the globs searched, a separate pattern scoped under the path", () => {
		// `[!]_]`: a `]` right after the negation is a class member, not its close.
		expect(target({ path: "src", pattern: "**/*.{ts,tsx};[!]_]?" })).toEqual([
			{ t: "src/" },
			operator("**"),
			{ t: "/" },
			operator("*"),
			{ t: "." },
			operator("{"),
			{ t: "ts" },
			operator(","),
			{ t: "tsx" },
			operator("}"),
			{ t: ";src/" },
			operator("[!"),
			{ t: "]_" },
			operator("]?"),
		]);
	});

	it("tokenizes each `;` entry alone, keeps URLs plain and never splits a character", () => {
		expect(target({ path: "src/[a*;ssh://[::1]/src/*.ts;docs/[😀-😎]" })).toEqual([
			{ t: "src/[a" },
			operator("*"),
			{ t: ";ssh://[::1]/src/*.ts;docs/" },
			operator("["),
			{ t: "😀-😎" },
			operator("]"),
		]);
		// A URL's own path may hold `;`: the tool keeps a URL-led mixed list whole.
		expect(target({ path: "local://reports;old/*.md" })).toBe("local://reports;old/*.md");
	});

	it("shortens a searched path under home to `~`", () => {
		expect(target({ pattern: path.join(os.homedir(), "project", "**", "*.ts") })).toEqual([
			{ t: "~/project/" },
			operator("**"),
			{ t: "/" },
			operator("*"),
			{ t: ".ts" },
		]);
	});

	it("keeps a target without glob syntax plain text for text-only consumers", () => {
		expect(target({ path: "src/[unclosed, a,b}" })).toBe("src/[unclosed, a,b}");
	});
});
