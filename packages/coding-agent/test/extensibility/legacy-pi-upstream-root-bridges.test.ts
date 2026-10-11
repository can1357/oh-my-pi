import { describe, expect, it } from "bun:test";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import * as caShim from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import * as tuiShim from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-tui-shim";

// Upstream pi-coding-agent exports `parseSkillBlock` from its package root
// (src/core/agent-session.ts) and upstream pi-tui exports `compositeTuiLine`
// from its package root. omp folds skill invocation into its own hook
// pipeline (no parser exported) and its canonical composite helper
// (`compositeLineAt`) diverges from upstream (SGR-only reset, image-line
// overlay replacement), so both names are ported into the compat layer;
// named imports of either from the aliased roots tripped Bun's static
// "Export named X not found" check (observed consumer: `pi-optchat`, which
// uses `parseSkillBlock` to match journaled skill invocations and
// `compositeTuiLine` to overlay its agent-view status line).
describe("legacy shim upstream-root bridges", () => {
	it("parseSkillBlock parses a skill block with its optional user message", () => {
		const parsed = caShim.parseSkillBlock('<skill name="commit" location="/skills/commit.md">\nbody text\n</skill>');
		expect(parsed).toEqual({
			name: "commit",
			location: "/skills/commit.md",
			content: "body text",
			userMessage: undefined,
		});
		const withMessage = caShim.parseSkillBlock(
			'<skill name="review" location="/skills/review.md">\nbody\n</skill>\n\nuser asked for review',
		);
		expect(withMessage?.userMessage).toBe("user asked for review");
		expect(caShim.parseSkillBlock("plain text")).toBeNull();
		expect(caShim.parseSkillBlock('<skill name="x" location="y">no trailing newline</skill>')).toBeNull();
	});

	it("compositeTuiLine matches upstream splice geometry and OSC-8 reset semantics", () => {
		const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, "");

		// Geometry: splice at column, pad to slot, clamp to totalWidth.
		expect(strip(tuiShim.compositeTuiLine("abcdefgh", "XY", 2, 2, 8))).toBe("abXYefgh");
		expect(strip(tuiShim.compositeTuiLine("abcdefgh", "XYZ", 0, 3, 8))).toBe("XYZdefgh");

		// Hyperlink contract (upstream SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07"):
		// a base line carrying an OSC 8 link must not let the overlay inherit
		// the link. The link opener is in the prefix; the reset immediately
		// before the overlay must close it.
		const linked = "\x1b]8;;https://example.test\x07abcdefgh\x1b]8;;\x07";
		const composed = tuiShim.compositeTuiLine(linked, "XY", 2, 2, 8);
		const xyAt = composed.indexOf("XY");
		expect(xyAt).toBeGreaterThanOrEqual(0);
		const prefix = composed.slice(0, xyAt);
		expect(prefix).toContain("\x1b]8;;https://example.test\x07"); // opener preserved in prefix
		expect(prefix.endsWith("\x1b]8;;\x07")).toBe(true); // link closed immediately before overlay
		expect(composed.slice(xyAt + 2)).not.toContain("https://example.test"); // overlay is not a link

		// Width clamp survives the extra reset bytes.
		expect(visibleWidth(tuiShim.compositeTuiLine("abcdefgh", "TOOLONGOVERLAY", 0, 3, 8))).toBeLessThanOrEqual(8);
	});

	it("passes image-line bases through untouched, upstream semantics", () => {
		// Upstream compositeTuiLine returns ANY image-line base unchanged;
		// omp's canonical compositeLineAt deliberately differs (it replaces
		// full-width overlays over image lines). The compat export must match
		// upstream for both partial and full-width overlays.
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = TERMINAL.imageProtocol;
		mutable.imageProtocol = ImageProtocol.Sixel;
		try {
			const base = "\x1bP0;1q#0:R=600,500qSTUBLINE";
			expect(TERMINAL.isImageLine(base)).toBe(true);
			expect(tuiShim.compositeTuiLine(base, "XY", 2, 2, 8)).toBe(base);
			expect(tuiShim.compositeTuiLine(base, "OVERLAY1", 0, 8, 8)).toBe(base);
		} finally {
			mutable.imageProtocol = originalProtocol;
		}
	});
});
