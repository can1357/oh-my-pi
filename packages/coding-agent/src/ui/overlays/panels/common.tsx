/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Building blocks the overlay panels share: buttons (`omp.btn`, `omp.app.ibtn`, `omp.app.qbtn`),
 * key hints (a `kbd` beside a muted label) and the hint strip
 * (`omp.overlay.hints`).
 */
import {
	type JSXNode,
	type KeyEvent,
	nativeSupports,
	type PasteEvent,
	type Reactive,
	read,
	type Signal,
	signal,
	type TextEdit,
	type UiNode,
} from "@oh-my-pi/pi-tui";
import { type WidgetContext, widgetFor, widgetState } from "@oh-my-pi/pi-tui/term/widgets";
import type { TspMark, TspSpan, TspTone } from "@oh-my-pi/pi-wire";

/** What an {@link ActionButton} takes. */
export interface ActionButtonProps {
	/** The action a click sends. */
	readonly id: string;
	readonly label: Reactive<string>;
	/** Native key: defaults to the action id. */
	readonly nodeKey?: string;
	/** Tooltip: defaults to the label. */
	readonly title?: Reactive<string | undefined>;
	readonly tone?: Reactive<TspTone | undefined>;
	/** Shortcut keycap (`kbd`). */
	readonly keys?: readonly string[];
	/** Target of an `open` action (URL or `file://` path). */
	readonly href?: Reactive<string | undefined>;
	/** Icon beside the label. */
	readonly icon?: string;
	/** Why the action cannot run now: the button dims (tone `muted`) and a click on the row sends nothing. */
	readonly disabled?: string;
	/** The button's work is running: a spinner leads the label. */
	readonly busy?: boolean;
	/** How a dialog's choice marks the button (`pick`, `drop`). */
	readonly mark?: Reactive<TspMark | undefined>;
}

/**
 * A clickable action (role `omp.btn`): a `button` where the terminal draws
 * that kind, else the `row` (label, icon, keycap) older terminals style by role.
 */
export function ActionButton(props: ActionButtonProps): JSXNode {
	const key = props.nodeKey ?? props.id;
	const title = props.title ?? props.label;
	const disabled = props.disabled;
	const tone = (): TspTone | undefined => (disabled === undefined ? read(props.tone) : "muted");
	const keycap = props.keys && props.keys.length > 0 ? props.keys : undefined;
	return () => {
		if (nativeSupports("button")) {
			return (
				<button
					key={key}
					role="omp.btn"
					text={props.label}
					actions={{ click: props.id }}
					title={title}
					keys={keycap}
					icon={props.icon}
					variant={() => (tone() === "accent" ? "primary" : tone() === "error" ? "danger" : undefined)}
					tone={tone}
					disabled={disabled === undefined ? undefined : disabled || true}
					busy={props.busy || undefined}
					href={props.href}
					mark={props.mark}
				/>
			);
		}
		return (
			<row
				key={key}
				role="omp.btn"
				align="center"
				gap="xs"
				actions={disabled === undefined ? { click: props.id } : undefined}
				title={title}
				tone={tone}
				href={props.href}
				mark={props.mark}
			>
				{props.busy ? <spinner style="dots" /> : null}
				<text text={props.label} />
				{props.icon ? <icon key="icon" name={props.icon} /> : null}
				{keycap && <kbd keys={keycap} />}
			</row>
		);
	};
}

/** A bare `esc` keycap button for a view's corner: a click sends `act`. */
export function EscCloseButton(props: { readonly act?: string; readonly nodeKey?: string }): JSXNode {
	const key = props.nodeKey ?? "esc-close";
	const actions = { click: props.act ?? "close" };
	return () =>
		nativeSupports("button") ? (
			<button key={key} role="omp.btn" keys={["escape"]} actions={actions} title="Close  esc" aria="Close" />
		) : (
			<row key={key} role="omp.btn" align="center" actions={actions} title="Close  esc">
				<kbd keys={["escape"]} />
			</row>
		);
}

/**
 * A quiet icon-only button (role `omp.app.ibtn`, `.set` while a toggle is on):
 * a `button` where the terminal draws that kind, else an `icon` with a click action.
 */
export function IconButton(props: {
	readonly name: string;
	readonly act: string;
	readonly title: string;
	/** Accessible name: defaults to the title. */
	readonly aria?: string;
	/** A toggle that is on. */
	readonly on?: boolean;
	readonly nodeKey?: string;
}): JSXNode {
	const role = props.on ? "omp.app.ibtn.set" : "omp.app.ibtn";
	const aria = props.aria ?? props.title;
	const actions = { click: props.act };
	return () =>
		nativeSupports("button") ? (
			<button
				key={props.nodeKey}
				role={role}
				variant="quiet"
				icon={props.name}
				title={props.title}
				aria={aria}
				actions={actions}
				on={props.on ? true : undefined}
			/>
		) : (
			<icon key={props.nodeKey} name={props.name} role={role} title={props.title} aria={aria} actions={actions} />
		);
}

/**
 * A quiet text button (role `omp.app.qbtn`) keyed by its action: a small quiet
 * `button` where the terminal draws that kind, else `children` (default: a row of the label).
 */
export function QuietButton(props: {
	readonly label: string;
	readonly act: string;
	readonly title: string;
	/** What older terminals and rows get instead of the default row. */
	readonly children?: JSXNode;
}): JSXNode {
	const actions = { click: props.act };
	return () =>
		nativeSupports("button") ? (
			<button
				key={props.act}
				role="omp.app.qbtn"
				variant="quiet"
				size="sm"
				text={props.label}
				actions={actions}
				title={props.title}
			/>
		) : (
			(props.children ?? (
				<row key={props.act} role="omp.app.qbtn" actions={actions} title={props.title}>
					<text text={props.label} />
				</row>
			))
		);
}

/** The `variant` of a segmented `tabs` control: `segmented` where the terminal draws it, else unset (styled by role). */
export function segmentedVariant(): "segmented" | undefined {
	return nativeSupports("button") ? "segmented" : undefined;
}

/** One key hint: the key(s) and what they do. */
export interface KeyHint {
	readonly keys: readonly string[];
	readonly label: string;
}

/** A key hint: `kbd` beside a muted label. */
export function Hint(props: { readonly keys: readonly string[]; readonly label: string; readonly nodeKey?: string }) {
	return (
		<row key={props.nodeKey} align="center" gap="xs">
			<kbd keys={props.keys} />
			<text spans={[{ s: "muted", t: props.label }] satisfies TspSpan[]} />
		</row>
	);
}

/** The hint strip under a panel. */
export function Hints(props: { readonly hints: Reactive<readonly KeyHint[]>; readonly nodeKey?: string }): JSXNode {
	const hints = () => (typeof props.hints === "function" ? props.hints() : props.hints);
	return (
		<row key={props.nodeKey ?? "hints"} role="omp.overlay.hints" gap="md" wrap>
			{() => hints().map(hint => <Hint keys={hint.keys} label={hint.label} />)}
		</row>
	);
}

/** Muted spans of `text`. */
export function muted(text: string): TspSpan[] {
	return [{ s: "muted", t: text }];
}

/** A line and its caret (UTF-16 offset). */
export interface LineValue {
	readonly text: string;
	readonly cursor: number;
}

/** `edit` applied to `line`; undefined when the edit is stale (it was made against other text). */
export function applyEdit(line: LineValue, edit: TextEdit): LineValue | undefined {
	if (edit.len !== line.text.length) return undefined;
	return { text: `${line.text.slice(0, edit.from)}${edit.text}${line.text.slice(edit.to)}`, cursor: edit.cursor };
}

/**
 * `edit` applied to a secret value shown as one bullet per character: the
 * edit's offsets count bullets, so they index the value's characters.
 */
export function applyMaskedEdit(line: LineValue, edit: TextEdit): LineValue | undefined {
	const chars = Array.from(line.text);
	if (edit.len !== chars.length) return undefined;
	chars.splice(edit.from, edit.to - edit.from, ...Array.from(edit.text));
	return { text: chars.join(""), cursor: edit.cursor };
}

/** A hint drawn as keycaps (one `kbd` per key combination) beside its muted label; no keys: the label alone. */
export interface KeycapHint {
	readonly keys: readonly (readonly string[])[];
	readonly label: string;
}

/** A hint strip (`omp.overlay.hints`) of {@link KeycapHint}s. */
export function KeycapHints(props: { readonly nodeKey: string; readonly hints: () => readonly KeycapHint[] }): JSXNode {
	return (
		<row key={props.nodeKey} role="omp.overlay.hints" gap="md" wrap>
			{() =>
				props.hints().map(hint => (
					<row align="center" gap="xs">
						{hint.keys.map(keys => (
							<kbd keys={keys} />
						))}
						<text spans={muted(hint.label)} />
					</row>
				))
			}
		</row>
	);
}

/**
 * Hand a key or paste a screen did not use to the field behaviour of an
 * `editor`/`input` it draws itself (the field never holds the focus):
 * the field's edits go to `onEdit`.
 */
export function feedField(
	field: UiNode,
	input: { readonly key: KeyEvent } | { readonly paste: PasteEvent },
	onEdit: (edit: TextEdit) => void,
): void {
	const cx: WidgetContext = {
		emit: event => {
			if (event.type === "edit") onEdit(event);
		},
		state: <T,>(name: string, init: () => T): Signal<T> => {
			const map = widgetState(field);
			let value = map.get(name) as Signal<T> | undefined;
			if (!value) {
				value = signal(init());
				map.set(name, value as Signal<unknown>);
			}
			return value;
		},
		keypath: "",
		focus: () => {},
		pageRows: 10,
	};
	const widget = widgetFor(field);
	if ("key" in input) widget?.key?.(field, input.key, cx);
	else widget?.paste?.(field, input.paste, cx);
}
