/**
 * Terminal look of the setup wizard (`omp.setup`), a full-screen frame:
 *
 * - a scene (`omp.setup.scene`): the logo, `omp`, "Setup step N of M", the
 *   title and subtitle, the body (indented four cells, at least 20 wide,
 *   cut with an ellipsis where the screen is narrower), and the key hints on
 *   the last row. Too few rows for a body: the head alone, cut to the screen.
 *   Right after the splash the frame dissolves in over it, top to bottom.
 * - the outro (`omp.setup.outro`): the logo, "Setup saved", and a bar
 *   filling over the outro's length, on a starfield.
 * - done: blank rows.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type Hit, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { gradientArt, LOGO } from "../../welcome/logo";
import { centered, splashRows, starRow } from "./splash";

/** Terminal facts of the wizard root. */
export type WizardTerm = { readonly rows: number };

/** Terminal facts of a scene frame. */
export type SceneFrameTerm = {
	readonly title: string;
	readonly subtitle?: string;
	/** "Setup step N of M". */
	readonly step: string;
	/** Key hints on the last row. */
	readonly footer: string;
	/** The splash dissolving into the frame: from when, for how long, and when the splash started. */
	readonly dissolve: { readonly from: number; readonly ms: number; readonly splashStart: number };
};

/** Terminal facts of the outro: when it began and how long it lasts. */
export type OutroTerm = { readonly at: number; readonly ms: number };

/** Narrowest a scene body is laid out. */
const MIN_BODY_WIDTH = 20;
/** Cells the body is indented. */
const BODY_INDENT = 4;

function termOf<T>(node: UiNode): T | undefined {
	return (node.props() as { term?: T }).term;
}

/** The scene frame's head rows: blank, logo, brand, step counter, blank, title, subtitle, blank. */
function headRows(cx: PaintContext, term: SceneFrameTerm): string[] {
	const { theme, width } = cx;
	const indent = " ".repeat(BODY_INDENT);
	const room = Math.max(1, width - BODY_INDENT);
	const rows = [""];
	for (const row of gradientArt(LOGO, "truecolor")) rows.push(truncate(centered(row, width), width));
	rows.push(centered(theme.style("strong", theme.fg("accent", "omp")), width));
	rows.push(centered(theme.fg("muted", term.step), width));
	rows.push("");
	rows.push(`${indent}${truncate(theme.style("strong", term.title), room)}`);
	if (term.subtitle) rows.push(`${indent}${truncate(theme.fg("muted", term.subtitle), room)}`);
	rows.push("");
	return rows;
}

/** The body's rows: laid out at least {@link MIN_BODY_WIDTH} wide, cut to the screen, indented. */
function bodyRows(cx: PaintContext, body: UiNode): { rows: string[]; hits: Hit[] } {
	const layout = Math.max(MIN_BODY_WIDTH, cx.width - BODY_INDENT * 2);
	const room = Math.max(1, cx.width - BODY_INDENT);
	const block = cx.paint(body, layout);
	const indent = " ".repeat(BODY_INDENT);
	const rows = block.rows.map(row => (row === "" ? "" : `${indent}${truncate(row, room)}`));
	const hits = (block.hits ?? []).map(hit => ({ ...hit, col: hit.col + BODY_INDENT }));
	return { rows, hits };
}

function paintScene(node: UiNode, cx: PaintContext): Block {
	const term = termOf<SceneFrameTerm>(node);
	const height = cx.height ?? 30;
	if (!term) return { rows: [] };
	const head = headRows(cx, term);
	const budget = height - head.length - 2;
	if (budget < 1) return { rows: head.slice(0, height) };
	const body = node.children().find(child => child.key()?.startsWith("body:"));
	const { rows: content, hits } = body ? bodyRows(cx, body) : { rows: [], hits: [] };
	const rows = [...head, ...content.slice(0, budget)];
	while (rows.length < height - 1) rows.push("");
	rows.push(centered(cx.theme.fg("dim", term.footer), cx.width));
	const frameHits = hits.map(hit => ({ ...hit, row: hit.row + head.length }));
	// Dissolve: rows of the frame replace the splash from the top while it plays.
	const { from, ms, splashStart } = term.dissolve;
	const elapsed = cx.reduceMotion ? ms : cx.now() - from;
	if (elapsed >= 0 && elapsed < ms) {
		const splash = splashRows(cx.theme, cx.width, height, cx.now() - splashStart);
		const shown = Math.floor((elapsed / ms) * height);
		return { rows: rows.map((row, y) => (y < shown ? row : splash[y]!)), hits: frameHits };
	}
	return { rows, hits: [{ row: 0, col: 0, width: cx.width, height, node }, ...frameHits] };
}

defineRolePainter("col", "omp.setup.scene", paintScene);

/** The body col: the scene body as it paints itself. */
defineRolePainter("col", "omp.setup.body", (node, cx): Block => {
	const child = node.children()[0];
	return child ? cx.paint(child, cx.width) : { rows: [] };
});

function paintOutro(node: UiNode, cx: PaintContext): Block {
	const term = termOf<OutroTerm>(node);
	const { theme, width } = cx;
	const height = cx.height ?? 30;
	const elapsed = Math.max(0, cx.now() - (term?.at ?? 0));
	const content: string[] = [];
	for (const row of gradientArt(LOGO, "truecolor")) content.push(centered(row, width));
	content.push("");
	content.push(centered(theme.fg("success", `${theme.symbols.symbol("status.success")} Setup saved`), width));
	content.push(centered(theme.fg("muted", "Handing off to the normal CLI…"), width));
	content.push("");
	const barWidth = Math.max(1, width - BODY_INDENT * 2);
	const filled = Math.max(1, Math.min(barWidth, Math.round((elapsed / (term?.ms ?? 1)) * barWidth)));
	content.push(
		`${" ".repeat(BODY_INDENT)}${theme.fg("accent", "━".repeat(filled))}${theme.fg("dim", "─".repeat(barWidth - filled))}`,
	);
	const top = Math.max(0, Math.floor((height - content.length) / 2));
	const t = cx.reduceMotion ? 0 : cx.now();
	const rows: string[] = [];
	for (let y = 0; y < height; y++) {
		const at = y - top;
		rows.push(at >= 0 && at < content.length ? content[at]! : starRow(theme, y, width, t, 11));
	}
	return { rows, hits: [{ row: 0, col: 0, width, height, node, act: "continue" }] };
}

defineRolePainter("col", "omp.setup.outro", paintOutro);

/** The wizard root: its phase's frame at the screen's size. */
defineRolePainter("col", "omp.setup", (node, cx): Block => {
	const term = termOf<WizardTerm>(node);
	const height = term?.rows ?? cx.height ?? 30;
	const child = node.children()[0];
	const block = child ? cx.paint(child, cx.width, height) : { rows: [] };
	const rows = block.rows.slice(0, height);
	while (rows.length < height) rows.push("");
	return { rows, ...(block.hits ? { hits: block.hits } : {}) };
});

/** The wheel over a scene frame goes to the wizard (which scrolls the scene). */
defineRoleWidget("col", "omp.setup.scene", {
	mouse(_node, mouse, _at, cx) {
		if (mouse.action !== "press" || (mouse.button !== "wheel-up" && mouse.button !== "wheel-down")) return false;
		cx.emit({ type: "action", key: cx.keypath, act: mouse.button, mods: [] });
		return true;
	},
});
