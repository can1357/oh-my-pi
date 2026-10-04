import { beforeAll, describe, expect, it } from "bun:test";
import { createStartupStatusLine } from "../src/status-line/startup";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

describe("status line peers segment", () => {
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
			expect(JSON.stringify(line.describeComposerFacts())).toContain("peers:project-1234abcd (send)");
			line.setPeersStatus(undefined);
			expect(Bun.stripANSI(line.render(200).join("\n"))).not.toContain("peers:");
			expect(JSON.stringify(line.describeComposerFacts())).not.toContain("peers:");
		} finally {
			line.dispose();
		}
	});
});
