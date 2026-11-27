/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Pieces the search tools (grep, glob, find, lsp) share: the file row, the
 * file chip, the inline error view, count wording and highlighted head text.
 */
import * as nodePath from "node:path";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { ToolHead, ToolView } from "./contract";
import { fileHref } from "./file-common";
import { formatArtifactErrorNotice, formatTruncationMetaNotice, type OutputMeta } from "../../tools/output-meta-format";

/** `1 match`, `2 matches`. */
export function countText(count: number, noun: string, plural = `${noun}${noun.endsWith("h") ? "es" : "s"}`): string {
	return `${count} ${count === 1 ? noun : plural}`;
}

/** Tabs as the terminal draws them; newlines flattened to spaces. */
export function flatText(text: string): string {
	return replaceTabs(text.replace(/\r?\n/g, " "));
}

/** Spans as head text: tabs drawn as spaces, neighbors of one style merged; plain text when nothing is styled. */
export function spansText(spans: Iterable<TspSpan>): TspText {
	const out: TspSpan[] = [];
	for (const span of spans) {
		const last = out[out.length - 1];
		const t = replaceTabs(span.t);
		if (last && last.s === span.s) out[out.length - 1] = { ...last, t: last.t + t };
		else out.push({ ...span, t });
	}
	if (out.length === 0) return "";
	return out.length === 1 && out[0]!.s === undefined ? out[0]!.t : out;
}

/** The path's directory (with its trailing slash) and its last segment; a directory path keeps its slash on the name. */
export function splitPath(path: string): {
	readonly dir: string;
	readonly name: string;
} {
	const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
	const cut = trimmed.lastIndexOf("/");
	if (cut < 0) return { dir: "", name: path };
	return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/** A path as spans: the directory dim, the name strong (linked to `href` when given). */
export function pathSpans(path: string, href?: string): TspSpan[] {
	const { dir, name } = splitPath(path);
	const strong: TspSpan = href ? { s: "strong", t: name, href } : { s: "strong", t: name };
	return dir ? [{ s: "dim", t: dir }, strong] : [strong];
}

/** The native link of a listed file under `cwd`; directories stay unlinked. */
export function listedFileHref(cwd: string | undefined, path: string): string | undefined {
	return cwd === undefined || isDirectory(path) ? undefined : fileHref(nodePath.resolve(cwd, path));
}

/** Whether a listed path names a directory. */
export function isDirectory(path: string): boolean {
	return path.endsWith("/");
}

/** A file's row (`omp.tool.file`): icon, path (cut in the middle), optional count badge. */
export function FileRow(props: {
	readonly id?: string;
	readonly path: string;
	readonly badge?: { readonly text: string; readonly title: string };
	readonly icon?: string;
	/** The checkout the path is relative to: links the name. */
	readonly cwd?: string;
}): JSXNode {
	return (
		<row key={props.id} role="omp.tool.file">
			<icon name={props.icon ?? (isDirectory(props.path) ? "folder" : "file")} />
			<text
				spans={pathSpans(props.path, listedFileHref(props.cwd, props.path))}
				title={props.path}
				truncate="middle"
				lines={1}
				shrink={1}
			/>
			{props.badge ? <badge text={props.badge.text} title={props.badge.title} /> : undefined}
		</row>
	);
}

/** A file chip (`omp.tool.chip`) for wrapped file lists: icon and name (linked under `cwd`), the full path as its title. */
export function FileChip(props: { readonly path: string; readonly cwd?: string }): JSXNode {
	const href = listedFileHref(props.cwd, props.path);
	const name = splitPath(props.path).name;
	return (
		<row key={props.path} role="omp.tool.chip" gap="xs" align="center" title={props.path}>
			<icon name={isDirectory(props.path) ? "folder" : "file"} />
			<text spans={[href ? { s: "strong", t: name, href } : { s: "strong", t: name }]} wrap="none" />
		</row>
	);
}

/** The muted `— message` meta a failed call shows after its target. */
export function errorMeta(message: string): TspText {
	return [{ s: "muted", t: `— ${message.split("\n")[0]}` }];
}

/**
 * An inline call that failed: the head with `— first line` after its meta; the
 * whole message as an error text below when it has more lines.
 */
export function inlineErrorView(head: ToolHead, message: string, extra?: Partial<ToolView>): ToolView {
	const body = message.includes("\n") ? (
		<text role="omp.tool.error" spans={[{ s: "error", t: message }]} wrap="word" />
	) : undefined;
	return {
		head: { ...head, meta: [...(head.meta ?? []), errorMeta(message)] },
		tone: "error",
		body,
		...extra,
	};
}

/**
 * The muted foot joining notes with ` · `, then the output's truncation / artifact notices
 * (`omp.tool.notice` with one, else `omp.tool.stats`); nothing without notes.
 */
export function StatsFoot(props: {
	readonly notes: readonly (string | undefined)[];
	readonly meta?: Pick<OutputMeta, "truncation" | "artifactError" | "source">;
}): JSXNode {
	const all = props.notes.filter((note): note is string => Boolean(note));
	const meta = props.meta;
	if (meta?.truncation) all.push(formatTruncationMetaNotice(meta.truncation, meta.source));
	if (meta?.artifactError) all.push(formatArtifactErrorNotice(meta.artifactError));
	if (all.length === 0) return undefined;
	const notice = meta?.truncation !== undefined || meta?.artifactError !== undefined;
	return (
		<text
			key="foot"
			role={notice ? "omp.tool.notice" : "omp.tool.stats"}
			spans={[{ s: "muted", t: all.join(" · ") }]}
			wrap="word"
		/>
	);
}
