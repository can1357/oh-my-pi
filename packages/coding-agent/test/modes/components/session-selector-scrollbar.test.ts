import { beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(() => {
	initTheme();
});

const THUMB = "\u2588"; // ScrollView thumb glyph

function makeSessions(count: number): SessionInfo[] {
	return Array.from({ length: count }, (_, i) => ({
		path: `/work/TITLE_${i}.jsonl`,
		id: `id-${i}`,
		cwd: "/work",
		title: `TITLE_${i}`,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 1024,
		firstMessage: `body content ${i}`,
		allMessagesText: `body content ${i}`,
	}));
}

function makeSelector(sessions: SessionInfo[], rows: number): SessionSelectorComponent {
	return new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
		{ getTerminalRows: () => rows },
	);
}

describe("SessionSelectorComponent scrollbar", () => {
	it("renders the ScrollView thumb when sessions overflow the viewport", () => {
		// 50 titled sessions cannot fit a 30-row viewport, so the picker windows
		// them and must surface the shared right-edge scrollbar (the /resume
		// overflow path the user reported).
		const out = makeSelector(makeSessions(50), 30).render(80).join("\n");
		expect(out).toContain(THUMB);
		// The old text position indicator must be gone.
		expect(out).not.toContain("(1/50)");
	});

	it("omits the scrollbar when every session fits", () => {
		const out = makeSelector(makeSessions(2), 40).render(80).join("\n");
		expect(out).not.toContain(THUMB);
	});
});
