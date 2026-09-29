import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { taskToolRenderer } from "@oh-my-pi/pi-tui/tools/task";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";
import { renderCodeCell } from "@oh-my-pi/pi-tui/render/code-cell";
import { plainToolCard } from "@oh-my-pi/pi-tui/render/tool-card";

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
/** One source line longer than any test frame width: 204 visible columns. */
const LONG_SOURCE = "x".repeat(204);
const SUBSCRIPT_R = "ᵣ";

/**
 * Body rows of a framed card with the border and cell padding columns
 * stripped. Rows keep their bytes — including the frame's right pad-to-width —
 * so byte-identical assertions compare against the source line padded to the
 * frame's inner width.
 */
function frameRowsRaw(theme: Theme, rendered: readonly string[]): string[] {
	const border = theme.boxRound.vertical;
	return Bun.stripANSI(rendered.join("\n"))
		.split("\n")
		.map(row => row.split(border))
		.filter(parts => parts.length === 3)
		.map(parts => parts[1]!.slice(1, -1));
}

// Six call sites share this extraction (border/pad columns stripped, frame's
// right pad-to-width trimmed); lockstep behavior matters for every assertion.
function frameBodyRows(theme: Theme, card: { render(width: number): readonly string[] }, width: number): string[] {
	return frameRowsRaw(theme, card.render(width)).map(row => row.trimEnd());
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
		// Byte-fidelity discriminator is the blank row: the non-verbatim frame
		// right-trims (`line.trimEnd()`), but plain trailing spaces are absorbed
		// by the frame's pad-to-width (stripped + re-padded renders an identical
		// row) and highlighted trailing runs sit before their closing SGR code,
		// where trimEnd is a no-op. A whitespace-only row is left UNSTYLED by the
		// highlighter, and its U+00A0 blanks are stripped by trimEnd but cannot
		// be re-emulated by pad-to-width — so this test fails if the echo path
		// ever leaves the verbatim convention.
		const payload = ["pid=$$", "run: $(grep -c A_rows $P)", "trailing ws: A_rows $P  ", "\u00a0\u00a0", "done $"];
		const card = bashToolRenderer.renderCall(
			{ command: payload.join("\n") },
			{ expanded: false, isPartial: false },
			theme,
		);
		// Frame width 500: 2 borders + 1-col padding per side = 496 inner cols.
		const innerWidth = 496;
		const rows = frameRowsRaw(theme, card.render(500));
		expect(rows).toHaveLength(payload.length);
		// Row 0 carries the dim `$ ` prompt prefix chrome; the command bytes trail it.
		expect(rows[0]).toBe(`$ ${payload[0]}`.padEnd(innerWidth));
		for (let i = 1; i < payload.length; i++) {
			expect(rows[i]).toBe(payload[i]!.padEnd(innerWidth));
		}
	});

	// A tool PARAMETER follows the parameter convention (`sanitizeCarriageReturns`:
	// CR runs are word separators), not the subprocess-output progress-overwrite
	// convention (`sanitizeDisplayLines` alone keeps only the segment after the
	// last `\r`, dropping payload words: `Retry\rnow` -> `now`).
	it("keeps every word of CR-separated brief text (parameter convention)", () => {
		const card = taskToolRenderer.renderCall(
			{ name: "Echo", task: "Retry\rnow" },
			{ expanded: false, isPartial: false },
			theme,
		);
		const rows = frameBodyRows(theme, card, 500);
		expect(rows).toContain("Retry now");
		expect(rows).not.toContain("now");
	});

	// Payload echo sections must not re-flow: a 204-char source line at width
	// 80 is ONE clipped row — wrapped (76/76/52) its breaks read as payload
	// newlines. This covers every renderCodeCell source echo (eval `code` arg,
	// read file content, read-tool-group preview).
	it("keeps one code-cell source row per source line (read/eval payload echo)", () => {
		const rendered = renderCodeCell({ code: LONG_SOURCE, width: 80, status: "complete", title: "Cell" }, theme);
		const rows = frameRowsRaw(theme, rendered).map(row => row.trimEnd());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe("x".repeat(76));
	});

	it("keeps one file-content echo row per source line (write call card)", () => {
		const card = writeToolRenderer.renderCall(
			{ path: "probe.txt", content: LONG_SOURCE },
			{ expanded: false, isPartial: false },
			theme,
		);
		expect(card).toBeDefined();
		const rows = frameBodyRows(theme, card!, 80);
		// One source row (line-number gutter chrome + clipped source) plus the
		// streaming liveness cue row.
		expect(rows).toHaveLength(2);
		expect(rows[0]).toBe(`  1 ${"x".repeat(72)}`);
		expect(rows[1]).toContain("(streaming)");
	});

	it("keeps one file-content echo row per source line (write result card)", () => {
		const card = writeToolRenderer.renderResult(
			{ content: [{ type: "text", text: "Wrote 1 line" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ path: "probe.txt", content: LONG_SOURCE },
		);
		const rows = frameBodyRows(theme, card, 80);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe(`  1 ${"x".repeat(72)}`);
	});

	// `verbatim` must not silently no-op on the plain card variant (exported
	// for payload-echoing surfaces like the MCP and default tool cards).
	it("forwards verbatim through the plain card variant (no re-wrap, no right-trim)", () => {
		const card = plainToolCard(
			theme,
			() => ({ sections: [{ content: [LONG_SOURCE.replaceAll("x", "y"), "trailing ws: y  "], verbatim: true }] }),
			{ paddingX: 0, paddingY: 0 },
		);
		const rows = Bun.stripANSI(card.render(80).join("\n")).split("\n");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toBe("y".repeat(80));
		expect(rows[1]).toBe("trailing ws: y  ".padEnd(80));
	});
});
