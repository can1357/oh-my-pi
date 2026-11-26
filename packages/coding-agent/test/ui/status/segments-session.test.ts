/**
 * The status line's `session` segment (upstream packages/tui/test/status-line-session.test.ts),
 * as the native bar's spans and the terminal's look pieces.
 */
import { describe, expect, it } from "bun:test";
import { effectiveStatusSettings, segmentView } from "../../../src/ui/status/segments";
import { corpusStatusFacts } from "./fixture";

const settings = effectiveStatusSettings({ preset: "custom", sessionAccent: false });

// Two sessions created 18 s apart. Their first 8 hex digits match, so an 8-character
// prefix showed both as `01a03242` and a user could not tell the sessions apart.
const FIRST_SESSION = "01a03242-993e-73f7-9bb9-4be42368e12f";
const SECOND_SESSION = "01a03242-e0d8-7074-806e-79104cd3e1d3";

function sessionView(sessionId: string) {
	return segmentView("session", { ...corpusStatusFacts(), sessionId }, settings);
}

describe("status line session segment", () => {
	it("shows the 13-character prefix so sessions created close together stay distinct", () => {
		expect(sessionView(FIRST_SESSION)?.spans.map(part => part.t).join("")).toBe("01a03242-993e");
		expect(sessionView(SECOND_SESSION)?.spans.map(part => part.t).join("")).toBe("01a03242-e0d8");
	});

	it("draws the same 13-character prefix in the terminal's look", () => {
		expect(sessionView(FIRST_SESSION)?.look.pieces.at(-1)).toEqual({ t: "01a03242-993e" });
		expect(sessionView(SECOND_SESSION)?.look.pieces.at(-1)).toEqual({ t: "01a03242-e0d8" });
	});
});
