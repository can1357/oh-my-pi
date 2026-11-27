/**
 * `code`: source text, highlighted by `lang` (else the language of `path`).
 * With `numbers` each row leads with its line number (`start` up, or `nums`
 * per line, a dim `…` row where the numbers jump), a marked line's number in
 * its tone with `*`. `wrap` soft-wraps long lines under the gutter; else
 * they are cut. A `tone` colors unhighlighted text. Text: one line per source
 * line (a cut one as far as it shows); the gutter and jump rows are not.
 */
import type { TspCodeProps, TspTone } from "@oh-my-pi/pi-wire";
import { highlightCode, supportsLanguage } from "../../text/highlight";
import { languageFromPath } from "../../text/lang";
import { replaceTabs, truncate, visibleWidth, wrap } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";
import { lazyText, mapWrappedText, offsetRenderedText, type RenderedTextRow, shownText } from "../text-layout";

definePainter("code", (node, cx): Block => {
	const props = node.props() as TspCodeProps & { tone?: TspTone };
	const theme = cx.theme;
	const width = cx.width;
	if (width <= 0) return EMPTY_BLOCK;
	const source = (props.text ?? "").replace(/\r\n?/g, "\n");
	if (source.length === 0) return EMPTY_BLOCK;
	const lines = source.split("\n").map(line => replaceTabs(line));
	const lang = props.lang ?? (props.path ? languageFromPath(props.path) : undefined);
	const styled =
		lang && supportsLanguage(lang)
			? highlightCode(lines.join("\n"), lang, theme)
			: lines.map(line => (props.tone ? theme.style(props.tone, line) : line));
	const numbers = props.numbers
		? lines.map((_, i) =>
				props.nums && props.nums.length === lines.length ? props.nums[i]! : (props.start ?? 1) + i,
			)
		: undefined;
	const marks = new Map((props.marks ?? []).map(mark => [mark.line, mark.tone ?? "accent"]));
	const gutterWidth = numbers ? String(Math.max(...numbers)).length + 1 : 0;
	/** The rows, and with `text` the text of each. */
	const draw = (text?: (RenderedTextRow | undefined)[]): string[] => {
		const rows: string[] = [];
		for (let i = 0; i < styled.length; i++) {
			let gutter = "";
			let rest = "";
			if (numbers) {
				const n = numbers[i]!;
				if (i > 0 && n !== numbers[i - 1]! + 1) {
					rows.push(theme.style("dim", `${" ".repeat(gutterWidth - 1)}… `));
					text?.push(undefined);
				}
				const tone = marks.get(n);
				const label = `${tone ? "*" : " "}${String(n).padStart(gutterWidth - 1)}`;
				gutter = `${tone ? theme.style(tone, label) : theme.style("dim", label)} `;
				rest = " ".repeat(visibleWidth(gutter));
			}
			const room = Math.max(1, width - visibleWidth(gutter));
			const line = styled[i] ?? "";
			if (props.wrap) {
				const parts = wrap(line, room);
				const shown = parts.length > 0 ? parts : [""];
				shown.forEach((part, j) => {
					rows.push(`${j === 0 ? gutter : rest}${part}`);
				});
				if (text)
					for (const row of mapWrappedText(lines[i]!, shown)) text.push(offsetRenderedText(row, rest.length));
			} else {
				const cut = truncate(line, room, theme.symbols.ellipsis);
				rows.push(`${gutter}${cut}`);
				text?.push(offsetRenderedText(shownText(lines[i]!, cut), rest.length));
			}
		}
		return rows;
	};
	return {
		rows: draw(),
		text: lazyText(() => {
			const text: (RenderedTextRow | undefined)[] = [];
			draw(text);
			return text;
		}),
	};
});
