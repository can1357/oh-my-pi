/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";

const env = staticEnvironment(PLAIN_THEME);
const rows = (tree: unknown, width: number) =>
	renderBlock(tree as UiNode, width, { env }).rows.map(row => stripEscapes(row).trimEnd());

function bar() {
	return (
		<status>
			<seg key="a" side="left" priority={5} spans={[{ t: "alpha" }]} />
			<seg
				key="p"
				side="left"
				priority={9}
				min={{ w: "6ch" }}
				spans={[{ t: "/very/long/path" }]}
				term={{ truncate: "start" }}
			/>
			<seg key="b" side="left" priority={4} spans={[{ t: "beta" }]} />
			<seg key="t" side="right" priority={3} min={{ w: "6ch" }} spans={[{ t: "session title" }]} />
			<seg key="c" side="right" priority={1} spans={[{ t: "cost" }]} />
		</status>
	);
}

describe("status", () => {
	test("groups sit at the edges, joined by a dot", () => {
		// 32 cells left, 22 right: 16 between.
		expect(rows(bar(), 70)).toEqual([` alpha · /very/long/path · beta${" ".repeat(18)}session title · cost`]);
	});

	test("an elastic segment shrinks before anything on its side drops", () => {
		// 32 + 22 + 1 = 55 cells wide; at 50 the title gives 5 cells.
		expect(rows(bar(), 50)).toEqual([" alpha · /very/long/path · beta   session… · cost"]);
	});

	test("the lowest priority drops once the elastic segments are at their minimum", () => {
		expect(rows(bar(), 42)).toEqual([" alpha · /very/long/path · beta    sessi…"]);
	});

	test("the left side truncates its path before dropping, then drops by priority", () => {
		expect(rows(bar(), 30)).toEqual([" alpha · …ry/long/path · beta"]);
		expect(rows(bar(), 18)).toEqual([" alpha · …/path"]);
		expect(rows(bar(), 9)).toEqual([" …/path"]);
	});

	test("seg paints its icon and spans, cut at the end by default", () => {
		const seg = <seg icon="folder" spans={[{ t: "documents" }]} />;
		const [row] = rows(seg, 40);
		expect(row?.endsWith(" documents")).toBe(true);
		expect(rows(<seg spans={[{ t: "documents" }]} />, 5)).toEqual(["docu…"]);
	});
});
