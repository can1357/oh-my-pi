/**
 * The composer's text field: a plain-text contenteditable whose only rich nodes are shortcut chips. A chip shows
 * `/name` and stands for the shortcut's whole prompt, which is substituted when the message is sent.
 */
import {
	type ClipboardEvent,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";

/** What the user typed, read out of the editor. */
export interface EditorContent {
	/** As shown: chips read `/name`. */
	display: string;
	/** As sent: chips replaced by `expand(id)`, or left as `/name` when the shortcut is gone. */
	expanded: string;
	/** Ids of the shortcut chips, in order. */
	shortcutIds: string[];
}

/** The composer's handle on its editor. */
export interface EditorHandle {
	focus(): void;
	read(expand: (shortcutId: string) => string | undefined): EditorContent;
	/** Replace everything with `text` and put the caret at its end. */
	setText(text: string): void;
	/** Put `text` before what is there, a blank line apart, keeping chips; the caret goes to the end. */
	prepend(text: string): void;
	clear(): void;
	/** Replace the `/query` being typed with a shortcut chip, or just remove it (commands and actions). */
	resolveSlash(chip: { id: string; name: string } | null): void;
}

/** The `/word` at the caret. */
interface SlashToken {
	node: Text;
	start: number;
	end: number;
}

const PLACEHOLDERS = ["Ask about this page…", "Type / for commands"];
const SLASH = /(?:^|\s)\/([a-z0-9_-]*)$/i;

function chipId(node: Node): string | null {
	return node instanceof HTMLElement ? (node.dataset.shortcutId ?? null) : null;
}

function serialize(
	root: Node,
	expand: (id: string) => string | undefined,
	out: { display: string; expanded: string; ids: string[] },
): void {
	for (const node of root.childNodes) {
		const id = chipId(node);
		if (id !== null) {
			const shown = node.textContent ?? "";
			out.display += shown;
			out.expanded += expand(id) ?? shown;
			out.ids.push(id);
		} else if (node instanceof Text) {
			out.display += node.data;
			out.expanded += node.data;
		} else if (node instanceof HTMLBRElement) {
			out.display += "\n";
			out.expanded += "\n";
		} else {
			serialize(node, expand, out);
		}
	}
}

/** What the editor needs from the composer. */
export interface EditorProps {
	handle: Ref<EditorHandle>;
	disabled: boolean;
	/** Fixed placeholder; the two default hints rotate when absent. */
	placeholder?: string;
	/** Empty ↔ non-empty transitions, for the Send button. */
	onEmptyChange(empty: boolean): void;
	/** The `/query` at the caret, or null when the caret is not in one. */
	onSlash(query: string | null): void;
	/** First look at every key; true means consumed (the slash menu). */
	onKey(event: KeyboardEvent<HTMLDivElement>): boolean;
	/** Enter; `followUp` with Ctrl (omp's Ctrl+Enter: wait for the running turn instead of steering it). */
	onSubmit(options: { followUp: boolean }): void;
	/** ↑ pressed in an empty editor. */
	onRecall(): void;
	onPasteFiles(files: File[]): void;
}

/** The contenteditable itself plus its rotating placeholder. */
export function Editor(props: EditorProps): ReactNode {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const slashRef = useRef<SlashToken | null>(null);
	const composing = useRef(false);
	const [empty, setEmpty] = useState(true);
	const [hint, setHint] = useState(0);
	const latest = useRef(props);
	latest.current = props;

	const isEmpty = (): boolean => {
		const root = rootRef.current;
		if (root === null) return true;
		return root.querySelector("[data-shortcut-id]") === null && (root.textContent ?? "").trim() === "";
	};

	const sync = (): void => {
		const root = rootRef.current;
		if (root === null) return;
		const nowEmpty = isEmpty();
		// Chrome leaves a lone <br> or newline behind after the last character is deleted; clear it so the
		// placeholder lines up and the next `/` is at the start of the text.
		if (nowEmpty && root.childNodes.length > 0 && document.activeElement !== root) root.replaceChildren();
		setEmpty(previous => {
			if (previous !== nowEmpty) latest.current.onEmptyChange(nowEmpty);
			return nowEmpty;
		});
		const selection = document.getSelection();
		let token: SlashToken | null = null;
		let query: string | null = null;
		if (selection !== null && selection.isCollapsed && selection.anchorNode instanceof Text) {
			const node = selection.anchorNode;
			if (root.contains(node)) {
				const match = SLASH.exec(node.data.slice(0, selection.anchorOffset));
				if (match !== null) {
					query = match[1];
					token = { node, start: selection.anchorOffset - query.length - 1, end: selection.anchorOffset };
				}
			}
		}
		slashRef.current = token;
		latest.current.onSlash(query);
	};

	const caretToEnd = (): void => {
		const root = rootRef.current;
		const selection = document.getSelection();
		if (root === null || selection === null) return;
		const range = document.createRange();
		range.selectNodeContents(root);
		range.collapse(false);
		selection.removeAllRanges();
		selection.addRange(range);
	};

	useImperativeHandle(props.handle, () => ({
		focus() {
			rootRef.current?.focus();
		},
		read(expand) {
			const out = { display: "", expanded: "", ids: [] as string[] };
			if (rootRef.current !== null) serialize(rootRef.current, expand, out);
			return { display: out.display.trim(), expanded: out.expanded.trim(), shortcutIds: out.ids };
		},
		setText(text) {
			const root = rootRef.current;
			if (root === null) return;
			root.textContent = text;
			root.focus();
			caretToEnd();
			sync();
		},
		prepend(text) {
			const root = rootRef.current;
			if (root === null) return;
			if (isEmpty()) root.replaceChildren(text);
			else root.prepend(`${text}\n\n`);
			root.focus();
			caretToEnd();
			sync();
		},
		clear() {
			rootRef.current?.replaceChildren();
			sync();
		},
		resolveSlash(chip) {
			const token = slashRef.current;
			const root = rootRef.current;
			if (token === null || root === null || !root.contains(token.node)) return;
			const range = document.createRange();
			range.setStart(token.node, token.start);
			range.setEnd(token.node, Math.min(token.end, token.node.length));
			range.deleteContents();
			if (chip !== null) {
				const node = document.createElement("span");
				node.className = "pn-shortcut-chip";
				node.contentEditable = "false";
				node.dataset.shortcutId = chip.id;
				node.textContent = `/${chip.name}`;
				// A space after the chip gives the caret a text position to land on.
				const space = document.createTextNode(" ");
				range.insertNode(space);
				range.insertNode(node);
				range.setStartAfter(space);
			}
			range.collapse(true);
			const selection = document.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			root.focus();
			sync();
		},
	}));

	// The two hints trade places every three seconds while the field is empty.
	useEffect(() => {
		if (!empty || props.placeholder !== undefined) return;
		const timer = window.setInterval(() => setHint(index => (index + 1) % PLACEHOLDERS.length), 3000);
		return () => window.clearInterval(timer);
	}, [empty, props.placeholder]);

	// The caret moves without input events (arrows, clicks); the slash token follows it.
	useEffect(() => {
		const onSelection = (): void => {
			if (document.activeElement === rootRef.current) sync();
		};
		document.addEventListener("selectionchange", onSelection);
		return () => document.removeEventListener("selectionchange", onSelection);
	}, []);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		// An IME composition owns its keys; WebKit even sends the confirming Enter after `compositionend`, which
		// the deferred reset below covers (same guard as collab-web's `shouldSubmitOnEnter`).
		if (event.nativeEvent.isComposing || composing.current) return;
		if (props.onKey(event)) {
			event.preventDefault();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			props.onSubmit({ followUp: event.ctrlKey });
		} else if (event.key === "ArrowUp" && isEmpty()) {
			event.preventDefault();
			props.onRecall();
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
		const files = [...event.clipboardData.files];
		if (files.length === 0) return;
		event.preventDefault();
		props.onPasteFiles(files);
	};

	const placeholder = props.placeholder ?? PLACEHOLDERS[hint];
	return (
		<div className="pn-editor-wrap">
			<div
				ref={rootRef}
				className="pn-editor"
				role="textbox"
				aria-multiline="true"
				aria-label="Message omp"
				aria-disabled={props.disabled}
				contentEditable={props.disabled ? false : "plaintext-only"}
				suppressContentEditableWarning
				spellCheck={false}
				onInput={sync}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				onBlur={sync}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					window.setTimeout(() => {
						composing.current = false;
					}, 0);
				}}
			/>
			{empty && (
				<div key={placeholder} className="pn-editor-placeholder" aria-hidden="true">
					{placeholder}
				</div>
			)}
		</div>
	);
}
