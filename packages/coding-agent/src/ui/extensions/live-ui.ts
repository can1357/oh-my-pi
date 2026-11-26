import { derivedNode, getOwner, onCleanup, type UiNode } from "@oh-my-pi/pi-tui";
import { bubbleEvent, keypathOf } from "@oh-my-pi/pi-tui/dispatch";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { ExtensionLiveBlock, ExtensionLiveUi } from "../../extensibility/extensions/render-types";
import type { Composer } from "../composer";
import { ensureTerminalStylesLoaded } from "../shell/shell";
import type { Shell, TranscriptBlock } from "../shell";

/** Native ids escape these characters before joining structural key segments. */
function segment(key: string): string {
	return key.replace(/[%/~^]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Match structural children, including the native reconciler's duplicate-key suffixes. */
function childAt(nodes: readonly UiNode[], key: string): UiNode | undefined {
	const counts = new Map<string, number>();
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		const base = node.key() === undefined ? String(i) : segment(node.key()!);
		const duplicate = counts.get(base) ?? 0;
		counts.set(base, duplicate + 1);
		if ((duplicate === 0 ? base : `${base}~${duplicate}`) === key) return node;
	}
	return undefined;
}

/** Paths are below a single native root, or below a synthetic column over several roots. */
function resolvePath(roots: readonly UiNode[], key: string): UiNode[] {
	const parts = key === "" ? [] : key.split("/");
	const path: UiNode[] = [];
	let node = roots.length === 1 ? roots[0] : childAt(roots, parts.shift() ?? "");
	if (!node) return path;
	path.push(node);
	for (const part of parts) {
		node = childAt(node.children(), part);
		if (!node) return [];
		path.push(node);
	}
	return path;
}

/** Built once per main interactive controller; block handles survive widget remounts and streaming. */
export function createExtensionLiveUi(
	shell: Pick<Shell, "native" | "transcript" | "focused" | "overlays">,
	composer: Pick<Composer, "completing" | "vimConsumesEscape">,
	onError: (error: unknown) => void,
): ExtensionLiveUi {
	const handles = new WeakMap<TranscriptBlock, ExtensionLiveBlock>();
	const handle = (block: TranscriptBlock): ExtensionLiveBlock => {
		let cached = handles.get(block);
		if (cached) return cached;
		cached = {
			id: String(block.node.id),
			node: block.node,
			native: () => (block.node.disposed ? [] : block.native()),
			render: width => {
				if (block.node.disposed) return [];
				// Native startup skips terminal painters; row fallback still uses the same registered looks.
				ensureTerminalStylesLoaded();
				return renderBlock(block.node, width, { env: staticEnvironment(currentTheme()) }).rows;
			},
			setExpanded: expanded => {
				if (block.node.disposed) return;
				const folds: UiNode[][] = [];
				const visit = (node: UiNode, path: UiNode[]): void => {
					const props = node.props() as { collapsible?: boolean; collapsed?: boolean };
					if ((props.collapsible === true || typeof props.collapsed === "boolean") && props.collapsed !== !expanded)
						folds.push(path);
					for (const child of node.children()) visit(child, [...path, child]);
				};
				for (const root of block.native()) visit(root, [root]);
				for (const path of folds)
					bubbleEvent(path, { type: "toggle", key: keypathOf(path), collapsed: !expanded });
			},
			dispatchAction: (key, act) => {
				if (block.node.disposed) return false;
				const path = resolvePath(block.native(), key);
				return bubbleEvent(path, { type: "action", key: keypathOf(path), act, mods: [] });
			},
		};
		handles.set(block, cached);
		return cached;
	};
	return {
		get native() {
			return shell.native();
		},
		blocks: () => shell.transcript.shownBlocks().map(handle),
		decorate: transform => {
			let failed = false;
			return shell.transcript.decorateNative(blocks => {
				if (!shell.native()) return blocks.flatMap(block => block.native());
				try {
					const nodes = transform(blocks.map(handle));
					failed = false;
					return nodes;
				} catch (error) {
					// Reporting may append a warning block: do not report that same failed rendering again.
					if (!failed) {
						failed = true;
						onError(error);
					}
					return blocks.flatMap(block => block.native());
				}
			});
		},
		invalidate: () => {
			if (shell.native()) shell.transcript.invalidateNative();
		},
		focused: shell.focused,
		promptConsumesEscape: () => composer.completing() || composer.vimConsumesEscape(),
		showOverlay: (factory, options) => {
			const view = shell.overlays.show(
				() => {
					const node = factory();
					return options?.passive ? derivedNode(node, props => ({ ...props, modal: false })) : node;
				},
				{ focus: !options?.passive },
			);
			const hide = (): void => view.close();
			if (getOwner()) onCleanup(hide);
			return { hide };
		},
	};
}
