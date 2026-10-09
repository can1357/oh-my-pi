import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TspProps } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import type { StatusLineComponent } from "../src/status-line/component";
import { createStartupStatusLine } from "../src/status-line/startup";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setNativeRendering(false);
});

function statusLine(settings: StatusLineSettings): StatusLineComponent {
	return createStartupStatusLine({
		settings,
		gitEnabled: false,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
}

function isNode(child: NativeChild | undefined): child is NativeNode {
	return child !== undefined && "k" in child;
}

/** The `seg` facts of the composer's extras, in order. */
function facts(line: StatusLineComponent): { key: string; props: TspProps<"seg"> }[] {
	const extras = line.describeComposerFacts().extras;
	expect(extras.k).toBe("status");
	return (extras.c ?? [])
		.filter(isNode)
		.flatMap(child =>
			child.k === "seg" && child.key !== undefined ? [{ key: child.key, props: child.p ?? {} }] : [],
		);
}

describe("native composer facts", () => {
	it("applies compact context formatting to native facts and meter", () => {
		setNativeRendering(true);
		const line = createStartupStatusLine({
			settings: {
				preset: "custom",
				leftSegments: ["context_pct"],
				rightSegments: [],
				segmentOptions: { context_pct: { compact: true } },
			},
			gitEnabled: false,
			model: {
				id: "native-model",
				name: "Native",
				provider: "test",
				api: "test",
				contextWindow: 100_000,
			} as Parameters<typeof createStartupStatusLine>[0]["model"],
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			contextPercent: 9.1,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});

		try {
			const preview = line.describePreview();
			const contextSegment = (preview.c ?? []).filter(isNode).find(child => child.key === "context_pct");
			const contextJson = JSON.stringify(contextSegment);
			expect(contextJson).not.toContain('"icon"');
			expect(contextJson).toContain("ctx:?");
			const meter = line.describeComposerFacts().context;
			const meterJson = JSON.stringify(meter);
			expect(meterJson).toContain('"label":"ctx:?   "');
			expect(meterJson).not.toContain("ctx:9.1%");
			expect(meterJson).not.toContain('"total"');
		} finally {
			line.dispose();
		}
	});

	it("keeps the configured segments without another home, outer edges dropping last", () => {
		setNativeRendering(true);
		const segs = facts(
			statusLine({
				preset: "custom",
				leftSegments: ["hostname", "path", "session", "model"],
				rightSegments: ["session_name", "time", "context_pct", "cost"],
			}),
		);

		// Path goes to Tern's pane header, the session name to the tab title, the
		// model to its chip, context and cost to the hairline and usage text.
		expect(segs.map(seg => seg.key)).toEqual(["hostname", "session", "time"]);
		const priority = Object.fromEntries(segs.map(seg => [seg.key, seg.props.priority]));
		expect(priority.hostname!).toBeGreaterThan(priority.session!);
	});

	it("reorders priorities when the configured order changes", () => {
		setNativeRendering(true);
		const segs = facts(statusLine({ preset: "custom", leftSegments: ["session", "hostname"], rightSegments: [] }));
		const priority = Object.fromEntries(segs.map(seg => [seg.key, seg.props.priority]));
		expect(priority.session!).toBeGreaterThan(priority.hostname!);
	});

	it("describes spans without ANSI escapes or separator glyphs", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "full", separator: "powerline" });
		const json = JSON.stringify(line.describeComposerFacts());
		expect(json).not.toContain("\\u001b");
		for (const glyph of ["\ue0b0", "\ue0b2", "\ue0b1", "\ue0b3", "─", "│"]) expect(json).not.toContain(glyph);
		expect(facts(line).length).toBeGreaterThan(0);
	});

	it("returns the same facts while nothing changed and new ones after a change", () => {
		setNativeRendering(true);
		const line = statusLine({ preset: "custom", leftSegments: ["path", "mode"], rightSegments: [] });
		const first = line.describeComposerFacts();
		expect(line.describeComposerFacts()).toBe(first);

		line.setPlanModeStatus({ enabled: true, paused: false });
		expect(line.describeComposerFacts()).not.toBe(first);
		expect(facts(line).map(seg => seg.key)).toEqual(["mode"]);
	});
});
