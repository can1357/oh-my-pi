/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Extension widgets around the editor (`widgetsAbove`, `widgetsBelow`) and
 * the editor gap (`editorGap`) above them.
 *
 * A widget (`ctx.ui.setWidget(key, content, { placement })`) is one of:
 * - an array of lines (ANSI allowed): each a word-wrapped text row one cell
 *   in, at most ten, then a muted `... (widget truncated)`;
 * - a node factory: pi-tui nodes, as any screen builds them;
 * - rows (`{ render(width): string[] }`): drawn as a `canvas` (a `rows` node
 *   natively).
 * Widgets show in the order they were first set; setting a key again
 * replaces that widget in place.
 *
 * The gap is one blank row above the widgets, or above the composer — which
 * a band-shaped composer closes while the status row above it draws (the
 * working row brings its own blank row). Natively the dock spaces itself.
 */
import { type Accessor, For, type JSXNode, signal } from "@oh-my-pi/pi-tui";
import "../styles/dock";
import { ansiSpans } from "../transcript/messages/spans";

/** The rows escape hatch: old row renderers, drawn as a canvas. */
export interface WidgetRows {
	render(width: number): readonly string[];
}

export type WidgetContent = readonly string[] | (() => JSXNode) | WidgetRows;

export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Lines a line widget shows before its truncation notice. */
export const MAX_WIDGET_LINES = 10;

interface WidgetEntry {
	readonly key: string;
	readonly content: WidgetContent;
}

/** The widgets on both sides of the editor; the extension UI controller feeds it. */
export class HookWidgetsModel {
	readonly above = signal<readonly WidgetEntry[]>([]);
	readonly below = signal<readonly WidgetEntry[]>([]);

	/** Set widget `key` (replacing it wherever it was); `undefined` removes it. */
	set(key: string, content: WidgetContent | undefined, placement: WidgetPlacement = "aboveEditor"): void {
		const without = (list: readonly WidgetEntry[]): readonly WidgetEntry[] => list.filter(entry => entry.key !== key);
		const target = placement === "belowEditor" ? this.below : this.above;
		const other = placement === "belowEditor" ? this.above : this.below;
		other.set(without(other.peek()));
		if (content === undefined) {
			target.set(without(target.peek()));
			return;
		}
		const list = target.peek();
		const index = list.findIndex(entry => entry.key === key);
		target.set(
			index < 0 ? [...list, { key, content }] : list.map((entry, at) => (at === index ? { key, content } : entry)),
		);
	}

	clear(): void {
		this.above.set([]);
		this.below.set([]);
	}
}

function isRows(content: WidgetContent): content is WidgetRows {
	return typeof content === "object" && !Array.isArray(content) && "render" in content;
}

/** One line of a line widget: a text row (natively spans, word wrap), one cell in on a terminal. */
function WidgetLine(props: { readonly line: string; readonly color?: string }): JSXNode {
	const spans = props.line.trim() === "" ? [] : ansiSpans(props.line);
	if (spans.length === 0) return <col hidden={true} term={{ role: "omp.widget.line", line: "" }} />;
	const color = props.color;
	return (
		<text
			spans={
				color
					? spans.map(span => ({
							...span,
							s: span.s ? `${color} ${span.s}` : color,
						}))
					: spans
			}
			wrap="word"
			term={{ role: "omp.widget.line", line: props.line, color }}
		/>
	);
}

function Widget(props: { readonly content: WidgetContent }): JSXNode {
	const content = props.content;
	if (typeof content === "function") return content();
	if (isRows(content)) return <canvas paint={width => content.render(width)} />;
	const lines = content as readonly string[];
	return (
		<col>
			{lines.slice(0, MAX_WIDGET_LINES).map(line => (
				<WidgetLine line={line} />
			))}
			{lines.length > MAX_WIDGET_LINES && <WidgetLine line="... (widget truncated)" color="muted" />}
		</col>
	);
}

/** The widgets on one side of the editor, in order. */
export function HookWidgets(props: { readonly model: HookWidgetsModel; readonly placement: WidgetPlacement }): JSXNode {
	const list = props.placement === "belowEditor" ? props.model.below : props.model.above;
	return () => {
		const entries = list();
		if (entries.length === 0) return undefined;
		return (
			<col>
				<For each={entries}>{entry => <Widget content={entry.content} />}</For>
			</col>
		);
	};
}

/** The editor gap's inputs. */
export interface EditorGapProps {
	readonly widgets: HookWidgetsModel;
	/** The status row draws (`StatusHudModel.occupied`). */
	readonly statusOccupied: Accessor<boolean>;
	/** The composer is band-shaped (it sits flush under a drawn status row). */
	readonly band: Accessor<boolean>;
}

/** See the module docs. */
export function EditorGap(props: EditorGapProps): JSXNode {
	const open = (): boolean => props.widgets.above().length > 0 || !props.band() || !props.statusOccupied();
	return <col term={{ role: "omp.editor-gap", open }} />;
}
