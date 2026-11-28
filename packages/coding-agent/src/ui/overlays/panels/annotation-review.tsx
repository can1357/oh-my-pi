/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The annotation review sheet: for a diff, the file rail (totals over the
 * changed files) beside the current file's head and its lines (text: its
 * numbered lines), notes as disabled items under their line (file and
 * whole-text notes leading); the note composer or the note chooser docked
 * under the lines; a footer of key hints, Cancel and the actions.
 *
 * The terminal draws it as one box (role look `omp.annotationReview`)
 * driven by keys: see {@link AnnotationReviewModel}.
 */
import { computed, type JSXNode, type KeyEvent, type UiNode, untrack } from "@oh-my-pi/pi-tui";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { ReviewDiffFile } from "../../../extensibility/custom-commands/bundled/annotate/annotation-types";
import { findNode } from "../../styles/panels/common";
import "../../styles/panels/annotation-review";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { statusText } from "./annotation-review-frame";
import {
	type AnnotationReviewModel,
	CONTINUE_CODE_REVIEW_ACTION,
	DISCARD_ANNOTATIONS_ACTION,
	fileLabel,
	isSourceRow,
	PASTE_CODE_REVIEW_ACTION,
} from "./annotation-review-model";
import { ActionButton, feedField, type KeycapHint, KeycapHints } from "./common";
import type { SheetAttributes } from "../sheet";

type FileStatus = "added" | "deleted" | "renamed" | "modified";
const STATUS_ICON: Record<FileStatus, string> = {
	added: "file-plus",
	deleted: "trash",
	renamed: "forward",
	modified: "file",
};
const STATUS_TONE: Record<FileStatus, TspTone | undefined> = {
	added: "success",
	deleted: "error",
	renamed: "info",
	modified: undefined,
};

/** How a file changed, from its diff header. */
function fileStatus(file: ReviewDiffFile): FileStatus {
	const hunk = file.rawDiff.indexOf("\n@@");
	const head = file.rawDiff.slice(0, hunk < 0 ? 4096 : hunk);
	if (/^new file mode/m.test(head)) return "added";
	if (/^deleted file mode/m.test(head)) return "deleted";
	return file.oldPath !== undefined && file.newPath !== undefined && file.oldPath !== file.newPath
		? "renamed"
		: "modified";
}

/** `3 files`, `1 note`. */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function changeSpans(added: number, removed: number): TspSpan[] {
	return [{ s: "toolDiffAdded mono", t: `+${added}` }, { t: " " }, { s: "toolDiffRemoved mono", t: `−${removed}` }];
}

const UP_DOWN = [["up"], ["down"]];
const keysOf = (id: string): string[] => id.split("+");

/** One footer button: its label (and keycap), marked `pick` or `drop` for the keyboard's choice. */
function FooterButton(props: {
	readonly act: string;
	readonly label: () => string;
	readonly title: () => string;
	readonly tone?: TspTone;
	readonly keys?: readonly string[];
	readonly mark?: () => "pick" | "drop" | undefined;
}): JSXNode {
	return (
		<ActionButton
			id={props.act}
			label={props.label}
			title={props.title}
			tone={props.tone}
			mark={props.mark}
			keys={props.keys}
		/>
	);
}

/** Tern's sheet: full-pane glass titled `Code review` (or `Annotate text`), then what is under review, quieter. */
export function annotationReviewSheet(model: AnnotationReviewModel): SheetAttributes {
	const source = model.textSource;
	const subtitle: TspSpan[] = source
		? [{ s: "muted", t: statusText(source.label) }]
		: statusText(model.mode)
				.split("`")
				.flatMap((part, index) => (part ? [{ s: index % 2 === 1 ? "code" : "muted", t: part }] : []));
	return {
		role: source ? "omp.overlay.annotateText" : "omp.overlay.codeReview",
		anchor: "center",
		size: "full",
		head: [{ t: source ? "Annotate text" : "Code review" }, ...subtitle],
	};
}

export function AnnotationReview(props: { readonly model: AnnotationReviewModel }): JSXNode {
	const model = props.model;
	const rev = model.rev;
	const editing = () => model.annotating || model.chooser !== undefined;

	const lines = () => (
		<list
			key="lines"
			actions={{ click: "select", dblclick: "activate" }}
			empty={[{ s: "muted", t: model.textSource ? "This text is empty" : "Nothing to review" }]}
			max={() => ({ lines: model.nativeBodyRows() })}
			role={model.textSource ? "omp.review.text" : "omp.review.diff"}
			selected={() => {
				rev();
				const count = model.textSource ? model.textLines.length : model.currentSourceRows().length;
				return count > 0 ? `l${model.sourceIndex}` : null;
			}}
			tone={() => (rev(), model.focus === "diff" && !editing() ? "accent" : undefined)}
		>
			{() => {
				rev();
				return lineItems();
			}}
		</list>
	);

	const monoSpans = (spans: readonly TspSpan[]): TspSpan[] =>
		spans.map(span => ({ ...span, s: span.s ? `${span.s} mono` : "mono" }));

	const note = (key: string, body: string, scope?: string) => (
		<item
			key={key}
			label={[{ t: statusText(body) }]}
			value={scope ? [{ s: "muted", t: scope }] : undefined}
			icon="pen"
			disabled
			tone="warning"
			role="omp.review.note"
		/>
	);

	const lineItems = (): JSXNode[] => {
		const items: JSXNode[] = [];
		if (model.textSource) {
			model.textNotes.forEach((entry, index) => {
				if (entry.annotation.scope === "text") items.push(note(`n${index}`, entry.annotation.note, "Whole text"));
			});
			const mono = model.textSource.kind !== "message" && model.textSource.kind !== "prompt";
			const width = String(model.textLines.length).length;
			const syntax = model.sourceSyntax();
			model.textLines.forEach((line, sourceIndex) => {
				const highlighted = syntax?.[sourceIndex];
				const label =
					highlighted === undefined
						? [{ t: replaceTabs(sanitizeText(line)), ...(mono ? { s: "mono" } : {}) }]
						: monoSpans(highlighted);
				items.push(
					<item
						key={`l${sourceIndex}`}
						label={label}
						value={[{ s: "mono", t: String(sourceIndex + 1).padStart(width) }]}
					/>,
				);
				model.textNotes.forEach((entry, index) => {
					if (entry.annotation.scope === "line" && entry.sourceIndex === sourceIndex)
						items.push(note(`n${index}`, entry.annotation.note));
				});
			});
			return items;
		}
		const file = model.currentFile();
		if (!file) return items;
		model.notes.forEach((entry, index) => {
			if (entry.fileIndex === model.fileIndex && entry.annotation.scope === "file")
				items.push(note(`n${index}`, entry.annotation.note, "File note"));
		});
		const notice = (key: string, label: string, icon: string) => (
			<item key={key} label={[{ s: "muted", t: label }]} icon={icon} disabled tone="muted" />
		);
		if (file.isBinary)
			items.push(notice("binary", "Binary file: no lines to annotate, but a file note works", "binary"));
		else if (file.rows.length === 0)
			items.push(notice("empty", "No hunks: this looks like a rename-only change", "forward"));
		const rows = file.isBinary ? [] : file.rows;
		const syntax = model.sourceSyntax();
		let numberWidth = 1;
		for (const row of rows) {
			if (isSourceRow(row))
				numberWidth = Math.max(numberWidth, String(row.oldLine ?? "").length, String(row.newLine ?? "").length);
		}
		const blank = [{ s: "mono", t: " ".repeat(numberWidth * 2 + 1) }];
		let sourceIndex = 0;
		rows.forEach((row, rowIndex) => {
			if (!isSourceRow(row)) {
				if (row.kind === "hunk") {
					const match = /^(@@[^@]*@@)\s?(.*)$/.exec(sanitizeText(row.raw));
					const label: TspSpan[] = match
						? [
								{ s: "mono", t: match[1]! },
								{ s: "muted mono", t: match[2] ? `  ${replaceTabs(match[2])}` : "" },
							]
						: [{ s: "mono", t: sanitizeText(row.raw) }];
					items.push(<item key={`r${rowIndex}`} label={label} value={blank} disabled tone="info" />);
				} else {
					items.push(
						<item
							key={`r${rowIndex}`}
							label={[{ s: "muted", t: "No newline at end of file" }]}
							value={blank}
							disabled
							tone="muted"
						/>,
					);
				}
				return;
			}
			const added = row.kind === "added";
			const removed = row.kind === "removed";
			const color = added ? "toolDiffAdded" : removed ? "toolDiffRemoved" : "toolDiffContext";
			const oldCell = String((added ? undefined : row.oldLine) ?? "").padStart(numberWidth);
			const newCell = String((removed ? undefined : row.newLine) ?? "").padStart(numberWidth);
			const current = sourceIndex;
			const highlighted = syntax?.[sourceIndex];
			const content =
				highlighted === undefined
					? [{ s: "mono", t: replaceTabs(sanitizeText(row.content)) }]
					: monoSpans(highlighted);
			items.push(
				<item
					key={`l${current}`}
					label={[{ s: `${color} mono`, t: added ? "+ " : removed ? "- " : "  " }, ...content]}
					value={[{ s: "mono", t: `${oldCell} ${newCell}` }]}
					tone={added ? "success" : removed ? "error" : undefined}
				/>,
			);
			model.notes.forEach((entry, index) => {
				if (
					entry.fileIndex === model.fileIndex &&
					entry.sourceIndex === current &&
					entry.annotation.scope === "line"
				)
					items.push(note(`n${index}`, entry.annotation.note));
			});
			sourceIndex++;
		});
		return items;
	};

	const head = () => (
		<row key="head" role="omp.review.head" gap="sm" align="center">
			{() => {
				rev();
				if (model.textSource) {
					const count = model.textNotes.length;
					return [
						<text grow={1} wrap="none" spans={[{ t: plural(model.textLines.length, "line") }]} />,
						count > 0 && <text role="omp.review.count" wrap="none" spans={[{ t: plural(count, "note") }]} />,
					];
				}
				const file = model.currentFile();
				if (!file) return <text spans={[{ s: "muted", t: "No reviewable files" }]} />;
				const status = fileStatus(file);
				const what =
					status === "renamed" && file.oldPath
						? `Renamed from ${statusText(file.oldPath)}`
						: status === "added"
							? "New file"
							: status === "deleted"
								? "Deleted"
								: file.isBinary
									? "Binary"
									: undefined;
				const count = model.noteCount(model.fileIndex);
				return [
					<text truncate="middle" min={{ w: 0 }} spans={[{ s: "path", t: statusText(fileLabel(file)) }]} />,
					what && (
						<text
							role="omp.review.status"
							tone={STATUS_TONE[status]}
							truncate="end"
							min={{ w: 0 }}
							spans={[{ t: what }]}
						/>
					),
					<spacer grow={1} />,
					count > 0 && <text role="omp.review.count" wrap="none" spans={[{ t: plural(count, "note") }]} />,
					!file.isBinary && <text wrap="none" spans={changeSpans(file.linesAdded, file.linesRemoved)} />,
				];
			}}
		</row>
	);

	const rail = () => (
		<col key="rail" role="omp.review.rail">
			<row key="total" role="omp.review.total" gap="sm" align="center">
				{() => {
					rev();
					let added = 0;
					let removed = 0;
					for (const file of model.files) {
						added += file.linesAdded;
						removed += file.linesRemoved;
					}
					return [
						<text grow={1} wrap="none" spans={[{ t: plural(model.files.length, "file") }]} />,
						model.notes.length > 0 && (
							<text role="omp.review.count" wrap="none" spans={[{ t: plural(model.notes.length, "note") }]} />
						),
						<text wrap="none" spans={changeSpans(added, removed)} />,
					];
				}}
			</row>
			<list
				key="files"
				actions={{ click: "select", dblclick: "activate" }}
				empty={[{ s: "muted", t: "No files" }]}
				max={() => ({ lines: model.nativeBodyRows() })}
				role="omp.review.files"
				selected={() => (rev(), model.files.length > 0 ? `f${model.fileIndex}` : null)}
				tone={() => (rev(), model.focus === "files" && !editing() ? "accent" : undefined)}
			>
				{() => {
					rev();
					return model.files.map((file, index) => {
						const label = fileLabel(file);
						const slash = label.lastIndexOf("/");
						const dir = slash < 0 ? "" : label.slice(0, slash);
						const status = fileStatus(file);
						const count = model.noteCount(index);
						const value: TspSpan[] = [];
						if (count) value.push({ s: "warning", t: `✎ ${count}` }, { t: " " });
						if (file.isBinary) value.push({ s: "muted", t: "bin" });
						else value.push(...changeSpans(file.linesAdded, file.linesRemoved));
						return (
							<item
								key={`f${index}`}
								label={[{ t: statusText(label.slice(slash + 1)) }]}
								detail={dir ? [{ t: statusText(dir) }] : undefined}
								value={value}
								icon={file.isBinary ? "binary" : STATUS_ICON[status]}
								tone={STATUS_TONE[status]}
							/>
						);
					});
				}}
			</list>
		</col>
	);

	const composerMode = computed(() => {
		rev();
		return model.chooser ? "chooser" : model.annotating ? "note" : "";
	});

	const composer = () => {
		switch (composerMode()) {
			case "chooser":
				return (
					<col key="chooser" role="omp.review.composer">
						<text key="caption" spans={[{ s: "strong", t: "Edit which note?" }]} />
						<list
							key="chooser"
							actions={{ click: "select", dblclick: "activate" }}
							selected={() => (rev(), `c${model.chooser?.selected ?? 0}`)}
							tone="accent"
						>
							{() => {
								rev();
								const chooser = model.chooser;
								if (!chooser) return [];
								return chooser.entries.map((index, i) => {
									const annotation =
										chooser.kind === "text"
											? model.textNotes[index]?.annotation
											: model.notes[index]?.annotation;
									const location = !annotation
										? ""
										: annotation.scope === "file"
											? "File note"
											: annotation.scope === "text"
												? "Whole text"
												: "line" in annotation
													? `Line ${annotation.line}`
													: annotation.newLine !== undefined
														? `Line ${annotation.newLine}`
														: `Removed line ${annotation.oldLine ?? ""}`.trim();
									return (
										<item
											key={`c${i}`}
											label={statusText(annotation?.note.split(/\r?\n/, 1)[0] ?? "")}
											value={location}
											icon="pen"
										/>
									);
								});
							}}
						</list>
					</col>
				);
			case "note":
				return (
					<col key="composer" role="omp.review.composer">
						<text key="caption" truncate="end" spans={() => (rev(), captionSpans())} />
						<col role="omp.field">
							<editor
								key="input"
								text={() => (rev(), model.draft.text)}
								cursor={() => (rev(), model.draft.cursor)}
								maxLines={() => Math.max(1, Math.min(6, model.terminal.size().rows - 12))}
								sendable={false}
								placeholder="Write a note…"
							/>
						</col>
					</col>
				);
			default:
				return undefined;
		}
	};

	/** `Note on line 42 in src/app.ts`, `Edit note on src/app.ts`, `Note on the whole text`. */
	const captionSpans = (): TspSpan[] => {
		const verb: TspSpan = { s: "muted", t: model.editingIndex === undefined ? "Note on " : "Edit note on " };
		if (model.textSource)
			return [verb, { s: "strong", t: model.scope === "text" ? "the whole text" : `line ${model.sourceIndex + 1}` }];
		const file = model.currentFile();
		const path = file ? statusText(fileLabel(file)) : "file";
		if (model.scope === "file") return [verb, { s: "path", t: path }];
		const source = model.currentSourceRows()[model.sourceIndex];
		const where =
			source?.kind === "removed"
				? `removed line ${source.oldLine ?? ""}`
				: `line ${source?.newLine ?? source?.oldLine ?? ""}`;
		return [verb, { s: "strong", t: where.trim() }, { s: "muted", t: " in " }, { s: "path", t: path }];
	};

	const hints = (): KeycapHint[] => {
		rev();
		const out: KeycapHint[] = [];
		if (model.chooser) {
			out.push(
				{ keys: UP_DOWN, label: "choose" },
				{ keys: [["enter"]], label: "edit" },
				{ keys: [keysOf(model.cancelKey)], label: "back" },
			);
		} else if (model.annotating) {
			out.push(
				{ keys: [["enter"]], label: "save" },
				{ keys: [["shift", "enter"]], label: "new line" },
				{ keys: [keysOf(model.cancelKey)], label: "close, keep note" },
			);
			if (model.callbacks.onAnnotationExternalEditor)
				out.push({ keys: [keysOf(model.externalEditorKey)], label: "editor" });
		} else {
			const undo = model.undoStack.length > 0 ? [{ keys: [["u"]], label: "undo" }] : [];
			if (model.focus === "files") {
				out.push(
					{ keys: UP_DOWN, label: "file" },
					{ keys: [["enter"]], label: "open" },
					{ keys: [["a"]], label: "file note" },
					...undo,
					{ keys: [["tab"]], label: "pane" },
				);
			} else if (model.focus === "diff") {
				out.push(
					{ keys: UP_DOWN, label: "line" },
					{ keys: [["a"]], label: "note" },
					{ keys: [["shift", "a"]], label: model.textSource ? "note on all" : "file note" },
				);
				if (model.noteCandidates().length > 0) out.push({ keys: [["e"]], label: "edit note" });
				out.push(...undo, { keys: [["tab"]], label: model.textSource ? "actions" : "pane" });
			} else {
				out.push(
					{ keys: UP_DOWN, label: "choose" },
					{ keys: [["enter"]], label: "run" },
					{
						keys: [["tab"]],
						label: "pane",
					},
				);
			}
		}
		return out;
	};

	const mark = (index: number) => () => {
		rev();
		if (editing() || model.actionDisabled(index)) return "drop" as const;
		return model.focus === "actions" && model.actionIndex === index ? ("pick" as const) : undefined;
	};
	const pasteTitle = () => (
		rev(),
		model.hasNotes() ? PASTE_CODE_REVIEW_ACTION : "Add a note to paste it into the prompt"
	);

	const footer = () => (
		<row key="actions" role="omp.actions" gap="sm" align="center">
			<KeycapHints nodeKey="hints" hints={hints} />
			<FooterButton act="close" label={() => "Cancel"} title={() => "Cancel  esc"} keys={["escape"]} />
			<FooterButton
				act="discard"
				label={() => (rev(), model.discardArmed ? "Confirm discard" : "Discard")}
				title={() => DISCARD_ANNOTATIONS_ACTION}
				mark={mark(model.actions.indexOf(DISCARD_ANNOTATIONS_ACTION))}
			/>
			{model.textSource ? (
				<FooterButton
					act="paste"
					label={() => "Paste into prompt"}
					title={pasteTitle}
					tone="accent"
					mark={mark(0)}
				/>
			) : (
				[
					<FooterButton act="paste" label={() => "Paste into prompt"} title={pasteTitle} mark={mark(1)} />,
					<FooterButton
						act="review"
						label={() => "Review with LLM"}
						title={() => CONTINUE_CODE_REVIEW_ACTION}
						tone="accent"
						mark={mark(0)}
					/>,
				]
			)}
		</row>
	);

	const pane = () => (
		<col key="pane" role="omp.review.pane" grow={1} min={{ w: 0 }}>
			{head()}
			{lines()}
			{() => composer()}
		</col>
	);

	const editorNode = (): UiNode | undefined =>
		untrack(() => model.annotating) ? findNode(root, node => node.kind === "editor") : undefined;
	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return true;
		if (model.key(key.id, key.text, key.raw)) return true;
		const field = editorNode();
		if (field) feedField(field, { key }, edit => model.editDraft(edit));
		return true;
	};

	const root = (
		<col
			term={() => ({ role: "omp.annotationReview", review: model, rev: rev() })}
			onKey={onKey}
			onPaste={paste => {
				const field = editorNode();
				if (field) feedField(field, { paste }, edit => model.editDraft(edit));
				return true;
			}}
			onEvent={event => {
				const leaf = event.key.slice(event.key.lastIndexOf("/") + 1);
				if (event.type === "action") model.action(event.act);
				else if (event.type === "select" || event.type === "activate")
					model.pick(leaf, event.item, event.type === "activate");
				else if (event.type === "edit") model.editDraft(event);
			}}
		>
			{model.textSource ? (
				pane()
			) : (
				<row key="split" role="omp.review.split">
					{rail()}
					{pane()}
				</row>
			)}
			{footer()}
		</col>
	) as UiNode;
	return root;
}
