/**
 * The three request shapes the cascade sends to the judge, as `state` plus
 * one noul question per entry. Nouls give absolute probabilities, so entries
 * are thresholded independently and batches are comparable with each other.
 *
 * State objects are built with alphabetically ordered keys so the wire bytes
 * match the reference implementation (which serializes through sorted maps);
 * judgment quality was benchmarked against that exact layout.
 */
import type { JsonValue, NoulQuestion } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import nameQuestionTemplate from "../../prompts/tools/find-name-question.md" with { type: "text" };
import passageQuestionTemplate from "../../prompts/tools/find-passage-question.md" with { type: "text" };
import sketchQuestionTemplate from "../../prompts/tools/find-sketch-question.md" with { type: "text" };
import { type Passage, plainContent } from "./passages";
import { type FileEntry, renderTree } from "./tree";

/** A judgment request: JSON state plus noul questions keyed by entry. */
export interface Request {
	state: { readonly [key: string]: JsonValue };
	questions: Record<string, NoulQuestion>;
}

const TASK =
	"Semantic grep over a source tree: locate files whose content matches the search description. Entries are judged by name, size, position in the tree, and (for folders) a sample of what they contain.";

const TREE_FORMAT =
	"`tree` is a directory listing. Lines starting with # are headers: `# dir/` is a folder; more #s means deeper nesting under the header above; a header may fold several levels (`# a/b/c/`). Every judgeable entry carries a tag like e017 right after the #s: files as `e017 name (size)`, folders as `e017 name/ — N entries: sample of names`. Untagged header lines are only structure.";

const FILE_CRITERIA = {
	// Generated implementation is still implementation. File provenance must
	// not itself be negative evidence for source-code searches.
	no: "The file is unrelated by name and location; generated executable implementation can still be relevant.",
	yes: "A file at this path plausibly contains code, text, or data matching the search.",
};

const FOLDER_CRITERIA = {
	no: "Nothing about the folder's name, location, or sampled contents suggests it holds a match.",
	yes: "The folder plausibly contains, at any depth, at least one file matching the search.",
};

const SKETCH_CRITERIA = {
	no: "Unrelated code; mere mentions, declarations, call sites, tests or configuration without implementation.",
	yes: "Likely substantive implementation, definition or explanation of any part of the requested behavior. A matching helper for one step counts. Excerpts omit most source: favor recall.",
};

const PASSAGE_CRITERIA = {
	no: "This passage only mentions, calls, imports, tests, or configures the subject, or contains unrelated code sharing keywords.",
	yes: "This passage contains an implementation, definition, or substantive explanation of an important part of the search. A helper implementing one requested step counts even when other steps are elsewhere.",
};

/** Question key of the `i`th entry in a filename batch. */
export function entryKey(i: number): string {
	return `e${String(i).padStart(3, "0")}`;
}

/** Question key of the `k`th passage in a sketch or verification batch. */
export function passageKey(k: number): string {
	return `p${String(k).padStart(2, "0")}`;
}

/** Copy of `record` with keys in lexicographic order. */
function sorted<T extends JsonValue>(record: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(record).sort()) out[key] = record[key]!;
	return out;
}

/** One noul per file over a shared tree-rendered listing of the batch. */
export function nameBatch(project: string, query: string, entries: readonly FileEntry[]): Request {
	const questions: Record<string, NoulQuestion> = {};
	entries.forEach((entry, i) => {
		const key = entryKey(i);
		const name = entry.rel.slice(entry.rel.lastIndexOf("/") + 1);
		questions[key] = {
			type: "noul",
			instructions: prompt.render(nameQuestionTemplate, { key, name, query }).trim(),
		};
	});
	return {
		state: {
			criteria: { file: FILE_CRITERIA, folder: FOLDER_CRITERIA },
			format: TREE_FORMAT,
			project,
			search: query,
			task: TASK,
			tree: renderTree(entries, entryKey),
		},
		questions,
	};
}

/** One sketch card: the file it came from and its budgeted verbatim lines. */
export interface SketchCard {
	fileKey: string;
	rel: string;
	sketch: string;
}

/**
 * Mixed-file packing of sketch cards: one state ingestion pays for many
 * independent small cards instead of rereading a whole file to discover its
 * useful spans.
 */
export function sketchBatch(query: string, cards: readonly SketchCard[]): Request {
	const files: Record<string, string> = {};
	const passages: Record<string, [string, string]> = {};
	const questions: Record<string, NoulQuestion> = {};
	cards.forEach((card, k) => {
		const key = passageKey(k);
		files[card.fileKey] = card.rel;
		passages[key] = [card.fileKey, card.sketch];
		questions[key] = { type: "noul", instructions: prompt.render(sketchQuestionTemplate, { key }).trim() };
	});
	return {
		state: { criteria: SKETCH_CRITERIA, files: sorted(files), passages, search: query },
		questions,
	};
}

/** Verification of complete passages from one file, judged independently. */
export function passageBatch(query: string, rel: string, passages: readonly Passage[]): Request {
	const entries: Record<string, string> = {};
	const questions: Record<string, NoulQuestion> = {};
	passages.forEach((passage, k) => {
		const key = passageKey(k);
		entries[key] = plainContent(passage);
		questions[key] = {
			type: "noul",
			instructions: prompt.render(passageQuestionTemplate, { key, query }).trim(),
		};
	});
	return {
		state: { criteria: PASSAGE_CRITERIA, file: rel, passages: entries, search: query },
		questions,
	};
}
