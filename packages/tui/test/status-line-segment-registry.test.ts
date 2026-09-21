import { describe, expect, it } from "bun:test";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext, StatusLineSegmentId } from "../src/status-line/types";

describe("status-line segment registry", () => {
	it("skips a segment id no renderer owns instead of crashing the status line", () => {
		// Settings only *warns* about a typo in `statusLine.leftSegments` and keeps the
		// id in the effective array, and the component hands those ids straight to
		// `renderSegment`. `SEGMENTS` is typed `Record<StatusLineSegmentId, …>`, so the
		// miss looks impossible and the lookup guard looks like dead code — drop it and
		// a single config typo throws on every frame, taking the status line with it.
		// (Registry/schema parity itself is compile-enforced by that same Record type.)
		const rendered = renderSegment("modle" as StatusLineSegmentId, {} as SegmentContext);

		expect(rendered).toEqual({ content: "", visible: false });
	});
});
