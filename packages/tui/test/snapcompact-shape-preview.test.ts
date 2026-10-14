import { beforeAll, describe, expect, it } from "bun:test";
import { getNativeBlob } from "@oh-my-pi/pi-tui/native/blobs";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { SnapcompactShapePreview } from "@oh-my-pi/pi-tui/overlays/snapcompact-shape-preview";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { ShapeTarget } from "@oh-my-pi/snapcompact";

const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
/** Cursor fits Claude images into 1024×1024, so every variant's frame is capped there. */
const CURSOR_CLAUDE: ShapeTarget = { provider: "cursor", api: "cursor-agent", id: "claude-opus-5-high" };

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(theme);
});

/** A preview whose async sample renders can be awaited. */
interface PreviewHarness {
	component: SnapcompactShapePreview;
	/** Resolves at the component's next `requestRender`, i.e. when a sample render settles. */
	rendered: () => Promise<void>;
}

function preview(model: ShapeTarget): PreviewHarness {
	let settled = Promise.withResolvers<void>();
	const component = new SnapcompactShapePreview("auto", { model, requestRender: () => settled.resolve() });
	return {
		component,
		rendered: () => {
			settled = Promise.withResolvers<void>();
			return settled.promise;
		},
	};
}

/** Select `value` and describe until its sample settles: the caption line and the sample's PNG bytes. */
async function show(
	{ component, rendered }: PreviewHarness,
	value: string,
): Promise<{ caption: string; png: Uint8Array }> {
	component.setValue(value);
	for (;;) {
		const [caption, sample] = component.describe(CX).c as NativeNode[];
		if (sample.k === "spinner") {
			await rendered();
			continue;
		}
		if (caption.k !== "text" || sample.k !== "image")
			throw new Error(`no ${value} sample: ${JSON.stringify(sample)}`);
		const png = sample.p?.blob ? getNativeBlob(sample.p.blob)?.bytes : undefined;
		if (!png) throw new Error(`no ${value} sample bytes`);
		return { caption: (caption.p?.spans ?? []).map(span => span.t).join(""), png };
	}
}

describe("snapcompact shape preview", () => {
	it("names each variant, not the frame edge, when the host caps frames", async () => {
		const cursor = preview(CURSOR_CLAUDE);
		const auto = await show(cursor, "auto");
		// 11on16 at Cursor's 1024px edge: 1024/11 × 1024/16 cells, (1024/28)² tokens.
		expect(auto.caption).toContain("· auto → 11on16-bw · full frame 93×64 cells");
		expect(auto.caption).toContain("≈ 1.4k tokens");
		for (const variant of ["11on16-bw", "silver16-bw", "8on22-bw", "5x8-bw", "doc-8on16-bw"]) {
			expect((await show(cursor, variant)).caption).toContain(`· ${variant} · full frame`);
		}
		expect((await show(cursor, "silver16-bw")).caption).toContain("full frame 64×64 cells");
	});

	it("names auto's geometry on a model line that widens the frame", async () => {
		const opus = preview({ provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5" });
		expect((await show(opus, "auto")).caption).toContain("· auto → 11on16-bw · full frame 175×120 cells");
	});

	it("renders a separate sample for each variant", async () => {
		const cursor = preview(CURSOR_CLAUDE);
		const tracked = await show(cursor, "11on16-bw");
		const silver = await show(cursor, "silver16-bw");
		expect(Buffer.from(silver.png).equals(Buffer.from(tracked.png))).toBe(false);
		// auto resolves to 11on16-bw here, so it shares that sample.
		expect(Buffer.from((await show(cursor, "auto")).png).equals(Buffer.from(tracked.png))).toBe(true);
	});
});
