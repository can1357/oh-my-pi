import { buildPathTree, type PathTreeInput, walkPathTree } from "@oh-my-pi/pi-utils";
import { formatHashlineHeader } from "./hashline-format";

// =============================================================================
// Grouped file output (grep / ast-grep / ast-edit / lsp diagnostics)
// =============================================================================

/**
 * One file's contribution to a grouped file output. The header itself is generated
 * by `formatGroupedFiles` (one `#` per nesting level); use `headerSuffix` to tack
 * on extras like ` (1 replacement)`.
 */
export interface GroupedFileSection {
	/** Optional suffix appended to the file header. */
	headerSuffix?: string;
	/** Body lines emitted into the textual model output. */
	modelLines: string[];
	/** Body lines emitted into the display output. Defaults to `modelLines`. */
	displayLines?: string[];
	/** When true, the file (and its header) is omitted entirely. */
	skip?: boolean;
}

/** Parallel model-facing and display-facing lines for grouped files. */
export interface GroupedFilesOutput {
	model: string[];
	display: string[];
	/** Per file, the `model` index just past its last line: a head cut keeping `n` lines shows it whole when this is <= n. */
	modelEnds: Map<string, number>;
}

/**
 * Render a list of files as a multi-level, prefix-folded directory tree shared by
 * grep, ast-grep, ast-edit, and the LSP diagnostic formatter.
 *
 * Layout (one `#` per level; the shared prefix folds into the top header):
 *   # packages/pkg/src/
 *   ## root.ts
 *   …body…
 *   ## nested/
 *   ### child.ts
 *   …body…
 *
 * Files in the (folded) project root become single-`#` headers with no parent
 * directory line. A blank line precedes every directory header and every
 * root-level file so the renderers can split the output into collapsible groups.
 */
export function formatGroupedFiles(
	files: string[],
	renderFile: (filePath: string) => GroupedFileSection,
): GroupedFilesOutput {
	const sections = new Map<string, GroupedFileSection>();
	const inputs: PathTreeInput[] = [];
	for (const filePath of files) {
		if (sections.has(filePath)) continue;
		const section = renderFile(filePath);
		if (section.skip) continue;
		sections.set(filePath, section);
		inputs.push({ path: filePath, isDir: false, key: filePath });
	}

	const tree = buildPathTree(inputs);
	const model: string[] = [];
	const display: string[] = [];
	const modelEnds = new Map<string, number>();
	let emitted = false;

	for (const event of walkPathTree(tree)) {
		const hashes = "#".repeat(event.depth + 1);
		const needsSeparator = emitted && (event.depth === 0 || event.kind === "dir");
		if (needsSeparator) {
			model.push("");
			display.push("");
		}
		emitted = true;
		if (event.kind === "dir") {
			const header = `${hashes} ${event.name}/`;
			model.push(header);
			display.push(header);
			continue;
		}
		const section = sections.get(event.key)!;
		const header = `${hashes} ${event.name}${section.headerSuffix ?? ""}`;
		model.push(header, ...section.modelLines);
		display.push(header, ...(section.displayLines ?? section.modelLines));
		modelEnds.set(event.key, model.length);
	}

	return { model, display, modelEnds };
}

/** One file's rendered search matches, plus its hashline tag when editable. */
export interface FileMatchSection {
	model: string[];
	display: string[];
	tag?: string;
}

/**
 * Render per-file search matches (grep / ast-grep). Grouped mode nests files
 * via {@link formatGroupedFiles}, appending `#tag` to headers; flat mode
 * blank-separates files and prefixes each with a hashline header when tagged.
 * Files with no model lines are omitted.
 */
export function formatFileMatches(
	files: string[],
	grouped: boolean,
	renderFile: (filePath: string) => FileMatchSection,
): GroupedFilesOutput {
	if (grouped) {
		return formatGroupedFiles(files, filePath => {
			const rendered = renderFile(filePath);
			return {
				modelLines: rendered.model,
				displayLines: rendered.display,
				headerSuffix: rendered.tag ? `#${rendered.tag}` : "",
				skip: rendered.model.length === 0,
			};
		});
	}
	const model: string[] = [];
	const display: string[] = [];
	const modelEnds = new Map<string, number>();
	for (const filePath of files) {
		const rendered = renderFile(filePath);
		if (rendered.model.length === 0) continue;
		if (model.length > 0) {
			model.push("");
			display.push("");
		}
		if (rendered.tag) model.push(formatHashlineHeader(filePath, rendered.tag));
		model.push(...rendered.model);
		display.push(...rendered.display);
		modelEnds.set(filePath, model.length);
	}
	return { model, display, modelEnds };
}
