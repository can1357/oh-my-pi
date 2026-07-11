import { visibleWidth, wrapTextWithAnsi, truncateToWidth, sliceWithWidth, extractSegments, Ellipsis } from "../src/utils";
import { matchesKey } from "../src/keys";
import { makeBench } from "./_harness";

const ITERATIONS = 2000;

const samples = {
	plain: "hello world this is a plain ASCII string with some words",
	ansi: "\x1b[31mred text\x1b[0m and \x1b[4munderlined content\x1b[24m with emoji 😅😅",
	links: "prefix \x1b]8;;https://example.com\x07link\x1b]8;;\x07 suffix",
	wide: "日本語のテキストとemoji 🚀✨ mixed with ascii",
	wrapped: "This is a long line that should wrap multiple times when rendered with ANSI \x1b[32mcolors\x1b[0m and tabs\tbetween words.",
};

const wrapWidth = 40;

const bench = makeBench(ITERATIONS);

console.log(`Text layout benchmark (${ITERATIONS} iterations)\n`);

bench("visibleWidth/plain", () => {
	visibleWidth(samples.plain);
});

bench("visibleWidth/ansi", () => {
	visibleWidth(samples.ansi);
});

bench("truncateToWidth/ansi", () => {
	truncateToWidth(samples.ansi, 32, Ellipsis.Unicode, true);
});

bench("wrapTextWithAnsi/ansi", () => {
	wrapTextWithAnsi(samples.wrapped, wrapWidth);
});

bench("sliceWithWidth/ansi", () => {
	sliceWithWidth(samples.ansi, 3, 18, true);
});

bench("extractSegments/ansi", () => {
	extractSegments(samples.ansi, 10, 20, 15, true);
});

bench("matchesKey", () => {
	matchesKey("\x1b[A", "up");
	matchesKey("\x1b[1;5C", "ctrl+right");
	matchesKey("\x1b[1;2D", "shift+left");
});
