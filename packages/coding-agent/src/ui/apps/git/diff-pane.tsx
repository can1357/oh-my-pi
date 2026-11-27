/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The git app's diff pane as a node: natively a `diff` of the selected file
 * (its hunks as unified text, the view mode, wrapping); the terminal draws
 * the pane from its {@link DiffPaneModel} (`omp.app.git.diff` look).
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import "../../styles/apps/git/diff-pane";
import type { DiffDocument } from "../../../cli/git-tui/model/diff-pane";
import type { DiffPaneModel } from "./diff-pane-model";

/**
 * `doc` as unified diff text for the `diff` kind: its hunks (the terminal folds
 * the unchanged lines between them), or with `whole` one hunk spanning the
 * file. Paired changes go out as their `-` block then their `+` block, so the
 * terminal pairs them for word emphasis.
 */
export function unifiedText(doc: DiffDocument, whole = false): string {
	const out: string[] = [];
	const emit = (rows: DiffDocument["rows"]): void => {
		let dels: string[] = [];
		let adds: string[] = [];
		const flush = (): void => {
			out.push(...dels, ...adds);
			dels = [];
			adds = [];
		};
		for (const row of rows) {
			if (row.kind === "context") {
				flush();
				out.push(` ${row.newText}`);
				continue;
			}
			if (row.oldNum !== undefined) dels.push(`-${row.oldText}`);
			if (row.newNum !== undefined) adds.push(`+${row.newText}`);
		}
		flush();
	};
	if (whole) {
		const oldCount = doc.rows.filter(row => row.oldNum !== undefined).length;
		const newCount = doc.rows.filter(row => row.newNum !== undefined).length;
		out.push(`@@ -1,${oldCount} +1,${newCount} @@`);
		emit(doc.rows);
	} else {
		for (const hunk of doc.hunks) {
			out.push(hunk.header);
			emit(hunk.rows);
		}
	}
	return out.join("\n");
}

/** The diff pane (see the module docs). */
export function GitDiffPane(props: { readonly model: DiffPaneModel; readonly nodeKey?: string }): JSXNode {
	const pane = props.model;
	return (
		<diff
			key={props.nodeKey ?? "diff"}
			role="omp.app.git.diff"
			path={() => pane.doc?.filePath}
			mode={() => (pane.mode === "split" ? "split" : "unified")}
			wrap={() => pane.wrap}
			scroll={() => pane.nativeScroll}
			text={() => (pane.doc ? unifiedText(pane.doc, pane.mode === "file") : "")}
			term={{ pane }}
		/>
	);
}
