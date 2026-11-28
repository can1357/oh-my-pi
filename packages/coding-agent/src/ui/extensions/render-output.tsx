/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Extension renderer output as pi-tui nodes.
 *
 * Extensions draw tool calls and results, custom messages, thinking notes,
 * `ctx.ui.custom` views, widgets, headers and footers by returning an
 * {@link ExtensionRender}: pi-tui nodes (JSX, node objects, strings, arrays,
 * accessors) or a rows object (`{ render(width): string[] }`). The mount
 * points (transcript blocks, tool blocks, message frames, the dock's widget
 * slots, the overlay stack) turn that output into nodes here:
 *
 * - nodes pass through; arrays are adapted element by element;
 * - a rows object becomes a `canvas` (a `rows` node in Tern) whose rows are cut
 *   to the width; it repaints when `revision` changes and, as an interactive
 *   view, after each input it handles; its `dispose` runs when the node goes;
 * - `undefined`/`null`/booleans/`""` draw nothing;
 * - a renderer that throws, or returns anything else, draws nothing and is
 *   reported through `onError` (the mount point then shows its own default);
 *   rows that throw while painting draw one error row instead.
 */
import type { JSXNode, KeyEvent, PasteEvent } from "@oh-my-pi/pi-tui";
import { isUiNode, type UiNode } from "@oh-my-pi/pi-tui/node";
import { type Accessor, onCleanup, signal, untrack } from "@oh-my-pi/pi-tui/reactive";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { bold, inverse, italic, strikethrough, underline } from "@oh-my-pi/pi-tui/theme/theme";
import type { ExtensionRows, ExtensionTheme } from "../../extensibility/extensions/render-types";

/** How a mount point adapts extension output. */
export interface RenderOutputOptions {
	/** Read on every paint of a rows object: change it to repaint the rows (`ExtensionUiHost.requestRender`). */
	readonly revision?: Accessor<unknown>;
	/** The renderer threw, returned something unusable, or its rows threw while painting. */
	readonly onError?: (error: unknown) => void;
	/** Hand keys and pastes to a rows object's `handleInput` (a `ctx.ui.custom` view). */
	readonly input?: boolean;
}

const kExtensionTheme = Symbol("omp.extensionTheme");

/** pi-tui theme helpers extensions call on their theme. */
const THEME_HELPERS = new Map<PropertyKey, (text: string) => string>([
	["bold", bold],
	["italic", italic],
	["underline", underline],
	["strikethrough", strikethrough],
	["inverse", inverse],
]);

interface ThemeWithFacade extends Theme {
	[kExtensionTheme]?: ExtensionTheme;
}

/**
 * `theme` as extensions receive it: the same theme (methods bound to it) plus
 * the attribute helpers (`bold`, `italic`, …). One facade per theme.
 */
export function extensionTheme(theme: ThemeWithFacade): ExtensionTheme {
	let facade = theme[kExtensionTheme];
	if (!facade) {
		facade = new Proxy(theme, {
			get(target, prop) {
				const helper = THEME_HELPERS.get(prop);
				if (helper) return helper;
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
			has: (target, prop) => THEME_HELPERS.has(prop) || Reflect.has(target, prop),
		}) as ExtensionTheme;
		theme[kExtensionTheme] = facade;
	}
	return facade;
}

/** Whether `value` is the rows escape hatch (and not a pi-tui node). */
export function isExtensionRows(value: unknown): value is ExtensionRows {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!isUiNode(value) &&
		"render" in value &&
		typeof value.render === "function"
	);
}

/** Whether rendered output asks to pack against compact transcript neighbours (a rows object's `isTranscriptBlockCompact`). */
export function isCompactOutput(output: unknown): boolean {
	if (!isExtensionRows(output) || typeof output.isTranscriptBlockCompact !== "function") return false;
	try {
		return output.isTranscriptBlockCompact() === true;
	} catch {
		return false;
	}
}

/**
 * The rows of `rows` at `width`, each cut to it. A throw draws one error row
 * and is passed to `onError`.
 */
export function paintRows(rows: ExtensionRows, width: number, onError?: (error: unknown) => void): string[] {
	try {
		return rows.render(width).map(row => truncate(row, width, ""));
	} catch (error) {
		onError?.(error);
		const message = error instanceof Error ? error.message : String(error);
		return [
			truncate(`${currentTheme().symbols.symbol("status.warning")} extension render failed: ${message}`, width),
		];
	}
}

/** A rows object drawn as a `canvas`. */
export function RowsCanvas(props: { readonly rows: ExtensionRows; readonly options?: RenderOutputOptions }): JSXNode {
	const { rows, options } = props;
	const local = signal(0);
	let reported = false;
	const report = (error: unknown): void => {
		if (reported) return;
		reported = true;
		options?.onError?.(error);
	};
	onCleanup(() => {
		try {
			rows.dispose?.();
		} catch (error) {
			options?.onError?.(error);
		}
	});
	const paint = (width: number): readonly string[] => {
		options?.revision?.();
		local();
		return paintRows(rows, width, report);
	};
	if (!options?.input || typeof rows.handleInput !== "function") return <canvas paint={paint} />;
	const deliver = (data: string): boolean => {
		try {
			rows.handleInput?.(data);
		} catch (error) {
			options.onError?.(error);
		}
		local.set(untrack(local) + 1);
		return true;
	};
	return (
		<canvas
			paint={paint}
			onKey={(key: KeyEvent) => key.kind !== "release" && deliver(key.raw)}
			// Bracketed paste, as the raw bytes a row component's `handleInput` always received.
			onPaste={(paste: PasteEvent) => deliver(`\x1b[200~${paste.text}\x1b[201~`)}
		/>
	);
}

/** `output` as nodes; `undefined` when it draws nothing (see the module docs). */
export function extensionOutput(output: unknown, options?: RenderOutputOptions): JSXNode | undefined {
	if (output === undefined || output === null || typeof output === "boolean" || output === "") return undefined;
	if (typeof output === "string" || typeof output === "number" || typeof output === "function" || isUiNode(output)) {
		return output as JSXNode;
	}
	if (Array.isArray(output)) {
		const nodes = output.map(item => extensionOutput(item, options)).filter(item => item !== undefined);
		return nodes.length > 0 ? nodes : undefined;
	}
	if (isExtensionRows(output)) return <RowsCanvas rows={output} options={options} />;
	options?.onError?.(new TypeError("Extension UI returned neither pi-tui nodes nor a { render(width) } rows object"));
	return undefined;
}

/** Call an extension renderer and adapt what it returns; a throw draws nothing and is reported. */
export function renderExtension(render: () => unknown, options?: RenderOutputOptions): JSXNode | undefined {
	let output: unknown;
	try {
		output = render();
	} catch (error) {
		options?.onError?.(error);
		return undefined;
	}
	return extensionOutput(output, options);
}

/**
 * Exactly one node for mount points that need one (an overlay's root takes
 * keyboard focus): a single node as is, anything else in a `col`.
 */
export function singleNode(output: JSXNode): UiNode {
	return isUiNode(output) ? output : ((<col>{output}</col>) as UiNode);
}
