import { beforeAll, describe, expect, it } from "bun:test";
import { describeSegment, renderSegment, type SegmentContext } from "../src/status-line/segments";
import { createStartupStatusLine } from "../src/status-line/startup";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

describe("status line peers segment", () => {
	it("is hidden without a peers context", () => {
		const ctx = { width: 120, options: {} } as unknown as SegmentContext;
		expect(renderSegment("peers", ctx)).toEqual({ content: "", visible: false });
		expect(describeSegment("peers", ctx)).toBeNull();
	});

	it("shows the session address and marks send-only sessions", () => {
		for (const receiving of [true, false]) {
			const ctx = {
				width: 120,
				options: {},
				peers: { address: "project-1234abcd.abcdef12", receiving },
			} as unknown as SegmentContext;
			const label = `peers:project-1234abcd.abcdef12${receiving ? "" : " (send)"}`;
			const rendered = renderSegment("peers", ctx);
			expect(rendered.visible).toBe(true);
			expect(Bun.stripANSI(rendered.content)).toBe(label);
			expect(
				describeSegment("peers", ctx)
					?.spans.map(span => span.t)
					.join(""),
			).toBe(label);
		}
	});

	it("plumbs changes into the default footer and invalidates native facts", () => {
		const line = createStartupStatusLine({
			settings: { preset: "default" },
			gitEnabled: false,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});
		line.setComposerStyle({ statusAttachment: "none", bottomBar: "full", bottomBarGap: false });
		try {
			expect(Bun.stripANSI(line.render(200).join("\n"))).not.toContain("peers:");
			const first = line.describeComposerFacts();
			line.setPeersStatus({ address: "project-1234abcd", receiving: true });
			expect(Bun.stripANSI(line.render(200).join("\n"))).toContain("peers:project-1234abcd");
			const receivingFacts = line.describeComposerFacts();
			expect(receivingFacts).not.toBe(first);
			expect(JSON.stringify(receivingFacts)).toContain("peers:project-1234abcd");
			line.setPeersStatus({ address: "project-1234abcd", receiving: false });
			expect(Bun.stripANSI(line.render(200).join("\n"))).toContain("peers:project-1234abcd (send)");
			expect(line.describeComposerFacts()).not.toBe(receivingFacts);
			line.setPeersStatus(undefined);
			expect(Bun.stripANSI(line.render(200).join("\n"))).not.toContain("peers:");
			expect(JSON.stringify(line.describeComposerFacts())).not.toContain("peers:");
		} finally {
			line.dispose();
		}
	});
});
