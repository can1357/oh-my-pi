/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * LSP: the action as the title (`Diagnostics`, `Hover`, `References`), the
 * file (and line) as the target, the symbol as meta. Results: diagnostics as
 * severity rows, hover as markdown, location counts, other answers as text.
 *
 * Terminal look: `lsp` (`src/ui/styles/tools/lsp.ts`): `💡 LSP: hover a.ts:3
 * (retry)` then a per-action body.
 */
import type { TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import type { ToolHead, ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";
import { fileHref } from "./file-common";
import { countText, FileRow, inlineErrorView } from "./search-common";

/** The args lsp shows; models may send `null` for an unused optional arg. */
export interface LspArgs {
	readonly action?: string;
	readonly file?: string;
	readonly line?: number | null;
	readonly symbol?: string;
	readonly new_name?: string | null;
}

/** One parsed diagnostic. */
export interface LspDiagnostic {
	readonly location: string;
	readonly severity: string;
	readonly message: string;
}

/** Terminal facts of the `lsp` look. */
export type LspTerm = {
	readonly look: "lsp";
	readonly result?: boolean;
	/** `hover a.ts:3 (retry)`. */
	readonly description?: string;
	/** A rename's new name. */
	readonly newName?: string;
	/** Plain head facts (counts). */
	readonly facts?: readonly string[];
	readonly diagnostics?: readonly LspDiagnostic[];
	/** Listed locations (references, definitions). */
	readonly locations?: readonly LspLocationFile[];
	/** Hover markdown. */
	readonly hover?: string;
	/** Answer lines shown as a tree. */
	readonly lines?: readonly string[];
	/** The answer is a "nothing found". */
	readonly empty?: boolean;
	readonly error?: string;
};

/** One location an answer lists, with its line's text. */
export type LspLocation = {
	readonly line: number;
	readonly column: number;
	readonly text: string;
};

/** A file's locations. */
export type LspLocationFile = {
	readonly path: string;
	readonly locations: readonly LspLocation[];
};

const LOCATION = /^ {2}(.+):(\d+):(\d+)$/;
const CONTEXT = /^ {4}(\d+): ?(.*)$/;

/** Locations of a `Found N reference(s):` answer, by file in answer order, each with its own line's text. */
function locationFiles(lines: readonly string[]): LspLocationFile[] {
	const files = new Map<string, LspLocation[]>();
	let current: { line: number; column: number; text: string } | undefined;
	let list: LspLocation[] | undefined;
	for (const raw of lines) {
		const location = LOCATION.exec(raw);
		if (location) {
			current = { line: Number(location[2]), column: Number(location[3]), text: "" };
			list = files.get(location[1]!);
			if (!list) files.set(location[1]!, (list = []));
			list.push(current);
			continue;
		}
		const context = CONTEXT.exec(raw);
		if (context && current && Number(context[1]) === current.line) current.text = context[2]!;
	}
	return [...files].map(([path, locations]) => ({ path, locations }));
}

function LocationFile(props: { readonly file: LspLocationFile; readonly noun: string }) {
	const { file } = props;
	const lines = file.locations.map(location => location.line);
	const contiguous = lines.every((line, i) => i === 0 || line === lines[i - 1]! + 1);
	return (
		<col key={file.path} gap="xs">
			<FileRow
				id={file.path}
				path={file.path}
				badge={{ text: String(lines.length), title: countText(lines.length, props.noun) }}
			/>
			<code
				key={`c${lines[0]}`}
				text={file.locations.map(location => location.text).join("\n")}
				path={file.path}
				{...(contiguous ? { start: lines[0] } : { nums: lines })}
				numbers
				marks={lines.map(line => ({ line, tone: "accent" as const }))}
			/>
		</col>
	);
}

/** Body rows shown while collapsed. */
const DIAGNOSTICS_PREVIEW = 8;
const TEXT_PREVIEW = 4;

const DIAGNOSTIC = /^(.+?:\d+:\d+)\s+\[(\w+)\]\s+(.*)$/;
const LOCATIONS = /^Found (\d+) (definition|type definition|implementation|reference)\(s\):$/;
const NONE_FOUND = /^No .* found\.?$/;

const SEVERITY_ICON: Readonly<Record<string, { readonly name: string; readonly tone: TspTone }>> = {
	error: { name: "x-circle", tone: "error" },
	warning: { name: "warn", tone: "warning" },
	info: { name: "info", tone: "info" },
	hint: { name: "info", tone: "muted" },
};

function title(action: string | undefined): string {
	const name = action || "lsp";
	return name
		.split(/[_\s]+/)
		.map(word => (word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word))
		.join(" ");
}

/** `a.ts:3`, or `a.ts` without a line. */
function fileLine(file: string, line: number | null | undefined): string {
	return line != null ? `${file}:${line}` : file;
}

function lspHead(args: LspArgs | undefined, meta: readonly TspText[]): ToolHead {
	const target = args?.file ? fileLine(args.file, args.line) : undefined;
	const href = fileHref(args?.file);
	return {
		title: title(args?.action),
		...(target ? { target, targetKind: "path" as const } : {}),
		...(href ? { href } : {}),
		meta,
	};
}

function callMeta(args: LspArgs | undefined): TspText[] {
	if (!args?.symbol) return [];
	return [args.new_name != null ? `${args.symbol} · → ${args.new_name}` : args.symbol];
}

function lspTerm(args: LspArgs | undefined, extra?: Partial<LspTerm>): LspTerm {
	const action = args?.action || "lsp";
	const newName = args?.new_name ?? undefined;
	const at = args?.file ? ` ${fileLine(args.file, args.line)}` : "";
	const symbol = args?.symbol && newName === undefined ? ` (${args.symbol})` : "";
	return {
		look: "lsp",
		description: `${action}${at}${symbol}`,
		newName,
		...extra,
	};
}

function countSpans(counts: Readonly<Record<string, number>>): TspSpan[] {
	const spans: TspSpan[] = [];
	for (const severity of ["error", "warning", "info", "hint"]) {
		const count = counts[severity] ?? 0;
		if (count === 0) continue;
		if (spans.length > 0) spans.push({ s: "dim", t: " · " });
		spans.push({
			s: SEVERITY_ICON[severity]!.tone,
			t: countText(count, severity),
		});
	}
	return spans;
}

export const lspPresenter: ToolPresenter<LspArgs> = {
	inline: true,
	merge: true,
	call: args => ({
		head: lspHead(args, callMeta(args)),
		term: lspTerm(args),
	}),
	result(result, _state, args): ToolView {
		const text = resultText(result);
		if (result.isError) {
			const message = text || "Unknown error";
			return inlineErrorView(lspHead(args, callMeta(args)), message, {
				term: lspTerm(args, { result: true, error: message }),
			});
		}
		const lines = text.split("\n");
		const diagnostics: LspDiagnostic[] = [];
		for (const line of lines) {
			const match = DIAGNOSTIC.exec(line.trim());
			if (match)
				diagnostics.push({
					location: match[1]!,
					severity: match[2]!.toLowerCase(),
					message: match[3]!,
				});
		}
		if (diagnostics.length > 0) {
			const counts: Record<string, number> = {};
			for (const diagnostic of diagnostics) counts[diagnostic.severity] = (counts[diagnostic.severity] ?? 0) + 1;
			const tone: TspTone | undefined = counts.error ? "error" : counts.warning ? "warning" : undefined;
			const facts = [];
			for (const span of countSpans(counts)) if (span.s !== "dim") facts.push(span.t);
			return {
				head: lspHead(args, [countSpans(counts)]),
				...(tone ? { tone } : {}),
				preview: { lines: DIAGNOSTICS_PREVIEW },
				body: diagnostics.map((diagnostic, i) => {
					const icon = SEVERITY_ICON[diagnostic.severity] ?? SEVERITY_ICON.info!;
					return (
						<row key={`d${i}`} role="omp.tool.diagnostic">
							<icon name={icon.name} tone={icon.tone} aria={diagnostic.severity} />
							<text spans={[{ s: "mono muted", t: diagnostic.location }]} wrap="none" />
							<text spans={[{ t: diagnostic.message }]} wrap="word" grow={1} />
						</row>
					);
				}),
				term: lspTerm(args, { result: true, facts, diagnostics }),
			};
		}
		const locations = LOCATIONS.exec(lines[0]?.trim() ?? "");
		if (locations) {
			const noun = locations[2]!;
			const count = countText(Number(locations[1]), noun);
			const files = locationFiles(lines.slice(1));
			const facts = files.length > 0 ? [count, countText(files.length, "file")] : [count];
			return {
				head: lspHead(args, [...callMeta(args), count]),
				preview: { lines: DIAGNOSTICS_PREVIEW },
				body: files.map(file => <LocationFile file={file} noun={noun} />),
				term: lspTerm(args, { result: true, facts, locations: files }),
			};
		}
		if (/```/.test(text)) {
			return {
				head: lspHead(args, callMeta(args)),
				preview: { lines: TEXT_PREVIEW },
				body: <md text={text} />,
				term: lspTerm(args, { result: true, hover: text }),
			};
		}
		const answer = lines.filter(line => line.trim() !== "");
		return {
			head: lspHead(args, callMeta(args)),
			preview: { lines: TEXT_PREVIEW },
			body: text ? <ansi text={text} /> : undefined,
			term: lspTerm(args, {
				result: true,
				lines: answer,
				empty: answer.length === 1 && NONE_FOUND.test(answer[0]!.trim()),
			}),
		};
	},
};

registerToolPresenter("lsp", lspPresenter);
