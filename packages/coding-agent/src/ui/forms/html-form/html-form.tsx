/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The HTML form dialog: an agent-written form asked as a card of questions
 * (the ask card's vocabulary, `omp.ask.*`). The open field's group shows its
 * legend, text and controls; the other fields fold to their answers. The
 * terminal draws the card from the model (`../../styles/forms/html-form.ts`).
 */
import { computed, effect, type JSXNode, signal, untrack } from "@oh-my-pi/pi-tui";
import { flattenLine } from "@oh-my-pi/pi-tui/text/sanitize";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { ChoiceField, FormBlock, FormField, FormSpan, FormSpanStyle } from "../../../tools/html-form/parse";
import { spansText } from "../../../tools/html-form/parse";
import { keyLabel } from "../../setup/scenes/choice";
import "../../styles/forms";
import { type HtmlFormLook, noteEditHint } from "../../styles/forms/html-form";
import { type FormGroup, type FormPart, isFoldCaption } from "./layout";
import {
	ACTION_ACT,
	CANCEL_ENTRY,
	type HtmlFormAction,
	type HtmlFormModel,
	isDropdown,
	OTHER_ROW,
	type TextBox,
} from "./model";
import type { MediaState } from "./media";
import { actionKbd, actionKeyId, cancelKbd, confirmKbd } from "../../keys/hints";
import { keyTitle } from "../../styles/panels/common";
import { FoldSummaryNode } from "../../overlays/panels/ask-dialog";
import { ActionButton } from "../../overlays/panels/common";

export interface HtmlFormProps {
	readonly model: HtmlFormModel;
	/** A title replacing "Ask · N of M answered" (terminal). */
	readonly title?: string;
	/** Rows of the terminal (the card takes at most 70%). */
	readonly terminalRows?: () => number;
	/** What became of each picture (by `c<section>.<block>` key). */
	readonly media?: () => ReadonlyMap<string, MediaState>;
	/** Copy the host shows while sending the draft skips the form. */
	readonly skipNotice?: () => string | undefined;
	/** Clock (ms) the countdown reads. */
	readonly now?: () => number;
	/** Idle time (ms) after which the draft is sent as it is. */
	readonly timeout?: number;
}

/** Rows a picture takes on a tall terminal. */
const MAX_PICTURE_ROWS = 14;

/** TSP token of each form span style; a new style fails to compile until it has one. */
const STYLE: Record<FormSpanStyle, string> = { code: "code", strong: "strong", em: "em", mark: "mark" };

/** Form spans as TSP spans. */
export function tspSpans(spans: readonly FormSpan[]): TspSpan[] {
	return spans.map(span => (span.style ? { s: STYLE[span.style], t: span.text } : { t: span.text }));
}

function mask(text: string): string {
	return "•".repeat([...text].length);
}

/** A text box's Vim state as Tern shows it: the mode badge and, in Visual modes, the selection's anchor. */
function vimProps(model: HtmlFormModel, box: TextBox, cursor: number): { mode?: string; anchor?: number } {
	const vim = model.vim(box);
	if (!vim) return {};
	const mode = vim.mode();
	if (mode === "normal") return { mode: "NORMAL" };
	const anchor = vim.anchorOffset();
	const selection = vim.selection();
	if (anchor === null || selection === null) return {};
	// Tern selects from the anchor to the caret; Visual line mode reaches the far end of the anchor's line.
	if (mode === "visual") return { mode: "VISUAL", anchor };
	return { mode: "VISUAL", anchor: anchor <= cursor ? selection.from : selection.to };
}

/** A content block (`c<section>.<block>`). */
function Block(props: {
	readonly nodeKey: string;
	readonly block: FormBlock;
	readonly media?: MediaState;
	/** Rows a picture may take. */
	readonly maxLines: number;
}): JSXNode {
	const { nodeKey: key, block } = props;
	switch (block.kind) {
		case "text":
			return (
				<text
					key={key}
					motionKey={key}
					role={block.heading ? "omp.ask.heading" : "omp.ask.text"}
					wrap="word"
					spans={tspSpans(block.spans)}
				/>
			);
		case "list":
			return (
				<col key={key} motionKey={key} role="omp.ask.bullets" gap="xs">
					{block.items.map((item, index) => (
						<text
							role="omp.ask.text"
							wrap="word"
							spans={[{ s: "muted", t: block.ordered ? `${index + 1}.` : "•" }, { t: " " }, ...tspSpans(item)]}
						/>
					))}
				</col>
			);
		case "pre":
			return <code key={key} motionKey={key} role="omp.ask.pre" text={block.text.replaceAll("\t", "   ")} />;
		case "table": {
			const width = Math.max(0, ...block.rows.map(row => row.length));
			const heads = block.rows.slice(0, block.headerRows)[0];
			const body = block.rows.slice(block.headerRows);
			return (
				<table
					key={key}
					motionKey={key}
					role="omp.ask.table"
					cols={Array.from({ length: width }, (_, j) => ({ id: `c${j}`, head: tspSpans(heads?.[j] ?? []) }))}
					rows={body.map((row, r) => ({
						id: `r${r}`,
						cells: Object.fromEntries(row.map((cell, j) => [`c${j}`, tspSpans(cell)])),
					}))}
				/>
			);
		}
		case "image":
		case "svg": {
			const media = props.media;
			if (media?.kind === "ready")
				return (
					<image
						key={key}
						motionKey={key}
						alt={block.alt}
						blob={media.blob}
						max={{ h: `${props.maxLines}lines` }}
					/>
				);
			const label =
				media?.kind === "failed" ? `▣ ${block.alt} — couldn't load: ${media.message}` : `▣ ${block.alt} — loading…`;
			return (
				<text key={key} motionKey={key} role="omp.ask.text" truncate="end" spans={[{ s: "muted", t: label }]} />
			);
		}
		default:
			return null;
	}
}

/** The open field's controls. */
function OpenField(props: {
	readonly model: HtmlFormModel;
	readonly index: number;
	readonly nodeKey: string;
}): JSXNode {
	const { model, index } = props;
	const field = model.field(index);
	const answer = model.answer(index);
	const error = model.error(index);
	const children: JSXNode[] = [];
	if (field.label.length > 0) {
		const spans = tspSpans(field.label);
		if (field.required) spans.push({ s: "error", t: " *" });
		children.push(<text role="omp.ask.label" wrap="word" spans={spans} />);
	}
	if (field.kind === "choice") children.push(...choiceControls(model, index, field));
	else if (field.multiline) {
		children.push(
			<col role="omp.field">
				<editor
					key="input"
					sendable={false}
					maxLines={4}
					text={answer.text.text}
					cursor={answer.text.cursor}
					onEdit={edit => model.edit({ kind: "text", field: index }, edit)}
					placeholder={answer.text.text === "" && field.placeholder ? field.placeholder : undefined}
					{...vimProps(model, { kind: "text", field: index }, answer.text.cursor)}
				/>
			</col>,
		);
	} else {
		const secret = field.type === "password";
		children.push(
			<input
				sendable={false}
				text={secret ? mask(answer.text.text) : answer.text.text}
				cursor={secret ? 0 : answer.text.cursor}
				onEdit={edit => model.edit({ kind: "text", field: index }, edit)}
				placeholder={field.placeholder || undefined}
				{...vimProps(model, { kind: "text", field: index }, answer.text.cursor)}
			/>,
		);
	}
	if (error) children.push(<text role="omp.ask.error" spans={[{ s: "error", t: error }]} />);
	return (
		<col key={props.nodeKey} motionKey={props.nodeKey} role="omp.ask.field" gap="xs">
			{children}
		</col>
	);
}

function choiceControls(model: HtmlFormModel, index: number, field: ChoiceField): JSXNode[] {
	const answer = model.answer(index);
	const row = model.row();
	const dropdown = isDropdown(field);
	const role = field.multi ? "omp.ask.check" : "omp.ask.option";
	// The highlight: the row the keys are on; a dropdown's is its current option, when it has one.
	const chosen = dropdown ? [...answer.checked][0] : row;
	const items = field.options.map((option, i) => {
		const checked = answer.checked.has(i);
		// A note counts once its option is chosen; until then it is a draft.
		const note = answer.notes.get(i);
		const detail: TspSpan[] | undefined =
			note === undefined
				? undefined
				: [
						{ s: "dim", t: checked ? "  ✎ " : "  ✎ draft · " },
						{ s: "em", t: note },
					];
		return (
			<item
				key={`o${i}`}
				role={role}
				label={tspSpans(option.label)}
				{...(option.disabled ? { disabled: true } : { actions: { menu: ["note"] } })}
				{...(checked && field.multi ? { icon: "check" } : {})}
				{...(checked ? { tone: "accent" } : {})}
				{...(detail ? { detail } : {})}
			/>
		);
	});
	if (field.other && !dropdown) {
		// Vim can split the answer (`o`, a linewise put); its row stays one line.
		const typed = answer.other.text.trim().replaceAll("\n", " ");
		// The Other answer counts once it has text.
		const counts = answer.otherChosen && typed !== "";
		items.push(
			<item
				key="other"
				role={role}
				label={typed ? [{ s: "muted", t: "Other: " }, { t: typed }] : [{ t: "Other…" }]}
				{...(counts && field.multi ? { icon: "check" } : {})}
				{...(counts ? { tone: "accent" } : {})}
			/>,
		);
	}
	const out: JSXNode[] = [
		<list
			key={`f${index}`}
			role="omp.ask.options"
			selected={chosen === undefined ? undefined : chosen === OTHER_ROW ? "other" : `o${chosen}`}
			onSelect={item => model.select(index, item, false)}
			onActivate={item => model.select(index, item, true)}
		>
			{items}
		</list>,
	];
	if (!dropdown && row === OTHER_ROW)
		out.push(
			<input
				sendable={false}
				placeholder="type your own"
				text={answer.other.text}
				cursor={answer.other.cursor}
				onEdit={edit => model.edit({ kind: "other", field: index }, edit)}
				{...vimProps(model, { kind: "other", field: index }, answer.other.cursor)}
			/>,
		);
	const note = model.note();
	if (note && note.field === index) {
		out.push(
			<text
				role="omp.ask.note"
				wrap="word"
				text={`Note for ${flattenLine(spansText(field.options[note.option]!.label))}`}
			/>,
			<col role="omp.field">
				<editor
					key="input"
					sendable={false}
					maxLines={dropdown ? 3 : 1}
					text={note.line.text}
					cursor={note.line.cursor}
					onEdit={edit => model.edit({ kind: "note" }, edit)}
					{...vimProps(model, { kind: "note" }, note.line.cursor)}
				/>
			</col>,
		);
	}
	return out;
}

/** A folded field: its mark and question over its answer. */
function Fold(props: { readonly model: HtmlFormModel; readonly index: number; readonly nodeKey: string }): JSXNode {
	const { model, index, nodeKey } = props;
	const field = model.field(index);
	const error = model.error(index);
	const mark: TspSpan = error
		? { s: "error", t: "!" }
		: model.answered(index)
			? { s: "success", t: "✓" }
			: { s: "muted", t: "○" };
	return (
		<col
			key={nodeKey}
			motionKey={nodeKey}
			role="omp.ask.fold"
			gap="xs"
			actions={{ click: `open:${index}` }}
			title="Answer this question"
		>
			<row role="omp.ask.fold.head" align="baseline" gap="sm">
				<text role="omp.ask.fold.mark" spans={[mark]} />
				<text role="omp.ask.fold.question" wrap="word" spans={[{ t: model.question(index) }]} />
			</row>
			{foldSummary(model, index, field, `${nodeKey}.summary`)}
			{error ? <text role="omp.ask.error" spans={[{ s: "error", t: error }]} /> : null}
		</col>
	);
}

function foldSummary(model: HtmlFormModel, index: number, field: FormField, key: string): JSXNode {
	const answer = model.answer(index);
	if (field.kind === "text") {
		const value = answer.text.text;
		if (value.trim() === "")
			return (
				<text
					key={key}
					motionKey={key}
					role="omp.ask.fold.well"
					lines={1}
					truncate="end"
					spans={[{ s: "dim", t: field.placeholder || "type your answer" }]}
				/>
			);
		const text = field.type === "password" ? mask(value) : flattenLine(value);
		return FoldSummaryNode({ summary: { kind: "answer", text }, nodeKey: key, more: `open:${index}` });
	}
	const { pills, note } = model.foldChoice(index);
	return FoldSummaryNode({
		summary: { kind: "pills", pills, ...(note ? { note } : {}) },
		nodeKey: key,
		more: `open:${index}`,
	});
}

/** What the parts of a group or the intro need to draw. */
interface PartsProps {
	readonly model: HtmlFormModel;
	readonly media?: ReadonlyMap<string, MediaState>;
	readonly pictureRows: number;
}

/** Section parts as the card's children: a fieldset's legend, its context and its fields (the open one whole, the rest folded). */
function Parts(props: PartsProps & { readonly parts: readonly FormPart[] }): JSXNode[] {
	const { model } = props;
	const active = model.active();
	const focused = typeof active === "number" ? model.field(active) : undefined;
	return props.parts.flatMap(({ section: s, start, end }) => {
		const section = model.form.sections[s]!;
		const children: JSXNode[] = [];
		if (start === 0 && section.title.length > 0)
			children.push(
				<text key={`l${s}`} motionKey={`l${s}`} role="omp.ask.legend" wrap="word" spans={tspSpans(section.title)} />,
			);
		for (let at = start; at < end; at++) {
			const block = section.blocks[at]!;
			if (block.kind === "field") {
				const index = model.form.fields.indexOf(block.field);
				children.push(
					block.field === focused
						? OpenField({ model, index, nodeKey: `q${index}` })
						: Fold({ model, index, nodeKey: `q${index}` }),
				);
			} else if (!isFoldCaption(section.blocks, at, focused, field => model.questions.get(field))) {
				const key = `c${s}.${at}`;
				children.push(Block({ nodeKey: key, block, media: props.media?.get(key), maxLines: props.pictureRows }));
			}
		}
		return children;
	});
}

/** One group: open (its context, the open field's controls, its other fields folded), or folded field by field. */
function Group(
	props: PartsProps & {
		readonly group: FormGroup;
		/** How many times the open group changed (the host scrolls the open group into view on each). */
		readonly reveal: number;
	},
): JSXNode {
	const { model, group } = props;
	const active = model.active();
	const key = `g${group.index}`;
	const open = typeof active === "number" && group.fields.includes(active);
	if (!open) {
		if (group.fields.length === 1) return Fold({ model, index: group.fields[0]!, nodeKey: key });
		return (
			<col key={key} motionKey={key} role="omp.ask.group" gap="md">
				{group.fields.map(index => Fold({ model, index, nodeKey: `q${index}` }))}
			</col>
		);
	}
	return (
		<col key={key} motionKey={key} role="omp.ask.open" gap="sm" reveal={{ at: "start", n: props.reveal }}>
			{Parts({ ...props, parts: group.parts })}
		</col>
	);
}

function Actions(props: { readonly model: HtmlFormModel; readonly remaining?: number }): JSXNode {
	const model = props.model;
	if (model.note())
		return (
			<row key="actions" motionKey="actions" role="omp.actions" align="center" gap="sm">
				<text
					role="omp.ask.note"
					text={noteEditHint(model)}
				/>
				<ActionButton
					id="cancel"
					label="Keep"
					title={`Keep  ${keyTitle(actionKeyId("tui.select.cancel", "escape"))}`}
					keys={cancelKbd()}
				/>
				<ActionButton
					id="save-note"
					label="Save"
					title={`Save  ${keyTitle(actionKeyId("tui.input.submit", "enter"))}`}
					keys={actionKbd("tui.input.submit", "enter")}
				/>
			</row>
		);
	const active = model.active();
	const field = typeof active === "number" ? model.field(active) : undefined;
	const noteKeys =
		field?.kind === "choice" && (isDropdown(field) || model.row() !== OTHER_ROW)
			? isDropdown(field)
				? ["alt", "n"]
				: ["n"]
			: undefined;
	// Enter on the Submit row presses its picked button: Submit, one of the form's actions, or Cancel.
	const pressed = active === "submit" ? model.pressed() : undefined;
	const enterSubmits = (active === "submit" && !pressed) || model.sole;
	const enterTitle = (label: string): string => `${label}  ${keyTitle(actionKeyId("tui.select.confirm", "enter"))}`;
	// A button Enter presses while picked on the Submit row.
	const pickableButton = (id: string, entry: HtmlFormAction): JSXNode => {
		const on = entry === pressed;
		return (
			<ActionButton
				id={id}
				label={entry.label}
				title={on ? enterTitle(entry.label) : entry.label}
				tone={on ? "accent" : undefined}
				keys={on ? confirmKbd() : undefined}
			/>
		);
	};
	return (
		<row key="actions" motionKey="actions" role="omp.actions" align="center" gap="sm">
			{props.remaining !== undefined ? (
				<text
					role="omp.ask.summary"
					truncate="end"
					spans={[{ s: "muted", t: `Submits these answers in ${Math.ceil(props.remaining / 1000)}s` }]}
				/>
			) : null}
			<spacer grow={1} />
			{model.actions.map(action => pickableButton(`${ACTION_ACT}${action.id}`, action))}
			{pickableButton("cancel", CANCEL_ENTRY)}
			{noteKeys ? (
				<ActionButton
					id="note"
					label="Note"
					title={`Add a note to the highlighted answer  ${keyLabel(noteKeys.join("+"))}`}
					keys={noteKeys}
				/>
			) : null}
			<ActionButton
				id="submit"
				label="Submit"
				tone={pressed ? undefined : "accent"}
				title={enterSubmits ? enterTitle("Submit") : "Submit"}
				keys={enterSubmits ? confirmKbd() : undefined}
			/>
		</row>
	);
}

export function HtmlFormDialog(props: HtmlFormProps): JSXNode {
	const model = props.model;
	const { intro, groups } = model.layout;
	// The open group (or -1 for the Submit row); each change asks the host to bring it into view again.
	const openGroup = computed(() => {
		const active = model.active();
		return active === "submit" ? -1 : groups.findIndex(group => group.fields.includes(active));
	});
	const reveal = signal(0);
	// Pictures take at most 14 rows, fewer when the card is short (it gets 70% of the terminal).
	const pictureRows = (): number =>
		Math.max(1, Math.min(MAX_PICTURE_ROWS, Math.floor((props.terminalRows?.() ?? 40) * 0.7) - 4));
	let last = untrack(openGroup);
	effect(() => {
		const group = openGroup();
		if (group === last) return;
		last = group;
		reveal.set(untrack(reveal) + 1);
	});
	// The countdown restarts on every key; when it runs out the draft is sent as it is.
	const timeout = props.timeout;
	const now = props.now ?? (() => Date.now());
	const deadline = signal(timeout === undefined ? undefined : untrack(now) + timeout);
	const timedOut = signal(false);
	const remaining = (): number | undefined => {
		const end = deadline();
		return end === undefined || timedOut() ? undefined : Math.max(0, end - now());
	};
	effect(() => {
		const left = remaining();
		if (left !== undefined && left <= 0)
			untrack(() => {
				timedOut.set(true);
				model.timeout();
			});
	});
	const restart = (): void => {
		if (timeout !== undefined && !untrack(timedOut)) deadline.set(untrack(now) + timeout);
	};
	const look = (): HtmlFormLook => ({
		look: "omp.html-form",
		model,
		...(props.title ? { title: props.title } : {}),
		terminalRows: props.terminalRows?.() ?? 40,
		media: props.media?.(),
		skipNotice: props.skipNotice?.(),
		remaining: remaining(),
	});
	return (
		<col
			role="omp.ask.card"
			gap="md"
			transition="layout"
			reveal="start"
			term={look}
			onKey={key => {
				restart();
				return model.key(key);
			}}
			onPaste={paste => {
				model.paste(paste.text);
				return true;
			}}
			onAction={(act, event) => {
				restart();
				model.action(act, event.key);
			}}
		>
			<row key="head" motionKey="head" role="omp.ask.card.head" align="baseline" gap="sm" justify="between">
				<text role="omp.ask.card.tag" spans={[{ s: "accent", t: "ask" }]} />
				{() => {
					const progress = model.progress();
					return progress ? <text role="omp.ask.card.progress" spans={[{ s: "muted", t: progress }]} /> : null;
				}}
			</row>
			<col key="body" role="omp.ask.card.body" gap="lg" mark={() => (props.skipNotice?.() ? "drop" : undefined)}>
				{() => {
					const parts = { model, media: props.media?.(), pictureRows: pictureRows() };
					return [
						intro.length > 0 ? (
							<col key="intro" motionKey="intro" role="omp.ask.intro" gap="md">
								{Parts({ ...parts, parts: intro })}
							</col>
						) : null,
						...groups.map(group => Group({ ...parts, group, reveal: reveal() })),
					];
				}}
			</col>
			{() => {
				const notice = props.skipNotice?.();
				return notice ? (
					<text
						key="skip"
						motionKey="skip"
						role="omp.ask.skip"
						wrap="word"
						spans={[{ s: "warning", t: `${currentTheme().symbols.symbol("status.warning")} ${notice}` }]}
					/>
				) : null;
			}}
			{() => Actions({ model, remaining: remaining() })}
		</col>
	);
}
