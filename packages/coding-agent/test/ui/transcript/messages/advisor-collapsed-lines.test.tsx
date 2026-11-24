/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `display.advisorCollapsedLines`: a collapsed advisor card shows at most
 * that many note rows under its head; expanded, or with the setting at 0,
 * every row shows.
 */
import { describe, expect, test } from "bun:test";
import { createRoot, isUiNode, type Reactive, signal } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { AdvisorMessageDetails } from "../../../../src/session/transcript/messages";
import { AdvisorMessage } from "../../../../src/ui/transcript/messages/advisor-message";
import "../../../../src/ui/styles/messages";

const env = staticEnvironment(loadThemeSync("dark"));
const NOTE =
	"This is a very long advisor note that will definitely exceed the restricted width constraint of thirty characters and should therefore wrap across multiple lines rather than getting truncated.";
const details: AdvisorMessageDetails = { notes: [{ note: NOTE, severity: "concern" }] };

/** The card's plain rows at width 30. */
function rows(expanded: Reactive<boolean>, collapsedLines?: Reactive<number>): string[] {
	return createRoot(dispose => {
		try {
			const node = <AdvisorMessage details={details} expanded={expanded} collapsedLines={collapsedLines} />;
			if (!isUiNode(node)) throw new Error("expected one node");
			return paintNode(env, node, 30).rows.map(row => stripEscapes(row).trimEnd());
		} finally {
			dispose();
		}
	});
}

describe("advisor collapsed lines", () => {
	test("caps a collapsed card's note rows and shows every row when expanded", () => {
		const full = rows(false);
		expect(full.length).toBeGreaterThan(3);
		expect(full.join("\n")).toContain("truncated.");

		const capped = rows(false, 1);
		expect(capped).toEqual(full.slice(0, 2));
		expect(capped.join("\n")).not.toContain("truncated.");

		expect(rows(true, 1)).toEqual(rows(true));
		expect(rows(true, 1).join("\n")).toContain("truncated.");
		expect(rows(false, 0)).toEqual(full);
	});

	test("follows the setting as it changes", () => {
		const lines = signal(2);
		const expanded = signal(false);
		createRoot(dispose => {
			try {
				const node = <AdvisorMessage details={details} expanded={expanded} collapsedLines={lines} />;
				if (!isUiNode(node)) throw new Error("expected one node");
				expect(paintNode(env, node, 30).rows).toHaveLength(3);
				lines.set(0);
				expect(paintNode(env, node, 30).rows.length).toBeGreaterThan(3);
			} finally {
				dispose();
			}
		});
	});
});
