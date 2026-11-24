/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The text prompts extensions and tools open: {@link HookInput} (one line,
 * optionally secret and timed) and {@link HookEditor} (multi-line, prompt
 * style for the ask tool's custom answers, an external editor).
 *
 * The title's first line heads the dialog; the rest is its detail. Both edit
 * their text through the field's `edit` events (the terminal's field widget
 * sends the same). With `tui.vimMode` the hook editor's box is a Vim box:
 * Escape first leaves Insert mode, and only a quiet Normal mode cancels.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type Accessor, type JSXNode, onCleanup, type Signal, signal, type TextEdit, untrack } from "@oh-my-pi/pi-tui";
import type { EditorTerm } from "@oh-my-pi/pi-tui/term/painters/editor";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { HookEditorOptions } from "../../../modes/view-model/overlays/hook-editor";
import {
	compactImageMarkers,
	formatVisionMarker,
	visionMarkerRanges,
} from "../../../modes/view-model/prompt/composer-attachments";
import { extractImagePastePathsFromText } from "../../../modes/view-model/prompt/custom-editor";
import "../../styles/forms";
import "../../styles/panels/hook-dialogs";
import { ActionButton, applyEdit, applyMaskedEdit, type LineValue } from "./common";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import {
	appExternalEditorKeys,
	appFollowUpKeys,
	appInterruptKeys,
	matchesAnyKey,
	matchesAppInterrupt,
} from "../../../config/keybindings/matchers";
import { kbdOf } from "../../keys/hints";
import { type DialogVim, UndoHistory, VimEditor } from "../../composer/vim-editor";
import { keyTitle } from "../../styles/panels/common";

/** A title split into its heading line and the detail under it. */
function splitTitle(title: string): { head: string; detail?: string } {
	const newline = title.indexOf("\n");
	if (newline === -1) return { head: title };
	const detail = title.slice(newline + 1).trim();
	return { head: title.slice(0, newline), ...(detail ? { detail } : {}) };
}

/** The title as the terminal frame shows it: one line, whitespace runs collapsed. */
function frameTitle(title: string): string {
	return replaceTabs(title).replace(/\s+/g, " ").trim();
}

/** The cancel button, on the interrupt key (`app.interrupt`). */
function CancelButton(): JSXNode {
	const key = appInterruptKeys()[0] ?? "escape";
	return <ActionButton id="cancel" label="Cancel" title={`Cancel  ${keyTitle(key)}`} keys={kbdOf(key)} />;
}

// ─── Hook input ─────────────────────────────────────────────────────────────

export interface HookInputOptions {
	/** Mask the typed text. */
	readonly secret?: boolean;
	/** Cancel after this many ms without typing. */
	readonly timeout?: number;
	/** The countdown ran out; the input cancels right after. */
	onTimeout?(): void;
}

export interface HookInputProps {
	readonly title: string;
	readonly placeholder?: string;
	readonly options?: HookInputOptions;
	onSubmit(value: string): void;
	onCancel(): void;
}

/** Mask of a secret value, one bullet per character. */
const mask = (text: string) => "•".repeat([...text].length);

export function HookInput(props: HookInputProps): JSXNode {
	const { head, detail } = splitTitle(props.title);
	const timeout = props.options?.timeout;
	const secret = props.options?.secret === true;
	const line = signal<LineValue>({ text: "", cursor: 0 });
	const remaining = signal(timeout === undefined ? 0 : Math.ceil(timeout / 1000));
	if (timeout !== undefined) {
		const timer = setInterval(() => {
			const next = untrack(remaining) - 1;
			remaining.set(next);
			if (next <= 0) {
				clearInterval(timer);
				props.options?.onTimeout?.();
				props.onCancel();
			}
		}, 1000);
		timer.unref?.();
		onCleanup(() => clearInterval(timer));
	}
	const restart = () => {
		if (timeout !== undefined) remaining.set(Math.ceil(timeout / 1000));
	};
	const submit = () => props.onSubmit(untrack(line).text);
	const submitKey = getKeybindings().keysFor("tui.input.submit")[0] ?? "enter";
	const placeholder = props.placeholder?.trim() ? props.placeholder : undefined;
	return (
		<col
			role="omp.overlay.hook-input"
			term={() => ({
				title: frameTitle(`${props.title}${timeout !== undefined ? ` (${remaining()}s)` : ""}`),
			})}
			onKey={key => {
				if (getKeybindings().matches(key, "tui.input.submit")) submit();
				else if (matchesAppInterrupt(key) || key.id === "ctrl+c") props.onCancel();
				else return false;
				return true;
			}}
			onAction={act => {
				if (act === "submit") submit();
				else if (act === "cancel") props.onCancel();
			}}
		>
			<col key="head" role="omp.hook-input.head" gap="xs">
				<row key="line" align="baseline" gap="md">
					<text key="title" role="omp.hook-input.title" grow={1} wrap="word" spans={[{ t: head }]} />
					{timeout !== undefined && (
						<row
							key="timer"
							role="omp.hook-input.timer"
							title="Cancels when the time runs out; typing restarts it"
						>
							<elapsed format="short" age={-timeout} />
						</row>
					)}
				</row>
				{detail && <text key="detail" role="omp.hook-input.detail" wrap="word" spans={[{ t: detail }]} />}
			</col>
			<col key="field" role="omp.hook-input.field">
				<col role="omp.form" gap="md">
					<col role="omp.form.field" gap="sm">
						<input
							prompt="> "
							placeholder={placeholder}
							sendable={false}
							text={() => (secret ? mask(line().text) : line().text)}
							cursor={() => line().cursor}
							onEdit={edit => {
								const current = untrack(line);
								const next = secret ? applyMaskedEdit(current, edit) : applyEdit(current, edit);
								if (!next) return;
								line.set(next);
								restart();
							}}
						/>
						<text hidden text="" />
					</col>
				</col>
			</col>
			<row key="actions" role="omp.actions" align="center" gap="sm">
				<spacer grow={1} />
				<CancelButton />
				<ActionButton
					id="submit"
					label="Submit"
					title={`Submit  ${keyTitle(submitKey)}`}
					tone="accent"
					keys={kbdOf(submitKey)}
				/>
			</row>
		</col>
	);
}

// ─── Hook editor ────────────────────────────────────────────────────────────

/** A Vim layer over the box's `line`, in the start mode. */
function vimBox(line: Signal<LineValue>, dialog: DialogVim, history: UndoHistory): VimEditor {
	const vim = new VimEditor({
		text: () => line().text,
		cursor: () => line().cursor,
		set: (text, cursor) => line.set({ text, cursor }),
		history,
		recordsUndo: true,
		...dialog,
	});
	vim.begin();
	return vim;
}

/** The native field's mode label: Tern forwards the keys of a Vim command mode instead of typing them. */
function vimLabel(vim: VimEditor | undefined): string | undefined {
	switch (vim?.mode()) {
		case "normal":
			return "NORMAL";
		case "visual":
		case "visual-line":
			return "VISUAL";
		case "replace":
			return "REPLACE";
		default:
			return undefined;
	}
}

/** The terminal look of a Vim box: an underline caret in Insert, a block in Normal, the Visual selection. */
function vimTerm(vim: VimEditor): EditorTerm {
	const typing = vim.mode() === "insert" || vim.mode() === "replace";
	return {
		caret: typing ? "underline" : "block",
		caretEnd: typing ? "bar" : "block",
		selection: vim.selection(),
	};
}

/** Editor rows when the caller sets no height. */
const DEFAULT_MAX_LINES = 18;
const graphemes = new Intl.Segmenter();

/** `edit` with a deletion that reaches into an attached image's marker widened to the whole marker. */
function widenOverMarkers(edit: TextEdit, text: string, images: number): TextEdit {
	if (edit.text !== "" || edit.from >= edit.to) return edit;
	let { from, to } = edit;
	for (const range of visionMarkerRanges(text, images)) {
		if (range.from < to && range.to > from) {
			from = Math.min(from, range.from);
			to = Math.max(to, range.to);
		}
	}
	return from === edit.from && to === edit.to ? edit : { ...edit, from, to, cursor: from };
}

export interface HookEditorProps {
	readonly title: string;
	readonly prefill?: string;
	readonly options?: HookEditorOptions;
	/** The terminal draws its own caret (no caret glyph in the text). */
	readonly terminalCursor?: Accessor<boolean>;
	/** Vim editing in the box (`tui.vimMode`): the start mode and the clipboard registers. */
	readonly vim?: DialogVim;
	onSubmit(value: string, images?: readonly ImageContent[]): void;
	onCancel(draft: string, images?: readonly ImageContent[]): void;
}

/** Attach images (clipboard pastes) and replace the text from outside. */
export interface HookEditorHandle {
	setText(text: string): void;
	/** Insert `text` at the caret. */
	paste(text: string): void;
	/**
	 * Attach `image`; returns its `[Image #N, WxH]` marker for the caller to deliver (see {@link paste}),
	 * or undefined when the prompt did not opt into images (`acceptImages`) or has closed.
	 */
	attachImage(image: ImageContent, dims?: { readonly width: number; readonly height: number }): string | undefined;
}

export function HookEditor(props: HookEditorProps & { readonly ref?: (handle: HookEditorHandle) => void }): JSXNode {
	const options = props.options ?? {};
	const prompt = options.promptStyle === true;
	const question = options.question;
	const { head, detail } = splitTitle(props.title);
	const initial = replaceTabs(props.prefill ?? "");
	const line = signal<LineValue>({ text: initial, cursor: initial.length });
	const images = signal<readonly ImageContent[]>(options.images ?? []);
	const history = new UndoHistory();
	const vim = props.vim && vimBox(line, props.vim, history);
	let wordEnd = -1;
	/** Group consecutive typed word characters; replacements, caret moves and Vim break the run. */
	const edit = (next: LineValue, field?: TextEdit) => {
		const before = untrack(line);
		const word =
			!vim &&
			field &&
			field.from === field.to &&
			field.cursor === field.from + field.text.length &&
			/^\S/u.test(field.text) &&
			(field.text.length === 1 || graphemes.segment(field.text).containing(0)?.segment === field.text);
		if (next.text !== before.text && !(word && field.from === wordEnd)) history.push(before);
		wordEnd = word ? next.cursor : -1;
		line.set(next);
		vim?.edited(before);
	};
	let open = true;
	onCleanup(() => {
		open = false;
	});
	props.ref?.({
		setText: text => {
			const value = replaceTabs(text);
			edit({ text: value, cursor: value.length });
		},
		paste: value => {
			const { text, cursor } = untrack(line);
			edit({ text: text.slice(0, cursor) + value + text.slice(cursor), cursor: cursor + value.length });
		},
		attachImage: (image, dims) => {
			if (!options.acceptImages || !open) return undefined;
			const next = [...untrack(images), image];
			images.set(next);
			return formatVisionMarker("image", next.length, dims);
		},
	});
	/** The text and the images its markers still reference, renumbered by appearance (path pastes land out of order). */
	const value = (): { text: string; images: readonly ImageContent[] } => {
		const text = untrack(line).text;
		const attached = untrack(images);
		const compacted = compactImageMarkers(text, attached.length, { byAppearance: true });
		return compacted
			? { text: compacted.text, images: compacted.keep.map(i => attached[i]!) }
			: { text, images: attached };
	};
	const submit = () => {
		const { text, images } = value();
		props.onSubmit(text, images);
	};
	const cancel = () => {
		const { text, images } = value();
		props.onCancel(text, images);
	};
	/** With `acceptImages`: an empty paste (image-only clipboard) and a paste of image paths attach images. */
	const pasteImages = (text: string): boolean => {
		if (!options.acceptImages) return false;
		if (text === "") {
			void options.onPasteImage?.();
			return options.onPasteImage !== undefined;
		}
		const paths = extractImagePastePathsFromText(text);
		if (!paths || !options.onPasteImagePath) return false;
		for (const path of paths) void options.onPasteImagePath(path);
		return true;
	};
	const external = async () => {
		if (!options.externalEditor) return;
		const edited = await options.externalEditor(untrack(line).text);
		if (edited !== null) edit({ text: edited, cursor: edited.length });
	};
	const placeholder = prompt ? "Type your answer" : "Type here";
	const externalKey = appExternalEditorKeys()[0] ?? "ctrl+g";
	// Ctrl+Q leads: Ctrl+Enter does not reach every terminal (#1903).
	const followUpKeys = appFollowUpKeys();
	const followUpKey = followUpKeys.includes("ctrl+q") ? "ctrl+q" : (followUpKeys[0] ?? "ctrl+q");
	const flatQuestion = question === undefined ? undefined : replaceTabs(question.replace(/\r\n?/g, "\n"));
	return (
		<col
			role="omp.overlay.hook-editor"
			term={() => ({
				title: frameTitle(flatQuestion !== undefined ? `${props.title}: ${flatQuestion}` : head),
				detail: flatQuestion === undefined ? detail : undefined,
				prompt,
				caret: !(props.terminalCursor?.() ?? false),
			})}
			onKey={key => {
				if (matchesAnyKey(key, appFollowUpKeys()) || (prompt && key.id === "enter")) submit();
				else if (matchesAppInterrupt(key) || (prompt && key.id === "escape") || key.id === "ctrl+c") cancel();
				else if (matchesAnyKey(key, appExternalEditorKeys())) void external();
				else if (key.id === "enter" && !prompt) {
					const { text, cursor } = untrack(line);
					edit({ text: `${text.slice(0, cursor)}\n${text.slice(cursor)}`, cursor: cursor + 1 });
				} else return false;
				return true;
			}}
			onAction={act => {
				if (act === "submit") submit();
				else if (act === "cancel") cancel();
				else if (act === "external") void external();
			}}
		>
			<col key="head" role="omp.hook-editor.head" gap="xs">
				{flatQuestion !== undefined
					? [
							<text
								key="eyebrow"
								role="omp.hook-editor.eyebrow"
								wrap="none"
								truncate="end"
								spans={[{ t: head }]}
							/>,
							<md key="question" role="omp.ask.question" text={flatQuestion} />,
						]
					: [
							<text key="title" role="omp.hook-editor.title" wrap="word" spans={[{ t: head }]} />,
							detail && <text key="detail" role="omp.hook-editor.detail" wrap="word" spans={[{ t: detail }]} />,
						]}
			</col>
			<col role={prompt ? "omp.hook-editor.line" : "omp.hook-editor.field"}>
				<editor
					key="input"
					text={() => line().text}
					cursor={() => line().cursor}
					sendable={false}
					maxLines={options.maxHeight ?? DEFAULT_MAX_LINES}
					onPaste={paste => pasteImages(paste.text)}
					placeholder={() => (line().text === "" ? [{ t: placeholder }] : undefined)}
					onEdit={event => {
						const current = untrack(line);
						const next = applyEdit(current, widenOverMarkers(event, current.text, untrack(images).length));
						if (next) edit(next, event);
					}}
					// Vim takes its keys first: Escape leaves Insert mode before the dialog cancels on it.
					onKey={key => vim?.handle(key) ?? false}
					onUndo={() => {
						wordEnd = -1;
						if (vim) vim.undo();
						else {
							const before = history.undo(untrack(line));
							if (before) line.set(before);
						}
					}}
					mode={() => vimLabel(vim)}
					anchor={() => vim?.anchorOffset() ?? undefined}
					term={() => (vim ? vimTerm(vim) : undefined)}
				/>
			</col>
			<row key="actions" role="omp.actions" align="center" gap="sm">
				{options.externalEditor && (
					<ActionButton
						id="external"
						label="Open in editor"
						title={`Edit in your external editor  ${keyTitle(externalKey)}`}
						keys={kbdOf(externalKey)}
					/>
				)}
				<spacer grow={1} />
				<CancelButton />
				<ActionButton
					id="submit"
					label="Submit"
					title={
						prompt
							? `Submit  ${keyTitle("enter")} · New line  ${keyTitle("shift+enter")}`
							: `Submit  ${keyTitle(followUpKey)} · New line  ${keyTitle("enter")}`
					}
					tone="accent"
					keys={kbdOf(prompt ? "enter" : followUpKey)}
				/>
			</row>
		</col>
	);
}
