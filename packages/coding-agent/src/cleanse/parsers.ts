import * as path from "node:path";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { CleanseDiagnostic, CleanseSeverity } from "./types";

/** Machine and fallback output formats understood by cleanse. */
export const CLEANSE_PARSER_KINDS = [
	"rust",
	"rust-test",
	"go",
	"go-test",
	"staticcheck",
	"golangci",
	"ruff",
	"pyright",
	"mypy",
	"pylint",
	"flake8",
	"ty",
	"eslint",
	"biome",
	"oxlint",
	"deno-lint",
	"stylelint",
	"rubocop",
	"phpstan",
	"psalm",
	"swiftlint",
	"dart",
	"credo",
	"shellcheck",
	"hlint",
	"terraform",
	"tflint",
	"actionlint",
	"generic",
] as const;

/** One machine or fallback output format understood by cleanse. */
export type CleanseParserKind = (typeof CLEANSE_PARSER_KINDS)[number];

/** Captured checker process output passed to a format parser. */
export interface CleanseParserInput {
	checker: string;
	projectCwd: string;
	checkerCwd: string;
	stdout: string;
	stderr: string;
}

interface DiagnosticFields {
	file?: string;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	code?: string;
	severity?: CleanseSeverity | string | number;
	message?: string;
	suggestion?: string;
}

interface ParsedLocation {
	file: string;
	line?: number;
	column?: number;
}

/** Parse one checker invocation into normalized, project-relative diagnostics. */
export function parseCleanseDiagnostics(kind: CleanseParserKind, input: CleanseParserInput): CleanseDiagnostic[] {
	const parsed = (() => {
		switch (kind) {
			case "rust":
				return parseRust(input);
			case "rust-test":
				return parseRustTest(input);
			case "go":
				return parseGo(input);
			case "go-test":
				return parseGoTest(input);
			case "staticcheck":
				return parseStaticcheck(input);
			case "golangci":
				return parseGolangci(input);
			case "ruff":
				return parseRuff(input);
			case "pyright":
				return parsePyright(input);
			case "mypy":
				return parseGeneric(input);
			case "pylint":
				return parsePylint(input);
			case "flake8":
				return parseFlake8(input);
			case "ty":
				return parseTy(input);
			case "eslint":
				return parseEslint(input);
			case "biome":
				return parseBiome(input);
			case "oxlint":
				return parseUnixFormat(input);
			case "deno-lint":
				return parseDenoLint(input);
			case "stylelint":
				return parseStylelint(input);
			case "rubocop":
				return parseRubocop(input);
			case "phpstan":
				return parsePhpstan(input);
			case "psalm":
				return parsePsalm(input);
			case "swiftlint":
				return parseSwiftlint(input);
			case "dart":
				return parseDart(input);
			case "credo":
				return parseCredo(input);
			case "shellcheck":
				return parseShellcheck(input);
			case "hlint":
				return parseHlint(input);
			case "terraform":
				return parseTerraform(input);
			case "tflint":
				return parseTflint(input);
			case "actionlint":
				return parseActionlint(input);
			case "generic":
				return parseGeneric(input);
		}
	})();
	return deduplicateDiagnostics(parsed);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function toArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nestedRecord(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
	return toRecord(record?.[key]);
}

function normalizeSeverity(value: DiagnosticFields["severity"]): CleanseSeverity {
	if (typeof value === "number") return value >= 2 ? "error" : value === 1 ? "warning" : "info";
	const normalized = String(value ?? "warning").toLowerCase();
	if (normalized.includes("error") || normalized === "fatal") return "error";
	if (normalized.includes("warn") || normalized === "convention" || normalized === "refactor") return "warning";
	return "info";
}

function normalizeFile(rawFile: string, input: CleanseParserInput): string | undefined {
	let file = rawFile.trim().replace(/^['"]|['"]$/g, "");
	if (!file || file.startsWith("<")) return undefined;
	if (file.startsWith("file://")) {
		try {
			file = decodeURIComponent(new URL(file).pathname);
		} catch {
			return undefined;
		}
	}
	const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(input.checkerCwd, file);
	const relative = path.relative(input.projectCwd, absolute);
	if (!relative || relative === ".") return undefined;
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
	return relative.split(path.sep).join("/");
}

function makeDiagnostic(input: CleanseParserInput, fields: DiagnosticFields): CleanseDiagnostic | undefined {
	const message = sanitizeText(fields.message ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!message) return undefined;
	const file = fields.file ? normalizeFile(fields.file, input) : undefined;
	if (fields.file && !file) return undefined;
	return {
		checker: input.checker,
		file,
		line: positiveInteger(fields.line),
		column: positiveInteger(fields.column),
		endLine: positiveInteger(fields.endLine),
		endColumn: positiveInteger(fields.endColumn),
		code: fields.code?.trim() || undefined,
		severity: normalizeSeverity(fields.severity),
		message,
		suggestion: fields.suggestion?.trim() || undefined,
	};
}

function positiveInteger(value: number | undefined): number | undefined {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function addDiagnostic(target: CleanseDiagnostic[], input: CleanseParserInput, fields: DiagnosticFields): void {
	const diagnostic = makeDiagnostic(input, fields);
	if (diagnostic) target.push(diagnostic);
}

function parseJsonValues(text: string): unknown[] {
	const sanitized = sanitizeText(text).trim();
	if (!sanitized) return [];
	try {
		const parsed: unknown = JSON.parse(sanitized);
		return [parsed];
	} catch {}
	const values: unknown[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < sanitized.length; index += 1) {
		const char = sanitized[index];
		if (start < 0) {
			if (char !== "{" && char !== "[") continue;
			start = index;
			depth = 1;
			inString = false;
			escaped = false;
			continue;
		}
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth += 1;
		else if (char === "}" || char === "]") depth -= 1;
		if (depth !== 0) continue;
		try {
			const parsed: unknown = JSON.parse(sanitized.slice(start, index + 1));
			values.push(parsed);
		} catch {}
		start = -1;
	}
	return values;
}

function allJsonValues(input: CleanseParserInput): unknown[] {
	return [...parseJsonValues(input.stdout), ...parseJsonValues(input.stderr)];
}

function parseRust(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const value of parseJsonValues(input.stdout)) {
		const envelope = toRecord(value);
		if (stringField(envelope, "reason") !== "compiler-message") continue;
		const message = nestedRecord(envelope, "message");
		const level = stringField(message, "level");
		if (level !== "error" && level !== "warning") continue;
		const spans = toArray(message?.spans)
			.map(toRecord)
			.filter(entry => entry !== undefined);
		const primary = spans.find(span => span.is_primary === true) ?? spans[0];
		const code = nestedRecord(message, "code");
		addDiagnostic(diagnostics, input, {
			file: stringField(primary, "file_name"),
			line: numberField(primary, "line_start"),
			column: numberField(primary, "column_start"),
			endLine: numberField(primary, "line_end"),
			endColumn: numberField(primary, "column_end"),
			code: stringField(code, "code"),
			severity: level,
			message: stringField(message, "message"),
			suggestion: stringField(primary, "suggested_replacement"),
		});
	}
	return diagnostics;
}

function parseRustTest(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics = parseRust(input);
	const text = `${input.stdout}\n${input.stderr}`;
	for (const line of text.split("\n")) {
		const panic = /thread '([^']+)' panicked at (.*?):(\d+):(\d+):/.exec(line);
		if (!panic) continue;
		addDiagnostic(diagnostics, input, {
			file: panic[2],
			line: Number.parseInt(panic[3], 10),
			column: Number.parseInt(panic[4], 10),
			severity: "error",
			code: "test-failure",
			message: `test ${panic[1]} panicked`,
		});
	}
	return diagnostics;
}

function parseGo(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	const visit = (value: unknown, analyzer?: string): void => {
		if (Array.isArray(value)) {
			for (const child of value) visit(child, analyzer);
			return;
		}
		const record = toRecord(value);
		if (!record) return;
		const position = stringField(record, "posn") ?? stringField(record, "position");
		const message = stringField(record, "message");
		if (position && message) {
			const location = parseLocation(position);
			if (location) {
				addDiagnostic(diagnostics, input, {
					...location,
					code: stringField(record, "category") ?? analyzer,
					severity: "warning",
					message,
				});
			}
			return;
		}
		for (const key in record) visit(record[key], key);
	};
	for (const value of allJsonValues(input)) visit(value);
	return diagnostics.length > 0 ? diagnostics : parseGeneric(input);
}

function parseGoTest(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const value of parseJsonValues(input.stdout)) {
		const event = toRecord(value);
		const output = stringField(event, "Output");
		if (output) {
			for (const line of output.split("\n")) {
				const location = /^\s*(?:\.\/)?(.+?\.go):(\d+)(?::(\d+))?:\s*(.+?)\s*$/.exec(line);
				if (!location) continue;
				addDiagnostic(diagnostics, input, {
					file: location[1],
					line: Number.parseInt(location[2], 10),
					column: location[3] ? Number.parseInt(location[3], 10) : undefined,
					severity: "error",
					code: "test-failure",
					message: location[4],
				});
			}
		}
		const testName = stringField(event, "Test");
		if (stringField(event, "Action") === "fail" && testName) {
			addDiagnostic(diagnostics, input, {
				severity: "error",
				code: "test-failure",
				message: `test ${testName} failed`,
			});
		}
	}
	return diagnostics.length > 0 ? diagnostics : parseGeneric(input);
}

function parseStaticcheck(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const value of allJsonValues(input)) {
		const record = toRecord(value);
		const location = nestedRecord(record, "location");
		const end = nestedRecord(record, "end");
		addDiagnostic(diagnostics, input, {
			file: stringField(location, "file"),
			line: numberField(location, "line"),
			column: numberField(location, "column"),
			endLine: numberField(end, "line"),
			endColumn: numberField(end, "column"),
			code: stringField(record, "code"),
			severity: stringField(record, "severity") ?? "warning",
			message: stringField(record, "message"),
		});
	}
	return diagnostics;
}

function parseGolangci(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	const text = sanitizeText(`${input.stdout}\n${input.stderr}`);
	for (const line of text.split("\n")) {
		const match = /^(.+?):(\d+):(\d+):\s+(.*?)\s+\(([A-Za-z0-9_-]+)\)$/.exec(line.trim());
		if (!match) continue;
		addDiagnostic(diagnostics, input, {
			file: match[1],
			line: Number.parseInt(match[2], 10),
			column: Number.parseInt(match[3], 10),
			code: match[5],
			severity: "warning",
			message: match[4],
		});
	}
	return diagnostics;
}

function parseRuff(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const root of allJsonValues(input)) {
		for (const value of toArray(root)) {
			const record = toRecord(value);
			const location = nestedRecord(record, "location");
			const endLocation = nestedRecord(record, "end_location");
			const fix = nestedRecord(record, "fix");
			addDiagnostic(diagnostics, input, {
				file: stringField(record, "filename"),
				line: numberField(location, "row"),
				column: numberField(location, "column"),
				endLine: numberField(endLocation, "row"),
				endColumn: numberField(endLocation, "column"),
				code: stringField(record, "code"),
				severity: "warning",
				message: stringField(record, "message"),
				suggestion: stringField(fix, "message"),
			});
		}
	}
	return diagnostics;
}

function parsePyright(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const rootValue of allJsonValues(input)) {
		const root = toRecord(rootValue);
		for (const value of toArray(root?.generalDiagnostics)) {
			const record = toRecord(value);
			const range = nestedRecord(record, "range");
			const start = nestedRecord(range, "start");
			const end = nestedRecord(range, "end");
			addDiagnostic(diagnostics, input, {
				file: stringField(record, "file"),
				line: zeroBased(numberField(start, "line")),
				column: zeroBased(numberField(start, "character")),
				endLine: zeroBased(numberField(end, "line")),
				endColumn: zeroBased(numberField(end, "character")),
				code: stringField(record, "rule"),
				severity: stringField(record, "severity"),
				message: stringField(record, "message"),
			});
		}
	}
	return diagnostics;
}

function parsePylint(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const root of allJsonValues(input)) {
		for (const value of toArray(root)) {
			const record = toRecord(value);
			addDiagnostic(diagnostics, input, {
				file: stringField(record, "path"),
				line: numberField(record, "line"),
				column: zeroBased(numberField(record, "column")),
				endLine: numberField(record, "endLine"),
				endColumn: zeroBased(numberField(record, "endColumn")),
				code: stringField(record, "symbol") ?? stringField(record, "message-id"),
				severity: stringField(record, "type"),
				message: stringField(record, "message"),
			});
		}
	}
	return diagnostics;
}

function parseFlake8(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	const text = sanitizeText(`${input.stdout}\n${input.stderr}`);
	for (const line of text.split("\n")) {
		const match = /^(.+?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(.*)$/.exec(line.trim());
		if (!match) continue;
		addDiagnostic(diagnostics, input, {
			file: match[1],
			line: Number.parseInt(match[2], 10),
			column: Number.parseInt(match[3], 10),
			code: match[4],
			severity: match[4].startsWith("F") || match[4].startsWith("E9") ? "error" : "warning",
			message: match[5],
		});
	}
	return diagnostics;
}

function parseTy(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	const text = sanitizeText(`${input.stdout}\n${input.stderr}`);
	for (const line of text.split("\n")) {
		const match = /^(.+?):(\d+):(\d+):\s+(error|warning|info)\[([^\]]+)\]\s+(.*)$/.exec(line.trim());
		if (!match) continue;
		addDiagnostic(diagnostics, input, {
			file: match[1],
			line: Number.parseInt(match[2], 10),
			column: Number.parseInt(match[3], 10),
			code: match[5],
			severity: match[4],
			message: match[6],
		});
	}
	return diagnostics;
}

function zeroBased(value: number | undefined): number | undefined {
	return value === undefined ? undefined : value + 1;
}

function parseEslint(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const root of allJsonValues(input)) {
		for (const fileValue of toArray(root)) {
			const file = toRecord(fileValue);
			for (const messageValue of toArray(file?.messages)) {
				const message = toRecord(messageValue);
				const fix = nestedRecord(message, "fix");
				addDiagnostic(diagnostics, input, {
					file: stringField(file, "filePath"),
					line: numberField(message, "line"),
					column: numberField(message, "column"),
					endLine: numberField(message, "endLine"),
					endColumn: numberField(message, "endColumn"),
					code: stringField(message, "ruleId"),
					severity: numberField(message, "severity"),
					message: stringField(message, "message"),
					suggestion: fix ? "automatic fix available" : undefined,
				});
			}
		}
	}
	return diagnostics;
}

function parseBiome(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const rootValue of allJsonValues(input)) {
		const root = toRecord(rootValue);
		for (const value of toArray(root?.diagnostics)) {
			const record = toRecord(value);
			const location = nestedRecord(record, "location");
			const pathRecord = nestedRecord(location, "path");
			const message =
				stringField(record, "description") ?? stringField(record, "message") ?? stringField(record, "title");
			addDiagnostic(diagnostics, input, {
				file: stringField(pathRecord, "file") ?? stringField(location, "path"),
				code: stringField(record, "category"),
				severity: stringField(record, "severity"),
				message,
			});
		}
	}
	return diagnostics;
}

function parseUnixFormat(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	const text = sanitizeText(`${input.stdout}\n${input.stderr}`);
	for (const line of text.split("\n")) {
		const match = /^(.+?):(\d+):(\d+):\s+(.*?)\s+\[(Error|Warning)\/([^\]]+)\]$/i.exec(line.trim());
		if (!match) continue;
		addDiagnostic(diagnostics, input, {
			file: match[1],
			line: Number.parseInt(match[2], 10),
			column: Number.parseInt(match[3], 10),
			code: match[6],
			severity: match[5],
			message: match[4],
		});
	}
	return diagnostics;
}

function parseDenoLint(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const root of allJsonValues(input)) {
		const record = toRecord(root);
		if (!record) continue;
		for (const value of toArray(record.diagnostics)) {
			const entry = toRecord(value);
			const range = nestedRecord(entry, "range");
			const start = nestedRecord(range, "start");
			const end = nestedRecord(range, "end");
			addDiagnostic(diagnostics, input, {
				file: stringField(entry, "filename"),
				line: numberField(start, "line"),
				column: zeroBased(numberField(start, "col")),
				endLine: numberField(end, "line"),
				endColumn: zeroBased(numberField(end, "col")),
				code: stringField(entry, "code"),
				severity: "warning",
				message: stringField(entry, "message"),
				suggestion: stringField(entry, "hint"),
			});
		}
		for (const value of toArray(record.errors)) {
			const entry = toRecord(value);
			addDiagnostic(diagnostics, input, {
				file: stringField(entry, "file_path"),
				severity: "error",
				message: stringField(entry, "message"),
			});
		}
	}
	return diagnostics;
}

function parseStylelint(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const root of allJsonValues(input)) {
		for (const value of toArray(root)) {
			const record = toRecord(value);
			const source = stringField(record, "source");
			if (!source) continue;
			for (const warning of toArray(record?.warnings)) {
				const entry = toRecord(warning);
				addDiagnostic(diagnostics, input, {
					file: source,
					line: numberField(entry, "line"),
					column: numberField(entry, "column"),
					endLine: numberField(entry, "endLine"),
					endColumn: numberField(entry, "endColumn"),
					code: stringField(entry, "rule"),
					severity: stringField(entry, "severity"),
					message: stringField(entry, "text"),
				});
			}
		}
	}
	return diagnostics;
}

function parseRubocop(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const rootValue of allJsonValues(input)) {
		const root = toRecord(rootValue);
		for (const fileValue of toArray(root?.files)) {
			const file = toRecord(fileValue);
			for (const offenseValue of toArray(file?.offenses)) {
				const offense = toRecord(offenseValue);
				const location = nestedRecord(offense, "location");
				addDiagnostic(diagnostics, input, {
					file: stringField(file, "path"),
					line: numberField(location, "start_line"),
					column: numberField(location, "start_column"),
					endLine: numberField(location, "last_line"),
					endColumn: numberField(location, "last_column"),
					code: stringField(offense, "cop_name"),
					severity: stringField(offense, "severity"),
					message: stringField(offense, "message"),
					suggestion: offense?.corrected === true ? "automatic correction available" : undefined,
				});
			}
		}
	}
	return diagnostics;
}

function parsePhpstan(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const rootValue of allJsonValues(input)) {
		const root = toRecord(rootValue);
		const files = toRecord(root?.files);
		if (files) {
			for (const fileName in files) {
				const file = toRecord(files[fileName]);
				for (const messageValue of toArray(file?.messages)) {
					const message = toRecord(messageValue);
					addDiagnostic(diagnostics, input, {
						file: fileName,
						line: numberField(message, "line"),
						code: stringField(message, "identifier"),
						severity: "error",
						message: stringField(message, "message"),
					});
				}
			}
		}
		for (const error of toArray(root?.errors)) {
			if (typeof error === "string") addDiagnostic(diagnostics, input, { severity: "error", message: error });
		}
	}
	return diagnostics;
}

function parsePsalm(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const root of allJsonValues(input)) {
		for (const value of toArray(root)) {
			const record = toRecord(value);
			const shortcode = numberField(record, "shortcode");
			addDiagnostic(diagnostics, input, {
				file: stringField(record, "file_name") ?? stringField(record, "file_path"),
				line: numberField(record, "line_from"),
				column: numberField(record, "column_from"),
				endLine: numberField(record, "line_to"),
				endColumn: numberField(record, "column_to"),
				code: stringField(record, "type") ?? (shortcode === undefined ? undefined : String(shortcode)),
				severity: stringField(record, "severity"),
				message: stringField(record, "message"),
			});
		}
	}
	return diagnostics;
}

function parseSwiftlint(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const root of allJsonValues(input)) {
		for (const value of toArray(root)) {
			const record = toRecord(value);
			addDiagnostic(diagnostics, input, {
				file: stringField(record, "file"),
				line: numberField(record, "line"),
				column: numberField(record, "character"),
				code: stringField(record, "rule_id"),
				severity: stringField(record, "severity"),
				message: stringField(record, "reason"),
			});
		}
	}
	return diagnostics;
}

function parseDart(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const line of sanitizeText(`${input.stdout}\n${input.stderr}`).split("\n")) {
		const fields = line.split("|");
		if (fields.length < 8) continue;
		addDiagnostic(diagnostics, input, {
			severity: fields[0],
			code: fields[2],
			file: fields[3],
			line: Number.parseInt(fields[4], 10),
			column: Number.parseInt(fields[5], 10),
			message: fields.slice(7).join("|"),
		});
	}
	return diagnostics;
}

function parseCredo(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const rootValue of allJsonValues(input)) {
		const root = toRecord(rootValue);
		for (const value of toArray(root?.issues)) {
			const record = toRecord(value);
			addDiagnostic(diagnostics, input, {
				file: stringField(record, "filename"),
				line: numberField(record, "line_no") ?? numberField(record, "line"),
				column: numberField(record, "column"),
				code: stringField(record, "check"),
				severity: stringField(record, "priority") ?? stringField(record, "category"),
				message: stringField(record, "message"),
			});
		}
	}
	return diagnostics;
}

function parseShellcheck(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const rootValue of allJsonValues(input)) {
		const rootRecord = toRecord(rootValue);
		const values = Array.isArray(rootValue) ? rootValue : toArray(rootRecord?.comments);
		for (const value of values) {
			const record = toRecord(value);
			const code = numberField(record, "code");
			addDiagnostic(diagnostics, input, {
				file: stringField(record, "file"),
				line: numberField(record, "line"),
				column: numberField(record, "column"),
				endLine: numberField(record, "endLine"),
				endColumn: numberField(record, "endColumn"),
				code: code === undefined ? undefined : `SC${code}`,
				severity: stringField(record, "level"),
				message: stringField(record, "message"),
				suggestion: record?.fix ? "automatic fix available" : undefined,
			});
		}
	}
	return diagnostics;
}

function parseHlint(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const root of allJsonValues(input)) {
		for (const value of toArray(root)) {
			const record = toRecord(value);
			addDiagnostic(diagnostics, input, {
				file: stringField(record, "file"),
				line: numberField(record, "startLine"),
				column: numberField(record, "startColumn"),
				endLine: numberField(record, "endLine"),
				endColumn: numberField(record, "endColumn"),
				code: stringField(record, "hint"),
				severity: stringField(record, "severity"),
				message: stringField(record, "hint") ?? stringField(record, "from"),
				suggestion: stringField(record, "to"),
			});
		}
	}
	return diagnostics;
}

function parseTerraform(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const rootValue of allJsonValues(input)) {
		const root = toRecord(rootValue);
		for (const value of toArray(root?.diagnostics)) {
			const record = toRecord(value);
			const range = nestedRecord(record, "range");
			const start = nestedRecord(range, "start");
			const end = nestedRecord(range, "end");
			const summary = stringField(record, "summary");
			const detail = stringField(record, "detail");
			addDiagnostic(diagnostics, input, {
				file: stringField(range, "filename"),
				line: numberField(start, "line"),
				column: numberField(start, "column"),
				endLine: numberField(end, "line"),
				endColumn: numberField(end, "column"),
				severity: stringField(record, "severity"),
				message: [summary, detail].filter(Boolean).join(": "),
			});
		}
	}
	return diagnostics;
}

function parseTflint(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const rootValue of allJsonValues(input)) {
		const root = toRecord(rootValue);
		for (const value of toArray(root?.issues)) {
			const record = toRecord(value);
			const rule = nestedRecord(record, "rule");
			const range = nestedRecord(record, "range");
			const start = nestedRecord(range, "start");
			const end = nestedRecord(range, "end");
			addDiagnostic(diagnostics, input, {
				file: stringField(range, "filename"),
				line: numberField(start, "line"),
				column: numberField(start, "column"),
				endLine: numberField(end, "line"),
				endColumn: numberField(end, "column"),
				code: stringField(rule, "name"),
				severity: stringField(rule, "severity"),
				message: stringField(record, "message"),
			});
		}
		for (const errorValue of toArray(root?.errors)) {
			const error = toRecord(errorValue);
			addDiagnostic(diagnostics, input, {
				severity: "error",
				message: stringField(error, "message"),
			});
		}
	}
	return diagnostics;
}

function parseActionlint(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	for (const root of allJsonValues(input)) {
		for (const value of toArray(root)) {
			const record = toRecord(value);
			addDiagnostic(diagnostics, input, {
				file: stringField(record, "filepath"),
				line: numberField(record, "line"),
				column: numberField(record, "column"),
				code: stringField(record, "kind"),
				severity: "error",
				message: stringField(record, "message"),
			});
		}
	}
	return diagnostics;
}

function parseGeneric(input: CleanseParserInput): CleanseDiagnostic[] {
	const diagnostics: CleanseDiagnostic[] = [];
	const text = sanitizeText(`${input.stdout}\n${input.stderr}`);
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const msvc =
			/^(.*?)\((\d+),(\d+)\):\s*(error|warning|info)(?:\s+([A-Za-z]+\d+))?:\s*(.*?)(?:\s+\[[^\]]+\])?$/i.exec(
				trimmed,
			);
		if (msvc) {
			addDiagnostic(diagnostics, input, {
				file: msvc[1],
				line: Number.parseInt(msvc[2], 10),
				column: Number.parseInt(msvc[3], 10),
				severity: msvc[4],
				code: msvc[5],
				message: msvc[6],
			});
			continue;
		}
		const gcc = /^(.*?):(\d+)(?::(\d+))?:\s*(error|warning|info|note)(?:\s*\[([^\]]+)\])?:\s*(.*)$/i.exec(trimmed);
		if (!gcc) continue;
		addDiagnostic(diagnostics, input, {
			file: gcc[1],
			line: Number.parseInt(gcc[2], 10),
			column: gcc[3] ? Number.parseInt(gcc[3], 10) : undefined,
			severity: gcc[4],
			code: gcc[5],
			message: gcc[6],
		});
	}
	return diagnostics;
}

function parseLocation(value: string): ParsedLocation | undefined {
	const parenthesized = /^(.*?)\((\d+),(\d+)\)$/.exec(value.trim());
	if (parenthesized) {
		return {
			file: parenthesized[1],
			line: Number.parseInt(parenthesized[2], 10),
			column: Number.parseInt(parenthesized[3], 10),
		};
	}
	const colon = /^(.*?):(\d+)(?::(\d+))?$/.exec(value.trim());
	if (!colon) return undefined;
	return {
		file: colon[1],
		line: Number.parseInt(colon[2], 10),
		column: colon[3] ? Number.parseInt(colon[3], 10) : undefined,
	};
}

function deduplicateDiagnostics(diagnostics: CleanseDiagnostic[]): CleanseDiagnostic[] {
	const seen = new Set<string>();
	const unique: CleanseDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		const key = [
			diagnostic.file ?? "",
			diagnostic.line ?? "",
			diagnostic.column ?? "",
			diagnostic.code ?? "",
			diagnostic.message,
		].join("\u0000");
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(diagnostic);
	}
	return unique;
}
