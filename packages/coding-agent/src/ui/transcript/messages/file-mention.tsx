/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Files a prompt's `@path` mentions auto-read (a `fileMention` message): one
 * `└─ Read dir/name (N lines)` row per file — `image`, `unknown lines`, or
 * why it was skipped (`skipped: 5MB`, `skipped: binary, 2KB`) in the
 * parentheses; natively a `read` notice row each.
 *
 * Terminal look: `omp.status-block` (`src/ui/styles/messages/notice.ts`).
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatBytes, formatCount } from "@oh-my-pi/pi-utils";
import type { FileMentionMessage } from "../../../session/transcript/messages";
import { styledPath } from "../../styles/tools/file-common";
import { statusFacts } from "./async-cards";
import { StatusBlock, type StatusRow } from "./notices";

/** A mentioned file. */
export type MentionedFile = FileMentionMessage["files"][number];

/** What the row says about a file after its path. */
function mentionDetail(file: MentionedFile): string {
	if (file.skippedReason === "tooLarge" || file.skippedReason === "binary") {
		const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
		return file.skippedReason === "binary" ? `skipped: binary, ${size}` : `skipped: ${size}`;
	}
	if (file.image) return "image";
	return file.lineCount === undefined ? "unknown lines" : formatCount("line", file.lineCount);
}

/** Rows of a `fileMention` message; `indent` pads them. */
export function fileMentionRows(files: readonly MentionedFile[], indent: number): StatusRow[] {
	const theme = currentTheme();
	return files.map(file => {
		const detail = mentionDetail(file);
		return {
			parts: [
				{ text: theme.symbols.symbol("tree.last"), color: "dim" },
				{ text: "Read", color: "muted" },
				{ text: styledPath(theme, file.path) },
				{ text: `(${detail})`, color: "dim" },
			],
			indent,
			native: {
				tone: "info",
				icon: "read",
				message: [{ t: "Read" }, { t: " " }, { t: file.path, s: "path" }, ...statusFacts([detail])],
			},
		};
	});
}

/**
 * Auto-read file mentions. `indent` sets the pad: the live transcript draws
 * them inside its own gutter (0), a body without one pads its rows (1).
 */
export function FileMentions(props: { files: readonly MentionedFile[]; indent?: number }): JSXNode {
	return <StatusBlock rows={fileMentionRows(props.files, props.indent ?? 0)} />;
}
