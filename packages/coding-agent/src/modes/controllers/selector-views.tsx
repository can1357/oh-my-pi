/** @jsxImportSource @oh-my-pi/pi-tui */
/** Layers and blocks the selector controller mounts around its screens. */
import type { JSXNode, KeyEvent, PageProps, UiNode } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../ui/styles/apps/screen/look";

/** A page Tern styles as the session it belongs to. */
export const SESSION_PAGE: PageProps = {};

/**
 * A fullscreen menu (model hub, agent hub, dashboards): the screen fills the
 * terminal's alternate screen. Tern draws a picker or prefs screen as the
 * sheet it is, and any other as a page of its own.
 * `onKey` takes the keys on the layer itself, for screens that rebuild their root.
 * `page` names a page with a surface role or a dock of its own.
 */
export function fullscreenMenuView(
	key: string,
	content: JSXNode,
	onKey?: (key: KeyEvent) => boolean,
	page: PageProps = SESSION_PAGE,
): JSXNode {
	return (
		<overlay key={key} size="full" role="omp.app.screen" page={page} onKey={onKey}>
			{content}
		</overlay>
	);
}

/** Tern supplies the gauge, padded scrolling body and sticky action bar for the Usage sheet. */
export function usageDashboardView(native: boolean, content: JSXNode, onKey: (key: KeyEvent) => boolean): JSXNode {
	if (!native) return fullscreenMenuView("usage-dashboard", content, onKey);
	return (
		<overlay
			key="usage-dashboard"
			role="omp.overlay.usage"
			anchor="center"
			size="lg"
			modal
			head="Usage"
			onKey={onKey}
		>
			{content}
		</overlay>
	);
}

/** A sheet across the foot of the screen over the transcript (the session model picker). */
export function bottomSheetView(key: string, content: JSXNode): JSXNode {
	return (
		<overlay key={key} anchor="bottom" size="lg" role="omp.app.screen" term={{ width: "full" }}>
			{content}
		</overlay>
	);
}

/** Toned transcript lines (a login or logout outcome): `[color, text]` each. */
export function outcomeLinesView(lines: readonly (readonly [color: string, text: string])[]): JSXNode {
	return (
		<col>
			{lines.map(([color, text], index) => (
				<text key={String(index)} spans={[{ s: color, t: text }]} wrap="word" />
			))}
		</col>
	);
}

/** A `✓ message` line in the `success` color. */
export function successText(message: string): string {
	return `${currentTheme().symbols.symbol("status.success")} ${message}`;
}

/** The first node under `root` (itself included) of `kind`, else `root`. */
export function firstOfKind(root: UiNode, ...kinds: string[]): UiNode {
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.shift()!;
		if (kinds.includes(node.kind)) return node;
		stack.unshift(...node.children());
	}
	return root;
}

/** Tern's rewind page: the replayed turns are its `main`, the bar (the last child) docks under them. */
export const REWIND_PAGE: PageProps = { role: "omp.rewind", dock: 1 };

/** The bar a page layer docks (its last child), else the layer. */
export function layerDock(root: UiNode): UiNode {
	return root.children().at(-1) ?? root;
}

/** The screen an overlay layer holds (its first child), else the layer. */
export function layerContent(root: UiNode): UiNode {
	return root.children()[0] ?? root;
}

/** Whether `node` sits under `root` (a node inside a dialog's tree). */
export function isWithin(node: UiNode, root: UiNode): boolean {
	const stack = [...root.children()];
	while (stack.length > 0) {
		const next = stack.pop()!;
		if (next === node) return true;
		stack.push(...next.children());
	}
	return false;
}
