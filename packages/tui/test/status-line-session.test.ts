import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

// Two sessions created 18 s apart. Their first 8 hex digits match, so an 8-character
// prefix showed both as `01a03242` and a user could not tell the sessions apart.
const FIRST_SESSION = "01a03242-993e-73f7-9bb9-4be42368e12f";
const SECOND_SESSION = "01a03242-e0d8-7074-806e-79104cd3e1d3";

function sessionContext(sessionId: string): SegmentContext {
	return { session: { sessionManager: { getSessionId: () => sessionId } } } as unknown as SegmentContext;
}

describe("session status-line segment", () => {
	it("renders the 13-character prefix so sessions created close together stay distinct", () => {
		const first = Bun.stripANSI(renderSegment("session", sessionContext(FIRST_SESSION)).content);
		const second = Bun.stripANSI(renderSegment("session", sessionContext(SECOND_SESSION)).content);

		expect(first).toEndWith("01a03242-993e");
		expect(second).toEndWith("01a03242-e0d8");
	});

	it("describes the same 13-character prefix for a native terminal", () => {
		const text = (sessionId: string) =>
			describeSegment("session", sessionContext(sessionId))
				?.spans.map(s => s.t)
				.join("");

		expect(text(FIRST_SESSION)).toBe("01a03242-993e");
		expect(text(SECOND_SESSION)).toBe("01a03242-e0d8");
	});
});
