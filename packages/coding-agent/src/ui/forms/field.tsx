/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Form controls: a field frame (label, description, details, preview, the
 * control, error, summary, hint, footer), a text field, a select field and a
 * form of text fields. Looks: `../styles/forms`.
 */
import { type Accessor, computed, For, type JSXNode, type KeyEvent, type Reactive, read, Show } from "@oh-my-pi/pi-tui";
import type { TspPickerAction, TspPickerItem, TspSpan } from "@oh-my-pi/pi-wire";
import "../styles/forms";
import { type FieldSlot, type FieldTerm, SELECT_LOOK } from "../styles/forms/field";
import { applyEdit } from "../overlays/panels/common";
import { type FormModel, maskSecret, type SelectFieldModel, type TextFieldModel } from "./models";
import { closeAction, pickerAction } from "../overlays/pickers/select-sheet";
import { confirmKbd } from "../keys/hints";

/** A text block of a field: spans, wrapped by words when `wrap` is set, indented by `pad` cells. */
export interface FieldText {
	readonly spans: readonly TspSpan[];
	readonly wrap?: boolean;
	readonly pad?: number;
}

/** The parts around a field's control. */
export interface FieldFrame {
	readonly label?: string;
	readonly description?: string;
	readonly details?: readonly FieldText[];
	/** Shown above the preview only (ignored without one). */
	readonly previewLabel?: string;
	readonly preview?: Reactive<FieldText | undefined>;
	readonly hint?: string;
	readonly summary?: readonly FieldText[];
	readonly footer?: FieldText;
	/** A blank row above the field. */
	readonly leadingSpace?: boolean;
	/** Blank rows around the control (default both). */
	readonly spaceBeforeControl?: boolean;
	readonly spaceAfterControl?: boolean;
}

function slotText(slot: FieldSlot, text: FieldText): JSXNode {
	return (
		<text
			spans={[...text.spans]}
			wrap={text.wrap ? "word" : undefined}
			term={text.pad ? { slot, pad: text.pad } : { slot }}
		/>
	);
}

/** The frame of one field around `control`. */
export function FormField(
	props: FieldFrame & {
		readonly error: Accessor<string | undefined>;
		readonly children: JSXNode;
		readonly onKey?: (key: KeyEvent) => boolean;
		readonly onPaste?: (text: string) => void;
	},
) {
	const term: FieldTerm = {
		leadingSpace: props.leadingSpace === true,
		spaceBefore: props.spaceBeforeControl !== false,
		spaceAfter: props.spaceAfterControl !== false,
	};
	const preview = computed(() => read(props.preview));
	return (
		<col
			role="omp.form.field"
			gap="sm"
			term={term}
			onKey={props.onKey}
			onPaste={
				props.onPaste &&
				(paste => {
					props.onPaste!(paste.text);
					return true;
				})
			}
		>
			{props.label ? <text spans={[{ s: "strong", t: props.label }]} term={{ slot: "label" }} /> : null}
			{props.description ? (
				<text spans={[{ s: "muted", t: props.description }]} term={{ slot: "description" }} />
			) : null}
			{(props.details ?? []).map(detail => slotText("detail", detail))}
			<Show when={() => preview() !== undefined}>
				{props.previewLabel ? (
					<text spans={[{ s: "muted", t: props.previewLabel }]} term={{ slot: "previewLabel" }} />
				) : null}
				<text
					spans={() => [...(preview()?.spans ?? [])]}
					wrap={() => (preview()?.wrap ? "word" : undefined)}
					term={{ slot: "preview" }}
				/>
			</Show>
			{props.children}
			{() => {
				const error = props.error();
				return error === undefined ? (
					<text hidden text="" term={{ slot: "error" }} />
				) : (
					<text spans={[{ s: "error", t: error }]} term={{ slot: "error" }} />
				);
			}}
			{(props.summary ?? []).map(line => slotText("summary", line))}
			{props.hint ? <text spans={[{ s: "muted", t: props.hint }]} term={{ slot: "hint" }} /> : null}
			{props.footer ? slotText("footer", props.footer) : null}
		</col>
	);
}

/** The `input` of a text field (edits from a Tern terminal land in the model). */
export function TextInput(props: {
	readonly model: TextFieldModel;
	readonly prompt?: string;
	readonly promptStyle?: string;
}) {
	const model = props.model;
	const shown = computed(() => {
		const line = model.line();
		if (!model.secret) return line;
		return { text: maskSecret(line.text), cursor: Array.from(line.text.slice(0, line.cursor)).length };
	});
	return (
		<input
			prompt={props.prompt ?? "> "}
			sendable={false}
			text={() => shown().text}
			cursor={() => shown().cursor}
			term={props.promptStyle ? { promptStyle: props.promptStyle } : undefined}
			onEdit={edit => model.edit(line => applyEdit(line, edit))}
		/>
	);
}

/** A text field: the frame around a one-line input. */
export function TextField(
	props: FieldFrame & { readonly model: TextFieldModel; readonly prompt?: string; readonly promptStyle?: string },
) {
	return (
		<FormField
			{...props}
			error={props.model.error}
			onKey={key => props.model.key(key)}
			onPaste={text => props.model.paste(text)}
		>
			<TextInput model={props.model} prompt={props.prompt} promptStyle={props.promptStyle} />
		</FormField>
	);
}

/** The list of a select field (`omp.select`): options, and the search status once it overflows. */
export function SelectList(props: { readonly model: SelectFieldModel }) {
	const model = props.model;
	const status = (): TspSpan[] => {
		const query = model.query();
		return [{ s: "muted", t: query ? `Search: ${query}` : "Type to search" }];
	};
	return (
		<col role="omp.select">
			<list
				key="list"
				empty={() => (model.query() ? "No matching items" : "No items")}
				filter={() => model.query() || undefined}
				max={{ lines: model.maxVisible }}
				selected={model.selected}
				onSelect={item => model.select(item)}
				onActivate={item => {
					model.select(item);
					model.submit();
				}}
			>
				<For each={model.visible}>
					{item => (
						<item
							key={item.value}
							label={[{ t: item.label }]}
							detail={item.description === undefined ? undefined : [{ s: "muted", t: item.description }]}
						/>
					)}
				</For>
			</list>
			{model.searchable ? <text key="status" spans={status} wrap="none" /> : null}
		</col>
	);
}

/** Select and Close, on the selector confirm and cancel keys. */
const pickerActions = (): TspPickerAction[] => [
	pickerAction("confirm", "Select", confirmKbd(), { primary: true }),
	closeAction(),
];

/**
 * A select field. With nothing but a label it is a plain picker (natively a
 * `picker` sheet); with a description or preview it is a framed list.
 */
export function SelectField(props: FieldFrame & { readonly model: SelectFieldModel }): JSXNode {
	const model = props.model;
	const onKey = (key: KeyEvent): boolean => model.key(key);
	if (props.description === undefined && props.preview === undefined && !props.details?.length) {
		const items = computed(() =>
			model.visible().map((item): TspPickerItem => ({
				id: item.value,
				label: item.label,
				...(item.description === undefined ? {} : { detail: item.description }),
			})),
		);
		return (
			<picker
				title={props.label}
				noun="options"
				size="md"
				layout="rows"
				preview="none"
				query={model.query}
				cursor={() => model.query().length}
				items={items}
				selected={() => model.selected() ?? null}
				confirm={null}
				actions={pickerActions()}
				term={() => ({ look: SELECT_LOOK, error: model.error(), maxRows: model.maxVisible })}
				onKey={onKey}
				onSelect={item => model.select(item)}
				onActivate={item => {
					model.select(item);
					model.submit();
				}}
				onAction={act => {
					if (act === "confirm") model.submit();
				}}
			/>
		);
	}
	return (
		<FormField {...props} error={model.error} onKey={onKey}>
			<SelectList model={model} />
		</FormField>
	);
}

/** A form of text fields stacked in order. */
export function Form(props: {
	readonly model: FormModel;
	readonly fields: readonly (FieldFrame & { prompt?: string })[];
}) {
	const model = props.model;
	return (
		<col
			role="omp.form"
			gap="md"
			onKey={key => model.key(key)}
			onPaste={paste => {
				model.paste(paste.text);
				return true;
			}}
			onFocus={event => model.focusField(Number(event.key.split("/").at(-1)))}
		>
			{model.fields.map((field, index) => (
				<TextField {...props.fields[index]} model={field} />
			))}
		</col>
	);
}
