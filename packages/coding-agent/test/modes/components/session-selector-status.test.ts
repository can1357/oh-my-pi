import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo, SessionStatus } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(async () => {
	await initTheme();
});

afterAll(async () => {
	// Other suites in the run share the global theme; restore the default preset.
	await initTheme();
});

function createSession(id: string, status: SessionStatus | undefined): SessionInfo {
	return {
		path: `/work/${id}.jsonl`,
		id,
		cwd: "/work",
		title: `Session ${id}`,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 2048,
		firstMessage: `first message ${id}`,
		allMessagesText: `first message ${id}`,
		status,
	};
}

function renderPlain(sessions: SessionInfo[]): string {
	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
		// Tall viewport so every asserted row is inside the visible window; these
		// tests cover status formatting, not the viewport-fit window sizing.
		{ getTerminalRows: () => 100 },
	);
	// Strip ANSI so assertions target the visible glyph/label, not theme colors.
	return selector
		.render(120)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("SessionSelectorComponent status labels", () => {
	it("renders each derived status as a themed glyph + label on the metadata line", () => {
		const rendered = renderPlain([
			createSession("complete", "complete"),
			createSession("interrupted", "interrupted"),
			createSession("aborted", "aborted"),
			createSession("error", "error"),
			createSession("pending", "pending"),
		]);

		expect(rendered).toContain(`${theme.status.success} done`);
		expect(rendered).toContain(`${theme.status.warning} interrupted`);
		expect(rendered).toContain(`${theme.status.aborted} aborted`);
		expect(rendered).toContain(`${theme.status.error} error`);
		expect(rendered).toContain(`${theme.status.pending} pending`);
	});

	it("draws the glyph from the active symbol preset (nerdfont / unicode / ascii)", async () => {
		const sessions = [createSession("complete", "complete")];
		const glyphs = new Set<string>();
		for (const preset of ["unicode", "nerd", "ascii"] as const) {
			await initTheme(false, preset);
			// The rendered glyph tracks whatever the active preset resolves.
			expect(renderPlain(sessions)).toContain(`${theme.status.success} done`);
			glyphs.add(theme.status.success);
		}
		// Each preset maps to a distinct glyph, so the status is genuinely
		// preset-aware rather than a hardcoded symbol.
		expect(glyphs.size).toBe(3);
	});

	it("omits the status segment when status is unknown or unset", () => {
		const rendered = renderPlain([createSession("a", "unknown"), createSession("b", undefined)]);

		// The session rows still render (titles present)…
		expect(rendered).toContain("Session a");
		expect(rendered).toContain("Session b");
		// …but no status label is emitted for either row.
		for (const label of ["done", "interrupted", "aborted", "error", "pending"]) {
			expect(rendered).not.toContain(label);
		}
	});
});
