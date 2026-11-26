import { describe, expect, it } from "bun:test";
import "../../../src/ui/styles/tools/glob";
import type { ToolViewState } from "../../../src/ui/tools/contract";
import { globPresenter } from "../../../src/ui/tools/glob";
import { toolScreenSuite } from "./presenter-corpus";

toolScreenSuite("glob", "glob", globPresenter);

describe("glob head target", () => {
	const state: ToolViewState = { expanded: false, isPartial: false, argsComplete: true, executionStarted: false };
	const target = (path: string | string[]) => globPresenter.call!({ path }, state)?.head?.target;

	it("styles glob syntax as the regex grammar styles its equivalents; path text, separators and backslashes stay plain", () => {
		expect(target(["src/[!a-z]?.{ts,tsx}", "lib;!dist\\[]]*"])).toEqual([
			{ t: "src/" },
			{ t: "[!", s: "syntaxKeyword" },
			{ t: "a-z", s: "syntaxNumber" },
			{ t: "]?", s: "syntaxKeyword" },
			{ t: "." },
			{ t: "{", s: "syntaxKeyword" },
			{ t: "ts" },
			{ t: ",", s: "syntaxKeyword" },
			{ t: "tsx" },
			{ t: "}", s: "syntaxKeyword" },
			{ t: ", lib;!dist\\" },
			// A `]` right after `[` is a class member, not its close.
			{ t: "[", s: "syntaxKeyword" },
			{ t: "]" },
			{ t: "]*", s: "syntaxKeyword" },
		]);
	});

	it("keeps a target without glob syntax plain text for text-only consumers", () => {
		expect(target("src/[unclosed, a,b!")).toBe("src/[unclosed, a,b!");
	});
});
