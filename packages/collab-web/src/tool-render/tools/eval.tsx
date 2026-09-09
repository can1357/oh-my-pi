/**
 * `eval` (aliases: js, python, notebook) — code cells executed in the
 * persistent kernel (py/js/rb/jl). Args arrive either as the modern single-cell
 * flat shape (`language`/`code`/`title`/`timeout`/`reset`), a legacy `cells`
 * array, or a legacy framed `input` string (`*** Cell`, `*** Begin LANG`,
 * `===== info =====`); all render as discrete highlighted cells. When the result
 * carries typed per-cell details, each cell's output is interleaved beneath its code.
 */
import type { ReactNode } from "react";
import { Badges, CodeBlock, InvalidArg, Note, Output, ResultImages, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { argsDigest, detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

interface EvalCell {
	lang: string;
	title: string;
	/** Display attributes, e.g. "t=60s", "rst". */
	attrs: string[];
	code: string;
}

const HLJS_LANG: Record<string, string> = {
	py: "python",
	js: "javascript",
	ts: "typescript",
	rb: "ruby",
	jl: "julia",
};

/** Map an eval language token to its canonical short id, or null when unknown. */
function evalLangAlias(token: string | undefined): string | null {
	const t = (token ?? "").toUpperCase();
	if (t === "PY" || t === "PYTHON" || t === "IPY" || t === "IPYTHON") return "py";
	if (t === "JS" || t === "JAVASCRIPT") return "js";
	if (t === "TS" || t === "TYPESCRIPT") return "ts";
	if (t === "RB" || t === "RUBY") return "rb";
	if (t === "JL" || t === "JULIA") return "jl";
	return null;
}

/** Tokenize a `*** Cell` header attribute list, preserving quoted segments. */
function tokenizeCellAttrs(input: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < input.length) {
		while (i < input.length && /\s/.test(input[i])) i++;
		if (i >= input.length) break;
		let tok = "";
		while (i < input.length && !/\s/.test(input[i])) {
			const ch = input[i];
			if (ch === '"' || ch === "'") {
				tok += ch;
				i++;
				while (i < input.length && input[i] !== ch) {
					tok += input[i];
					i++;
				}
				if (i < input.length) {
					tok += input[i];
					i++;
				}
			} else {
				tok += ch;
				i++;
			}
		}
		tokens.push(tok);
	}
	return tokens;
}

/** Canonical `*** Cell <attrs>` framing. */
function parseEvalCellsCell(text: string): EvalCell[] {
	const CELL = /^\*{2,}\s*Cell\b\s*(.*)$/i;
	const END = /^\*{2,}\s*End\b.*$/i;
	const ATTR = /^([a-zA-Z][\w-]*)(?::(?:"([^"]*)"|'([^']*)'|(.*)))?$/;
	const DUR = /^\d+(?:ms|s|m)?$/;
	const ID_KEYS = ["id", "title", "name", "cell", "file", "label"];
	const T_KEYS = ["t", "timeout", "duration", "time"];
	const RST_KEYS = ["rst", "reset"];
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const cells: EvalCell[] = [];
	let i = 0;
	while (i < lines.length && lines[i].trim() === "") i++;
	while (i < lines.length) {
		const m = CELL.exec(lines[i]);
		if (!m) {
			i++;
			continue;
		}
		const tokens = tokenizeCellAttrs(m[1] ?? "");
		let lang: string | null = null;
		let title = "";
		const attrs: string[] = [];
		let bareReset = false;
		const titleParts: string[] = [];
		for (const tok of tokens) {
			if (RST_KEYS.includes(tok.toLowerCase())) {
				bareReset = true;
				continue;
			}
			const am = ATTR.exec(tok);
			if (am && tok.includes(":")) {
				const key = am[1].toLowerCase();
				const value = am[2] ?? am[3] ?? am[4] ?? "";
				const lc = evalLangAlias(key);
				if (lc) {
					if (!lang) lang = lc;
					if (!title && value) title = value;
					continue;
				}
				if (ID_KEYS.includes(key)) {
					if (!title) title = value;
					continue;
				}
				if (T_KEYS.includes(key)) {
					attrs.push(`t=${value}`);
					continue;
				}
				if (RST_KEYS.includes(key)) attrs.push("rst");
				continue;
			}
			const lc = evalLangAlias(tok);
			if (lc && !lang) {
				lang = lc;
				continue;
			}
			if (DUR.test(tok)) {
				attrs.push(`t=${tok}`);
				continue;
			}
			titleParts.push(tok);
		}
		if (!title && titleParts.length > 0) title = titleParts.join(" ");
		if (bareReset) attrs.push("rst");
		i++;
		const codeLines: string[] = [];
		while (i < lines.length) {
			if (END.test(lines[i])) {
				i++;
				break;
			}
			if (CELL.test(lines[i])) break;
			codeLines.push(lines[i]);
			i++;
		}
		while (codeLines.length > 0 && codeLines[codeLines.length - 1].trim() === "") codeLines.pop();
		cells.push({ lang: lang ?? "py", title, attrs, code: codeLines.join("\n") });
		while (i < lines.length && lines[i].trim() === "") i++;
	}
	return cells;
}

/** Older `*** Begin LANG` / `*** Title:` / `*** End` framing. */
function parseEvalCellsBegin(text: string): EvalCell[] {
	const BEGIN = /^\*{2,}\s*Begin\b\s*(\S+)?\s*$/i;
	const END = /^\*{2,}\s*End\b.*$/i;
	const TITLE = /^\*{2,}\s*Title\s*:\s*(.+?)\s*$/i;
	const TIMEOUT = /^\*{2,}\s*Timeout\s*:\s*(\S+)\s*$/i;
	const RESET = /^\*{2,}\s*Reset\s*$/i;
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const cells: EvalCell[] = [];
	let i = 0;
	while (i < lines.length && lines[i].trim() === "") i++;
	while (i < lines.length) {
		const beginMatch = BEGIN.exec(lines[i]);
		if (!beginMatch) {
			i++;
			continue;
		}
		const lang = evalLangAlias(beginMatch[1]) ?? "py";
		i++;
		let title = "";
		const attrs: string[] = [];
		while (i < lines.length) {
			const tm = TITLE.exec(lines[i]);
			if (tm) {
				if (!title) title = tm[1];
				i++;
				continue;
			}
			const to = TIMEOUT.exec(lines[i]);
			if (to) {
				attrs.push(`t=${to[1]}`);
				i++;
				continue;
			}
			if (RESET.test(lines[i])) {
				attrs.push("rst");
				i++;
				continue;
			}
			break;
		}
		const codeLines: string[] = [];
		while (i < lines.length) {
			if (END.test(lines[i])) {
				i++;
				break;
			}
			if (BEGIN.test(lines[i])) break;
			codeLines.push(lines[i]);
			i++;
		}
		while (codeLines.length > 0 && codeLines[codeLines.length - 1].trim() === "") codeLines.pop();
		cells.push({ lang, title, attrs, code: codeLines.join("\n") });
		while (i < lines.length && lines[i].trim() === "") i++;
	}
	return cells;
}

/** Oldest `===== info =====` bar framing; bare code becomes one python cell. */
function parseEvalCellsLegacy(input: string): EvalCell[] {
	const HEADER = /^={5,}\s*(.*?)\s*={5,}\s*$/;
	const lines = input.split("\n");
	const cells: EvalCell[] = [];
	let inheritedLang = "py";
	let current: EvalCell | null = null;
	for (const line of lines) {
		const m = HEADER.exec(line);
		if (m) {
			if (current) cells.push(current);
			const info = m[1] ?? "";
			let lang = inheritedLang;
			let title = "";
			const langMatch = info.match(/^(py|js|ts|rb|jl)(?::"([^"]*)")?/);
			if (langMatch) {
				lang = langMatch[1];
				if (langMatch[2]) title = langMatch[2];
			}
			if (!title) {
				const idMatch = info.match(/id:"([^"]*)"/);
				if (idMatch) title = idMatch[1];
			}
			inheritedLang = lang;
			const attrs: string[] = [];
			const tMatch = info.match(/(?:^|\s)t:(\S+)/);
			if (tMatch) attrs.push(`t=${tMatch[1]}`);
			if (/(?:^|\s)rst(?:\s|$)/.test(info)) attrs.push("rst");
			current = { lang, title, attrs, code: "" };
		} else {
			if (!current) current = { lang: inheritedLang, title: "", attrs: [], code: "" };
			current.code += (current.code ? "\n" : "") + line;
		}
	}
	if (current) cells.push(current);
	return cells.map(c => ({ ...c, code: c.code.replace(/\s+$/, "") }));
}

function parseEvalCells(input: string): EvalCell[] {
	if (/^\*{2,}\s*Cell\b/im.test(input)) return parseEvalCellsCell(input);
	if (/^\*{2,}\s*Begin\b/im.test(input)) return parseEvalCellsBegin(input);
	return parseEvalCellsLegacy(input);
}

/** Cells from either arg shape; `name` disambiguates legacy alias tools. */
function cellsFromArgs(args: Record<string, unknown>, name: string): EvalCell[] {
	const raw = args.cells;
	if (Array.isArray(raw)) {
		const out: EvalCell[] = [];
		for (const item of raw) {
			if (!isRecord(item)) continue;
			const attrs: string[] = [];
			const timeout = num(item.timeout);
			if (timeout !== null) attrs.push(`t=${timeout}s`);
			if (item.reset === true) attrs.push("rst");
			out.push({
				lang: evalLangAlias(str(item.language) ?? undefined) ?? "py",
				title: str(item.title) ?? "",
				attrs,
				code: str(item.code) ?? "",
			});
		}
		return out;
	}
	const input = str(args.input);
	if (input !== null) return parseEvalCells(input).filter(c => c.code !== "" || c.title !== "");
	const code = str(args.code);
	if (code !== null) {
		const attrs: string[] = [];
		const timeout = num(args.timeout);
		if (timeout !== null) attrs.push(`t=${timeout}s`);
		if (args.reset === true) attrs.push("rst");
		const lang = evalLangAlias(str(args.language) ?? undefined) ?? (name === "js" ? "js" : "py");
		return [{ lang, title: str(args.title) ?? "", attrs, code }];
	}
	return [];
}

/** Per-cell execution result from `result.details.cells` (typed by the tool). */
interface DetailCell {
	index: number;
	title: string;
	code: string;
	lang: string | null;
	output: string;
	status: string;
	durationMs: number | null;
	exitCode: number | null;
}

function detailCellsOf(details: Record<string, unknown> | null): DetailCell[] {
	const raw = details?.cells;
	if (!Array.isArray(raw)) return [];
	const out: DetailCell[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item: unknown = raw[i];
		if (!isRecord(item)) continue;
		const language = str(item.language);
		out.push({
			index: num(item.index) ?? i,
			title: str(item.title) ?? "",
			code: str(item.code) ?? "",
			lang: language !== null ? (evalLangAlias(language) ?? "py") : null,
			output: str(item.output) ?? "",
			status: str(item.status) ?? "",
			durationMs: num(item.durationMs),
			exitCode: num(item.exitCode),
		});
	}
	return out;
}

function renderCells(args: Record<string, unknown>, name: string, detailCells: DetailCell[]): EvalCell[] {
	const cells = cellsFromArgs(args, name);
	if (cells.length > 0) return cells;
	return detailCells.map(c => ({ lang: c.lang ?? "py", title: c.title, attrs: [], code: c.code }));
}

function Summary({ name, args, result }: ToolRenderProps): ReactNode {
	const cells = renderCells(args, name, detailCellsOf(detailsRecord(result)));
	if (cells.length === 0) return <span className="tv-muted">{argsDigest(args)}</span>;
	const first = cells[0];
	const label = first.title || normalizeWs(first.code.split("\n").find(l => l.trim() !== "") ?? "");
	const langs = [...new Set(cells.map(c => c.lang))];
	return (
		<>
			{label && <span>{truncate(label, 72)}</span>}
			<Badges items={[cells.length > 1 ? `${cells.length} cells` : null, ...langs]} />
		</>
	);
}

function Body({ name, args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const detailCells = detailCellsOf(details);
	const cells = renderCells(args, name, detailCells);

	if (cells.length === 0) {
		const badArgs = !Array.isArray(args.cells) && str(args.input) === null && str(args.code) === null;
		return (
			<>
				{badArgs && <InvalidArg what="cells" />}
				<ResultImages result={result} />
				<ResultText result={result} maxLines={12} />
			</>
		);
	}

	const jsonOutputs = Array.isArray(details?.jsonOutputs) ? details.jsonOutputs : [];
	const jsonText = jsonOutputs
		.map(v => {
			try {
				return JSON.stringify(v, null, 2) ?? String(v);
			} catch {
				return String(v);
			}
		})
		.join("\n");
	const notice = str(details?.notice);

	return (
		<>
			<div className="tv-cells">
				{cells.map((cell, i) => {
					const dc = detailCells.find(c => c.index === i) ?? detailCells[i];
					const titleParts: string[] = [];
					if (cell.title) titleParts.push(cell.title);
					titleParts.push(cell.lang);
					titleParts.push(...cell.attrs);
					if (dc) {
						if (dc.durationMs !== null) {
							const ms = dc.durationMs;
							titleParts.push(ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
						}
						if (dc.status === "error")
							titleParts.push(dc.exitCode !== null ? `error (exit ${dc.exitCode})` : "error");
					}
					return (
						<div className="tv-cell" key={`c${i}`}>
							<CodeBlock code={cell.code} lang={HLJS_LANG[cell.lang] ?? null} title={titleParts.join(" · ")} />
							{dc && dc.output !== "" && <Output text={dc.output} maxLines={12} error={dc.status === "error"} />}
						</div>
					);
				})}
			</div>
			{jsonText && <Output text={jsonText} lang="json" variant="code" maxLines={12} title="display" />}
			{notice && <Note>{notice}</Note>}
			<ResultImages result={result} />
			{detailCells.length === 0 && <ResultText result={result} maxLines={12} />}
		</>
	);
}

export const evalRenderer: ToolRenderer = { Summary, Body };
