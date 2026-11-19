/** `edit` / `apply_patch` — hashline patch application rendered as colored diffs. */
import type { ReactNode } from "react";
import { Badge, DiffBlock, InvalidArg, Kv, KvGrid, Note, Output, PathText, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

/** Path from a hashline `[path#TAG]` / `[path]` header line, or null. */
function headerPath(line: string): string | null {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
	let body = trimmed.slice(1, -1).trim();
	const hash = /#[0-9a-fA-F]{4}$/.exec(body);
	if (hash) body = body.slice(0, hash.index);
	if (body.length >= 2) {
		const first = body[0];
		if ((first === '"' || first === "'") && first === body[body.length - 1]) body = body.slice(1, -1);
	}
	return body.length > 0 ? body : null;
}

const APPLY_PATCH_HEADER_RE = /^\*{3} (?:Update|Add|Delete) File:\s*(.+)$/;

/** File paths named by hashline or apply_patch section headers, in order. */
function inputPaths(input: string): string[] {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const paths: string[] = [];
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const fromHashline = headerPath(line);
		if (fromHashline) {
			paths.push(fromHashline);
			continue;
		}
		const fromApplyPatch = APPLY_PATCH_HEADER_RE.exec(line.trim());
		if (fromApplyPatch) paths.push(fromApplyPatch[1].trim());
	}
	return paths;
}

const OP_HEADER_RE = /^(?:replace|insert|delete)\b/;

function countOps(input: string): number {
	let count = 0;
	for (const line of input.split("\n")) if (OP_HEADER_RE.test(line)) count++;
	return count;
}

function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

interface DiagnosticsEntry {
	summary: string | null;
	messages: string[];
	errored: boolean;
}

/** One file's outcome — top-level `details` and `perFileResults[i]` share this shape. */
interface FileEntry {
	path: string | null;
	diff: string | null;
	firstChangedLine: number | null;
	op: string | null;
	move: string | null;
	isError: boolean;
	errorText: string | null;
	diagnostics: DiagnosticsEntry | null;
}

function fileEntry(d: Record<string, unknown>): FileEntry {
	const diag = isRecord(d.diagnostics) ? d.diagnostics : null;
	const messages: string[] = [];
	if (diag && Array.isArray(diag.messages)) {
		for (const m of diag.messages) if (typeof m === "string") messages.push(m);
	}
	return {
		path: str(d.path),
		diff: str(d.diff),
		firstChangedLine: num(d.firstChangedLine),
		op: str(d.op),
		move: str(d.move),
		isError: d.isError === true,
		errorText: str(d.displayErrorText) ?? str(d.errorText),
		diagnostics: diag ? { summary: str(diag.summary), messages, errored: diag.errored === true } : null,
	};
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const input = str(args.input) ?? str(args._input);
	const paths = input ? inputPaths(input) : [];
	const argPath = str(args.file_path) ?? str(args.path);
	if (paths.length === 0 && argPath) paths.push(argPath);
	if (paths.length === 0 && Array.isArray(args.edits)) {
		for (const e of args.edits) {
			const p = isRecord(e) ? str(e.path) : null;
			if (p && !paths.includes(p)) paths.push(p);
		}
	}
	const opCount = input ? countOps(input) : 0;
	const details = detailsRecord(result);
	const diff = details && result?.isError !== true ? str(details.diff) : null;
	const stats = diff ? diffStats(diff) : null;
	const firstLine = input ? truncate(normalizeWs(input.split("\n", 1)[0] ?? ""), 80) : "";
	return (
		<>
			{paths.length > 0 ? <PathText path={paths[0]} /> : <span>{firstLine}</span>}
			{paths.length > 1 && (
				<>
					{" "}
					<Badge>+{paths.length - 1} more</Badge>
				</>
			)}
			{opCount > 0 && (
				<>
					{" "}
					<Badge>
						{opCount} op{opCount === 1 ? "" : "s"}
					</Badge>
				</>
			)}
			{stats !== null && stats.added > 0 && (
				<>
					{" "}
					<Badge tone="ok">+{stats.added}</Badge>
				</>
			)}
			{stats !== null && stats.removed > 0 && (
				<>
					{" "}
					<Badge tone="err">−{stats.removed}</Badge>
				</>
			)}
			{result?.isError === true && (
				<>
					{" "}
					<Badge tone="err">failed</Badge>
				</>
			)}
		</>
	);
}

function FileSection({ entry, fallbackPath }: { entry: FileEntry; fallbackPath?: string | null }): ReactNode {
	const path = entry.path ?? fallbackPath ?? null;
	const op = entry.op === "create" || entry.op === "delete" ? entry.op : null;
	const diag = entry.diagnostics;
	return (
		<div>
			{(path !== null || op !== null || entry.move !== null) && (
				<div className="tv-row">
					<span className="tv-row-val">
						{path !== null && <PathText path={path} from={entry.isError ? null : entry.firstChangedLine} />}
						{entry.move !== null && (
							<>
								{" → "}
								<PathText path={entry.move} />
							</>
						)}
						{op !== null && (
							<>
								{" "}
								<Badge tone={op === "delete" ? "err" : "ok"}>{op}</Badge>
							</>
						)}
						{entry.isError && (
							<>
								{" "}
								<Badge tone="err">failed</Badge>
							</>
						)}
					</span>
				</div>
			)}
			{entry.isError
				? entry.errorText !== null && <Output text={entry.errorText} error maxLines={10} />
				: entry.diff !== null && entry.diff.length > 0 && <DiffBlock diff={entry.diff} maxLines={40} />}
			{diag?.summary && <Note tone={diag.errored ? "err" : "warn"}>{diag.summary}</Note>}
			{diag !== null && diag.messages.length > 0 && <Output text={diag.messages.join("\n")} maxLines={6} />}
		</div>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const input = str(args.input) ?? str(args._input);
	const details = detailsRecord(result);
	const perFile: FileEntry[] = [];
	if (details && Array.isArray(details.perFileResults)) {
		for (const f of details.perFileResults) if (isRecord(f)) perFile.push(fileEntry(f));
	}
	const fallbackPath = str(args.file_path) ?? str(args.path) ?? (input ? (inputPaths(input)[0] ?? null) : null);

	let outcome: ReactNode;
	if (perFile.length > 0) {
		outcome = perFile.map((f, i) => <FileSection key={`${f.path ?? ""}:${i}`} entry={f} />);
	} else if (result?.isError === true) {
		// Failed matches embed numbered file context — keep a generous window.
		outcome = <ResultText result={result} maxLines={15} />;
	} else if (details) {
		const top = fileEntry(details);
		outcome =
			top.diff !== null || top.diagnostics !== null || top.move !== null ? (
				<FileSection entry={top} fallbackPath={fallbackPath} />
			) : (
				<ResultText result={result} maxLines={8} />
			);
	} else {
		outcome = <ResultText result={result} maxLines={8} />;
	}

	return (
		<>
			{outcome}
			{Array.isArray(args.edits) && args.edits.length > 0 && (
				<KvGrid>
					{args.edits.map((e, i) =>
						isRecord(e) ? (
							<Kv key={`${i}`} k={str(e.op) ?? "edit"}>
								{str(e.sel) ?? str(e.path) ?? str(e.rename) ?? str(e.move) ?? "?"}
							</Kv>
						) : (
							<Kv key={`${i}`} k="edit">
								<InvalidArg what="edit" />
							</Kv>
						),
					)}
				</KvGrid>
			)}
			{input !== null && input.length > 0 && <Output text={input} variant="code" maxLines={10} title="input" />}
			{input === null && (args.input !== undefined || args._input !== undefined) && <InvalidArg what="input" />}
		</>
	);
}

export const editRenderer: ToolRenderer = { Summary, Body };
