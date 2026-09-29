import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { taskToolRenderer } from "@oh-my-pi/pi-tui/tools/task";

// Regression: tool-call payload echoes ran through the markdown/LaTeX
// typesetter and came out corrupted — `$(grep -c A_rows $P)` echoed as
// `(grep -c Aᵣows P)` (a `$$` shell-PID pair opens a math span that consumes
// `$…$` sigils and subscript-converts `_r`), and prose wrap inserted hard
// breaks mid-string so the echo no longer matched the payload's line
// structure. Tool-call parameters and command echoes are payloads, not prose:
// the echo must byte-match what will be dispatched, modulo the display
// sanitization convention (ANSI/control strip, tab expansion).

const PAYLOAD_LINES = [
	"pid=$$",
	"run: $(grep -c A_rows $P)",
	'grep "\\(A_rows\\)" $P',
	`${"x".repeat(420)} END`,
	"done $$",
];
const PAYLOAD = PAYLOAD_LINES.join("\n");
const SUBSCRIPT_R = "ᵣ";

/** Body rows of a framed card with the border and cell padding stripped. */
function frameBodyRows(
	theme: Theme,
	card: { render(width: number): readonly string[] },
	width: number,
): string[] {
	const border = theme.boxRound.vertical;
	return Bun.stripANSI(card.render(width).join("\n"))
		.split("\n")
		.map(row => row.split(border))
		.filter(parts => parts.length === 3)
		.map(parts => parts[1]!.slice(1, -1).trimEnd());
}

describe("tool-call payload echoes render byte-verbatim", () => {
	let theme: Theme;

	beforeAll(async () => {
		const resolved = await getThemeByName("dark");
		expect(resolved).toBeDefined();
		theme = resolved!;
		setThemeInstance(theme);
	});

	// If the brief is typeset, a `$$` shell-PID pair swallows the payload into a
	// math span: the user sees `(grep -c Aᵣows P)` instead of their command and
	// the brief's lines merged/re-flowed.
	it("echoes the task brief payload byte-verbatim (task param)", () => {
		const card = taskToolRenderer.renderCall(
			{ name: "Echo", task: PAYLOAD },
			{ expanded: false, isPartial: false },
			theme,
		);
		const rows = frameBodyRows(theme, card, 500);
		for (const line of PAYLOAD_LINES) expect(rows).toContain(line);
		const joined = rows.join("\n");
		expect(joined).not.toContain(SUBSCRIPT_R);
		expect(joined).toContain("$(grep -c A_rows $P)");
	});

	it("echoes the shared context payload byte-verbatim (context param)", () => {
		const card = taskToolRenderer.renderCall({ context: PAYLOAD }, { expanded: false, isPartial: false }, theme);
		const rows = frameBodyRows(theme, card, 500);
		for (const line of PAYLOAD_LINES) expect(rows).toContain(line);
		expect(rows.join("\n")).not.toContain(SUBSCRIPT_R);
	});

	// If the frame prose-wraps echo rows, a long command line breaks into
	// several rows at width-dependent points indistinguishable from real
	// newlines — the echo misrepresents the command's line structure.
	it("keeps one bash command echo row per source line at narrow widths", () => {
		const card = bashToolRenderer.renderCall({ command: PAYLOAD }, { expanded: false, isPartial: false }, theme);
		const rows = frameBodyRows(theme, card, 80);
		expect(rows).toHaveLength(PAYLOAD_LINES.length);
		const joined = rows.join("\n");
		expect(joined).toContain("$(grep -c A_rows $P)");
		expect(joined).not.toContain(SUBSCRIPT_R);
		for (let i = 1; i < PAYLOAD_LINES.length; i++) {
			// Overflow clips to a byte-prefix of the source line; it never re-flows.
			expect(rows[i]!.startsWith(PAYLOAD_LINES[i]!.slice(0, 40))).toBe(true);
		}
	});

	it("echoes the bash command byte-identical when it fits the frame", () => {
		const card = bashToolRenderer.renderCall({ command: PAYLOAD }, { expanded: false, isPartial: false }, theme);
		const rows = frameBodyRows(theme, card, 500);
		expect(rows).toHaveLength(PAYLOAD_LINES.length);
		// Row 0 carries the dim `$ ` prompt prefix chrome; the command bytes trail it.
		expect(rows[0]!.endsWith(PAYLOAD_LINES[0]!)).toBe(true);
		for (let i = 1; i < PAYLOAD_LINES.length; i++) {
			expect(rows[i]).toBe(PAYLOAD_LINES[i]);
		}
	});
});
