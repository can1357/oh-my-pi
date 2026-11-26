import { describe, expect, it } from "bun:test";
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

	it("tokenizes each `;` entry alone, keeps internal URLs plain and never splits a character", () => {
		expect(target({ path: "src/[a*;ssh://[::1]/src/*.ts;docs/[😀-😎]" })).toEqual([
			{ t: "src/[a" },
			operator("*"),
			{ t: ";ssh://[::1]/src/*.ts;docs/" },
			operator("["),
			{ t: "😀-😎" },
			operator("]"),
		]);
	});

	it("keeps a target without glob syntax plain text for text-only consumers", () => {
		expect(target({ path: "src/[unclosed, a,b}" })).toBe("src/[unclosed, a,b}");
	});
});
