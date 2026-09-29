import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { taskToolRenderer } from "@oh-my-pi/pi-tui/tools/task";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";
import { renderCodeCell } from "@oh-my-pi/pi-tui/render/code-cell";
import { plainToolCard } from "@oh-my-pi/pi-tui/render/tool-card";
import { renderVerbatimRows, VERBATIM_WRAP_MARKER } from "@oh-my-pi/pi-tui/render/output-block";

// Regression: tool-call payload echoes ran through the markdown/LaTeX
// typesetter and came out corrupted — `$(grep -c A_rows $P)` echoed as
// `(grep -c Aᵣows P)` (a `$$` shell-PID pair opens a math span that consumes
// `$…$` sigils and subscript-converts `_r`), and prose wrap inserted hard
// breaks mid-string so the echo no longer matched the payload's line
// structure. Tool-call parameters and command echoes are payloads, not prose:
// the echo must byte-match what will be dispatched, modulo the display
// sanitization convention (ANSI/control strip, tab expansion).
//
// Overflow contract (every byte recoverable): verbatim sections soft-wrap
// across rows marked with VERBATIM_WRAP_MARKER when `expanded`, and clip to a
// byte-prefix with a visible `…` marker when collapsed. Task brief/context go
// through markdown in literal-math mode instead: structure typesets, but
// `$…$`/`$$…$$` spans, `\(...\)` BRE groups and their bytes stay literal.

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

/**
 * Concatenate one source line's echo rows minus their soft-wrap markers and
 * ANSI styling: the recovered source bytes. The frame's pad-to-width (like a
 * source trailing space it is indistinguishable from on the final row) is
 * trimmed off that final row only — every earlier row is exactly frame-width
 * and keeps its bytes, cut trailing spaces included.
 */
function recoverBytes(rows: readonly string[]): string {
	return rows
		.map((rawRow, index) => {
			const row = Bun.stripANSI(rawRow);
			const unmarked = row.startsWith(VERBATIM_WRAP_MARKER) ? row.slice(VERBATIM_WRAP_MARKER.length) : row;
			return index === rows.length - 1 ? unmarked.trimEnd() : unmarked;
		})
		.join("");
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

	// Every byte of an overflowing payload row must be recoverable: expanded
	// shows the full source across rows marked with VERBATIM_WRAP_MARKER (a soft
	// wrap can then never read as a payload newline); collapsed clips to a
	// byte-prefix with a visible `…` marker so the cut is never silent. This
	// covers every renderCodeCell source echo (eval `code` arg, read file
	// content, read-tool-group preview).
	it("shows every byte of a long code-cell source line across marked rows (read/eval payload echo)", () => {
		const expanded = frameRowsRaw(
			theme,
			renderCodeCell({ code: LONG_SOURCE, width: 80, status: "complete", title: "Cell", expanded: true }, theme),
		);
		expect(expanded.length).toBeGreaterThan(1);
		for (const row of expanded.slice(1)) expect(row.startsWith(VERBATIM_WRAP_MARKER)).toBe(true);
		expect(recoverBytes(expanded)).toBe(LONG_SOURCE);

		const collapsed = frameRowsRaw(
			theme,
			renderCodeCell({ code: LONG_SOURCE, width: 80, status: "complete", title: "Cell" }, theme),
		);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]!.endsWith("…")).toBe(true);
		expect(LONG_SOURCE.startsWith(collapsed[0]!.slice(0, -1))).toBe(true);
	});

	it("shows every byte of a long file-content echo row across marked rows (write call card)", () => {
		const expandedCard = writeToolRenderer.renderCall(
			{ path: "probe.txt", content: LONG_SOURCE },
			{ expanded: true, isPartial: false },
			theme,
		);
		expect(expandedCard).toBeDefined();
		const expanded = frameRowsRaw(theme, expandedCard!.render(80));
		// Source rows (line-number gutter chrome + marked continuations) plus the
		// streaming liveness cue row.
		expect(expanded[expanded.length - 1]).toContain("(streaming)");
		const recovered = recoverBytes(expanded.slice(0, -1));
		expect(recovered.startsWith("  1 ")).toBe(true);
		expect(recovered.slice(4)).toBe(LONG_SOURCE);

		const collapsedCard = writeToolRenderer.renderCall(
			{ path: "probe.txt", content: LONG_SOURCE },
			{ expanded: false, isPartial: false },
			theme,
		);
		const collapsed = frameRowsRaw(theme, collapsedCard!.render(80));
		expect(collapsed).toHaveLength(2);
		expect(collapsed[0]!.endsWith("…")).toBe(true);
		expect(`  1 ${LONG_SOURCE}`.startsWith(collapsed[0]!.slice(0, -1))).toBe(true);
		expect(collapsed[1]).toContain("(streaming)");
	});

	it("shows every byte of a long file-content echo row across marked rows (write result card)", () => {
		const expanded = frameRowsRaw(
			theme,
			writeToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "Wrote 1 line" }] },
					{ expanded: true, isPartial: false },
					theme,
					{ path: "probe.txt", content: LONG_SOURCE },
				)
				.render(80),
		);
		expect(expanded.length).toBeGreaterThan(1);
		for (const row of expanded.slice(1)) expect(row.startsWith(VERBATIM_WRAP_MARKER)).toBe(true);
		expect(recoverBytes(expanded).slice(4)).toBe(LONG_SOURCE);

		const collapsed = frameRowsRaw(
			theme,
			writeToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "Wrote 1 line" }] },
					{ expanded: false, isPartial: false },
					theme,
					{ path: "probe.txt", content: LONG_SOURCE },
				)
				.render(80),
		);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]!.endsWith("…")).toBe(true);
		expect(`  1 ${LONG_SOURCE}`.startsWith(collapsed[0]!.slice(0, -1))).toBe(true);
	});

	// `verbatim` must not silently no-op on the plain card variant (exported
	// for payload-echoing surfaces like the MCP and default tool cards), and it
	// must honor the same recoverable-overflow contract as the framed variant.
	it("keeps plain-card verbatim rows full-byte recoverable (no re-wrap, no right-trim)", () => {
		const yLine = LONG_SOURCE.replaceAll("x", "y");
		const build = (expanded: boolean) =>
			plainToolCard(
				theme,
				() => ({ sections: [{ content: [yLine, "trailing ws: y  "], verbatim: true, expanded }] }),
				{ paddingX: 0, paddingY: 0 },
			);

		const expandedRows = Bun.stripANSI(build(true).render(80).join("\n")).split("\n");
		expect(expandedRows.length).toBeGreaterThan(1);
		for (const row of expandedRows.slice(1, -1)) expect(row.startsWith(VERBATIM_WRAP_MARKER)).toBe(true);
		expect(recoverBytes(expandedRows.slice(0, -1))).toBe(yLine);
		expect(expandedRows[expandedRows.length - 1]).toBe("trailing ws: y  ".padEnd(80));

		const collapsedRows = Bun.stripANSI(build(false).render(80).join("\n")).split("\n");
		expect(collapsedRows).toHaveLength(2);
		expect(collapsedRows[0]!.trimEnd().endsWith("…")).toBe(true);
		expect(yLine.startsWith(collapsedRows[0]!.trimEnd().slice(0, -1))).toBe(true);
		expect(collapsedRows[1]).toBe("trailing ws: y  ".padEnd(80));
	});

	// Verbatim chunk cuts land on grapheme/ANSI boundaries: no row may hold half
	// a wide grapheme or a torn escape sequence, and the byte-prefix property
	// must survive both.
	it("cuts verbatim chunks on grapheme and ANSI boundaries", () => {
		const wide = "界".repeat(50); // 100 columns: one wide grapheme per cell pair
		const wideRows = renderVerbatimRows(wide, 80, theme, true);
		expect(recoverBytes(wideRows)).toBe(wide);
		for (const row of wideRows) {
			const stripped = Bun.stripANSI(row);
			const body = stripped.startsWith(VERBATIM_WRAP_MARKER) ? stripped.slice(VERBATIM_WRAP_MARKER.length) : stripped;
			expect(/^(?:界)*$/u.test(body)).toBe(true);
		}

		const ansiSource = `${"a".repeat(10)}\x1b[31m${"b".repeat(90)}`;
		const ansiRows = renderVerbatimRows(ansiSource, 80, theme, true);
		expect(ansiRows.length).toBeGreaterThan(1);
		for (const row of ansiRows) {
			// Every ESC survives as a complete SGR run — never a torn `\x1b[`.
			expect(row.replaceAll(/\x1b\[[0-9;]*m/g, "")).not.toContain("\x1b");
		}
		expect(recoverBytes(ansiRows)).toBe(Bun.stripANSI(ansiSource));
	});

	// Reviewer smoke (blocking comment on `output-block.ts:154`): this exact
	// command at width 80 used to lose its `… ; echo EXIT_MARKER=$?` tail behind
	// a marker-less clip even when `expanded: true`. Expanded must now recover
	// every byte across marked continuation rows; collapsed clips with a visible
	// `…` so the cut is announced and the tail is one expand away.
	const SMOKE_COMMAND = "cd packages/coding-agent && bun test … 2>&1 | grep -E 'fail|error' ; echo EXIT_MARKER=$?";

	it("makes the reviewer smoke command fully recoverable at width 80 (expanded) and marked when collapsed", () => {
		const expanded = frameRowsRaw(
			theme,
			bashToolRenderer.renderCall({ command: SMOKE_COMMAND }, { expanded: true, isPartial: false }, theme).render(80),
		);
		expect(expanded.length).toBeGreaterThan(1);
		for (const row of expanded.slice(1)) expect(row.startsWith(VERBATIM_WRAP_MARKER)).toBe(true);
		// Row 0 carries the dim `$ ` prompt prefix chrome; the command bytes trail it.
		expect(recoverBytes(expanded).slice(2)).toBe(SMOKE_COMMAND);

		const collapsed = frameRowsRaw(
			theme,
			bashToolRenderer
				.renderCall({ command: SMOKE_COMMAND }, { expanded: false, isPartial: false }, theme)
				.render(80),
		);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]!.endsWith("…")).toBe(true);
		expect(collapsed[0]!.startsWith("$ cd packages/coding-agent && bun test")).toBe(true);
	});
});
