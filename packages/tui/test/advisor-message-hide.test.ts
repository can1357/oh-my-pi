import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createAdvisorMessageCard } from "@oh-my-pi/pi-tui/chat/advisor-message";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

// The advisor card ignores the describe context.
const noCx = {} as DescribeContext;

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	setChatTranscriptDisplayPreferences({ hideAdvisorNotes: false });
});

describe("display.hideAdvisorNotes", () => {
	const details = { notes: [{ note: "Check the cache", severity: "blocker" as const }] };

	it("renders no rows while hidden and shows the same card again when turned off", () => {
		const card = createAdvisorMessageCard(details, () => false, theme);
		expect(card.render(80).join("\n")).toContain("Check the cache");

		setChatTranscriptDisplayPreferences({ hideAdvisorNotes: true });
		card.invalidate?.();
		expect(card.render(80)).toEqual([]);

		setChatTranscriptDisplayPreferences({ hideAdvisorNotes: false });
		card.invalidate?.();
		expect(card.render(80).join("\n")).toContain("Check the cache");
	});

	it("marks the native node hidden while the setting is on", () => {
		const card = createAdvisorMessageCard(details, () => false, theme);
		expect(card.describe?.(noCx)).not.toMatchObject({ p: { hidden: true } });
		setChatTranscriptDisplayPreferences({ hideAdvisorNotes: true });
		expect(card.describe?.(noCx)).toMatchObject({ p: { hidden: true } });
	});
});
