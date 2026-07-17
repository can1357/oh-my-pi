import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AssistantMessage, completeSimple } from "@pk-nerdsaver-ai/pi-ai";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { resolveModelRoleValue } from "../config/model-resolver";
import { queryTypedLspContext, type TypedLspQueryAction, type TypedLspQueryResult } from "../lsp";
import type { DocumentSymbol } from "../lsp/types";
import contextLayerCompressPrompt from "../prompts/system/context-layer-compress.md" with { type: "text" };
import type { ToolSession } from "../tools";

export type ContextEvidenceType = "lsp" | "file" | "diagnostic" | "summary" | "search" | "cache";
export type ContextConfidence = "high" | "medium" | "low";

export interface ContextRange {
	startLine: number;
	endLine: number;
}

export interface ContextEvidence {
	type: ContextEvidenceType;
	file?: string;
	range?: ContextRange;
	symbol?: string;
	detail: string;
}

export interface ContextOracleResult {
	answer: string;
	confidence: ContextConfidence;
	evidence: ContextEvidence[];
	suggestedNextReads?: string[];
	tokenEstimate?: number;
}

export interface ContextOracleOptions {
	file?: string;
	line?: number;
	symbol?: string;
	scope?: string;
	maxEvidence?: number;
	maxAnswerChars?: number;
	timeout?: number;
}

export interface ContextOracleCacheEntry<T> {
	stamp: string;
	value: T;
}

export interface ContextOracleCache {
	fileSummaries: Map<string, ContextOracleCacheEntry<ContextOracleResult>>;
	queries: Map<string, ContextOracleCacheEntry<ContextOracleResult>>;
	symbols: Map<string, ContextOracleCacheEntry<ContextOracleResult>>;
}

export function createContextOracleCache(): ContextOracleCache {
	return {
		fileSummaries: new Map<string, ContextOracleCacheEntry<ContextOracleResult>>(),
		queries: new Map<string, ContextOracleCacheEntry<ContextOracleResult>>(),
		symbols: new Map<string, ContextOracleCacheEntry<ContextOracleResult>>(),
	};
}

export interface ContextCompressionInput {
	prefix: string;
	answer: string;
	confidence: ContextConfidence;
	evidence: ContextEvidence[];
	maxOutputChars: number;
	signal?: AbortSignal;
}

export type ContextEvidenceCompressor = (input: ContextCompressionInput) => Promise<string | undefined>;

export interface ContextOracleDependencies {
	queryLsp?: typeof queryTypedLspContext;
	compressEvidence?: ContextEvidenceCompressor;
}

export class ContextOracle {
	readonly #cache: ContextOracleCache;

	constructor(
		private readonly session: ToolSession,
		private readonly dependencies: ContextOracleDependencies = {},
	) {
		this.#cache = session.contextOracleCache ?? createContextOracleCache();
	}

	async ask(query: string, options: ContextOracleOptions = {}, signal?: AbortSignal): Promise<ContextOracleResult> {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) return this.#lowConfidence("Empty query.");
		const cacheKey = JSON.stringify({ query: normalizedQuery, options });
		const stamp = await this.#scopeStamp(options.file ?? options.scope);
		const cached = this.#cacheEnabled() ? this.#cache.queries.get(cacheKey) : undefined;
		if (cached?.stamp === stamp) return this.#fromCache(cached.value);

		const lower = normalizedQuery.toLowerCase();
		let result: ContextOracleResult;
		if (options.symbol || lower.includes("symbol") || lower.includes("defined") || lower.includes("definition")) {
			result = await this.getSymbolContext(options.symbol ?? normalizedQuery, options, signal);
		} else if (lower.includes("diagnostic") || lower.includes("error") || lower.includes("warning")) {
			result = await this.getDiagnosticsContext(options.scope ?? options.file ?? "*", options, signal);
		} else if (options.file) {
			result = await this.getFileContext(options.file, options, signal);
		} else {
			result = await this.#workspaceSymbolSearch(normalizedQuery, options, signal);
		}
		const bounded = this.#bound(result, options);
		if (this.#cacheEnabled()) this.#cache.queries.set(cacheKey, { stamp, value: bounded });
		return bounded;
	}

	async getSymbolContext(
		symbol: string,
		options: ContextOracleOptions = {},
		signal?: AbortSignal,
	): Promise<ContextOracleResult> {
		const normalizedSymbol = symbol.trim();
		if (!normalizedSymbol) return this.#lowConfidence("Empty symbol.");
		const cacheKey = JSON.stringify({ symbol: normalizedSymbol, options });
		const stamp = await this.#symbolStamp(options);
		const cached = this.#cacheEnabled() ? this.#cache.symbols.get(cacheKey) : undefined;
		if (cached?.stamp === stamp) return this.#fromCache(cached.value);

		const evidence: ContextEvidence[] = [];
		if (options.file && options.line !== undefined) {
			evidence.push(...(await this.#lspEvidence("definition", { ...options, symbol: normalizedSymbol }, signal)));
			evidence.push(...(await this.#lspEvidence("references", { ...options, symbol: normalizedSymbol }, signal)));
			evidence.push(...(await this.#lspEvidence("hover", { ...options, symbol: normalizedSymbol }, signal)));
		} else {
			evidence.push(
				...(await this.#lspEvidence(
					"symbols",
					{ ...options, file: "*", symbol: normalizedSymbol, scope: normalizedSymbol },
					signal,
				)),
			);
			evidence.push(...(await this.#searchEvidence(normalizedSymbol, options)));
		}
		const result = await this.#resultFromEvidence(
			`Context for symbol "${normalizedSymbol}".`,
			evidence,
			options,
			undefined,
			signal,
		);
		if (this.#cacheEnabled()) this.#cache.symbols.set(cacheKey, { stamp, value: result });
		return result;
	}

	async getFileContext(
		filePath: string,
		options: ContextOracleOptions = {},
		signal?: AbortSignal,
	): Promise<ContextOracleResult> {
		const absolute = this.#resolve(filePath);
		const stamp = await this.#fileStamp(absolute);
		const cached = this.#cacheEnabled() ? this.#cache.fileSummaries.get(absolute) : undefined;
		if (cached?.stamp === stamp) return this.#fromCache(cached.value);

		const evidence: ContextEvidence[] = [];
		evidence.push(await this.#fileSummaryEvidence(absolute));
		evidence.push(...(await this.#lspEvidence("symbols", { ...options, file: filePath }, signal)));
		evidence.push(...(await this.#lspEvidence("diagnostics", { ...options, file: filePath }, signal)));
		const result = await this.#resultFromEvidence(
			`Compact context for ${this.#relative(absolute)}.`,
			evidence,
			options,
			undefined,
			signal,
		);
		if (this.#cacheEnabled()) this.#cache.fileSummaries.set(absolute, { stamp, value: result });
		return result;
	}

	async getDiagnosticsContext(
		scope: string,
		options: ContextOracleOptions = {},
		signal?: AbortSignal,
	): Promise<ContextOracleResult> {
		const evidence = await this.#lspEvidence("diagnostics", { ...options, file: scope }, signal);
		return await this.#resultFromEvidence(`Diagnostics for ${scope}.`, evidence, options, "diagnostic", signal);
	}

	async getEditImpact(
		target: string,
		options: ContextOracleOptions = {},
		signal?: AbortSignal,
	): Promise<ContextOracleResult> {
		const evidence: ContextEvidence[] = [];
		evidence.push(...(await this.getSymbolContext(target, options, signal)).evidence);
		if (options.file) evidence.push(...(await this.getFileContext(options.file, options, signal)).evidence);
		const result = await this.#resultFromEvidence(
			`Likely edit impact for ${target}.`,
			evidence,
			options,
			undefined,
			signal,
		);
		return {
			...result,
			suggestedNextReads: [
				...new Set(result.evidence.map(item => item.file).filter((item): item is string => Boolean(item))),
			],
		};
	}

	async #workspaceSymbolSearch(
		query: string,
		options: ContextOracleOptions,
		signal?: AbortSignal,
	): Promise<ContextOracleResult> {
		const evidence = await this.#lspEvidence("symbols", { ...options, file: "*", scope: query }, signal);
		if (evidence.length === 0) evidence.push(...(await this.#searchEvidence(query, options)));
		return await this.#resultFromEvidence(`Workspace context for "${query}".`, evidence, options, undefined, signal);
	}

	async #lspEvidence(
		action: TypedLspQueryAction,
		options: ContextOracleOptions,
		signal?: AbortSignal,
	): Promise<ContextEvidence[]> {
		if (this.session.enableLsp === false) return [];
		const queryLsp = this.dependencies.queryLsp ?? queryTypedLspContext;
		const result = await queryLsp(
			this.session.cwd,
			{
				action,
				file: options.file,
				line: options.line,
				symbol: options.symbol,
				query: options.scope ?? options.symbol,
				timeout: options.timeout ?? 5,
			},
			signal,
		);
		return this.#typedLspEvidence(result, options.symbol);
	}

	#typedLspEvidence(result: TypedLspQueryResult, symbol?: string): ContextEvidence[] {
		if (!result.success) {
			return result.error ? [{ type: "lsp", symbol, detail: `${result.action} unavailable: ${result.error}` }] : [];
		}
		const evidence: ContextEvidence[] = [];
		for (const location of result.locations ?? []) {
			const file = this.#relativeFromUri(location.uri);
			evidence.push({
				type: "lsp",
				file,
				range: { startLine: location.range.start.line + 1, endLine: location.range.end.line + 1 },
				symbol,
				detail: `${result.action}: ${file}:${location.range.start.line + 1}`,
			});
		}
		if (result.hover) {
			evidence.push({ type: "lsp", symbol, detail: `hover: ${result.hover.slice(0, 500)}` });
		}
		for (const diagnostic of result.diagnostics ?? []) {
			evidence.push({
				type: "diagnostic",
				file: diagnostic.file,
				range: {
					startLine: diagnostic.diagnostic.range.start.line + 1,
					endLine: diagnostic.diagnostic.range.end.line + 1,
				},
				detail: diagnostic.diagnostic.message.slice(0, 500),
			});
		}
		for (const workspaceSymbol of result.workspaceSymbols ?? []) {
			const file = this.#relativeFromUri(workspaceSymbol.location.uri);
			evidence.push({
				type: "lsp",
				file,
				range: {
					startLine: workspaceSymbol.location.range.start.line + 1,
					endLine: workspaceSymbol.location.range.end.line + 1,
				},
				symbol: workspaceSymbol.name,
				detail: `workspace symbol: ${workspaceSymbol.name}`,
			});
		}
		for (const documentSymbol of result.documentSymbols ?? []) {
			this.#collectDocumentSymbolEvidence(documentSymbol, evidence, symbol);
		}
		return evidence;
	}
	async #searchEvidence(query: string, options: ContextOracleOptions): Promise<ContextEvidence[]> {
		const max = options.maxEvidence ?? 8;
		const evidence: ContextEvidence[] = [];
		if (!query || query.length > 120) return evidence;
		await this.#walk(this.session.cwd, async file => {
			if (evidence.length >= max) return;
			const text = await fs.readFile(file, "utf8").catch(() => "");
			const lines = text.split(/\r?\n/);
			const lineIndex = lines.findIndex(line => line.includes(query));
			if (lineIndex >= 0) {
				evidence.push({
					type: "search",
					file: this.#relative(file),
					range: { startLine: lineIndex + 1, endLine: lineIndex + 1 },
					symbol: query,
					detail: lines[lineIndex].trim().slice(0, 240),
				});
			}
		});
		return evidence;
	}

	async #fileSummaryEvidence(absolute: string): Promise<ContextEvidence> {
		const text = await fs.readFile(absolute, "utf8");
		const lines = text.split(/\r?\n/);
		const declarations = lines
			.map((line, index) => ({ line: line.trim(), index }))
			.filter(item =>
				/^(export\s+)?(class|interface|type|function|const|let|var|enum)\s+|^(async\s+)?function\s+/.test(
					item.line,
				),
			)
			.slice(0, 20)
			.map(item => `L${item.index + 1}: ${item.line}`);
		const detail = [
			`${this.#relative(absolute)}: ${lines.length} lines, ${text.length} bytes`,
			declarations.length > 0
				? `Declarations: ${declarations.join("; ")}`
				: "No top-level declarations found by light scan.",
		].join("\n");
		return {
			type: "summary",
			file: this.#relative(absolute),
			range: { startLine: 1, endLine: Math.min(lines.length, 200) },
			detail,
		};
	}

	async #resultFromEvidence(
		prefix: string,
		evidence: ContextEvidence[],
		options: ContextOracleOptions,
		preferredType?: ContextEvidenceType,
		signal?: AbortSignal,
	): Promise<ContextOracleResult> {
		const max = options.maxEvidence ?? 12;
		const filtered = evidence
			.filter(item => !preferredType || item.type === preferredType || evidence.length <= max)
			.slice(0, max);
		if (filtered.length === 0) return this.#lowConfidence(`${prefix} No deterministic evidence found.`);
		const files = [...new Set(filtered.map(item => item.file).filter((item): item is string => Boolean(item)))];
		const deterministic = this.#bound(
			{
				answer: `${prefix} Found ${filtered.length} evidence item(s).${files.length ? ` Files: ${files.join(", ")}.` : ""}`,
				confidence: filtered.some(item => item.type === "lsp" || item.type === "diagnostic") ? "high" : "medium",
				evidence: filtered,
				suggestedNextReads: files.slice(0, 8),
				tokenEstimate: this.#estimateTokens(prefix, filtered),
			},
			options,
		);
		return await this.#compressResult(prefix, deterministic, options, signal);
	}

	#bound(result: ContextOracleResult, options: ContextOracleOptions): ContextOracleResult {
		const maxAnswerChars = options.maxAnswerChars ?? 1200;
		return {
			...result,
			answer:
				result.answer.length > maxAnswerChars ? `${result.answer.slice(0, maxAnswerChars - 1)}…` : result.answer,
			evidence: result.evidence.slice(0, options.maxEvidence ?? 12),
		};
	}

	async #compressResult(
		prefix: string,
		result: ContextOracleResult,
		options: ContextOracleOptions,
		signal?: AbortSignal,
	): Promise<ContextOracleResult> {
		const compressor = this.dependencies.compressEvidence ?? this.#compressEvidenceWithModel.bind(this);
		const compressed = await compressor({
			prefix,
			answer: result.answer,
			confidence: result.confidence,
			evidence: result.evidence,
			maxOutputChars: options.maxAnswerChars ?? 1200,
			signal,
		}).catch(() => undefined);
		if (!compressed) return result;
		const boundedAnswer =
			compressed.length > (options.maxAnswerChars ?? 1200)
				? `${compressed.slice(0, (options.maxAnswerChars ?? 1200) - 1)}…`
				: compressed;
		return {
			...result,
			answer: boundedAnswer,
			tokenEstimate: this.#estimateTokens(boundedAnswer, result.evidence),
		};
	}

	async #compressEvidenceWithModel(input: ContextCompressionInput): Promise<string | undefined> {
		const modelSelector = this.session.settings.get("contextLayer.model")?.trim();
		const modelRegistry = this.session.modelRegistry;
		if (!modelSelector || !modelRegistry) return undefined;
		const resolved = resolveModelRoleValue(modelSelector, modelRegistry.getAvailable(), {
			settings: this.session.settings,
			modelRegistry,
		});
		const model = resolved.model;
		if (!model) return undefined;
		const apiKey = await modelRegistry.getApiKey(model, this.session.getSessionId?.() ?? undefined);
		if (!apiKey) return undefined;
		const maxInputChars = Math.max(1000, this.session.settings.get("contextLayer.maxInputTokens") * 4);
		const maxOutputChars = Math.min(
			input.maxOutputChars,
			this.session.settings.get("contextLayer.maxOutputTokens") * 4,
		);
		const userPrompt = this.#buildCompressionPrompt(input, maxInputChars);
		const response = await completeSimple(
			model,
			{
				systemPrompt: [prompt.render(contextLayerCompressPrompt, { maxOutputChars })],
				messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			},
			{
				apiKey: modelRegistry.resolver(model, this.session.getSessionId?.() ?? undefined),
				maxTokens: this.session.settings.get("contextLayer.maxOutputTokens"),
				disableReasoning: true,
				signal: input.signal,
			},
		);
		if (response.stopReason === "error") return undefined;
		const text = this.#extractAssistantText(response.content);
		const answer = this.#parseCompressedAnswer(text);
		return answer && answer.length > 0 ? answer : undefined;
	}

	#buildCompressionPrompt(input: ContextCompressionInput, maxInputChars: number): string {
		const payload = JSON.stringify({
			answer: input.answer,
			confidence: input.confidence,
			evidence: input.evidence,
		});
		const boundedPayload =
			payload.length > maxInputChars ? `${payload.slice(0, Math.max(0, maxInputChars - 1))}…` : payload;
		return `Question context: ${input.prefix}\nEvidence JSON:\n${boundedPayload}`;
	}

	#extractAssistantText(content: AssistantMessage["content"]): string {
		return content
			.filter(
				(block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text",
			)
			.map(block => block.text)
			.join(" ")
			.trim();
	}

	#parseCompressedAnswer(text: string): string | undefined {
		const trimmed = text.trim();
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		try {
			const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { answer?: unknown };
			return typeof parsed.answer === "string" ? parsed.answer.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	#cacheEnabled(): boolean {
		return this.session.settings.get("contextLayer.cache") !== false;
	}

	#lowConfidence(answer: string): ContextOracleResult {
		return {
			answer,
			confidence: "low",
			evidence: [],
			suggestedNextReads: [],
			tokenEstimate: Math.ceil(answer.length / 4),
		};
	}

	#fromCache(result: ContextOracleResult): ContextOracleResult {
		return {
			...result,
			evidence: [{ type: "cache", detail: "Cache hit for unchanged context." }, ...result.evidence],
		};
	}

	#collectDocumentSymbolEvidence(
		symbolInfo: DocumentSymbol,
		evidence: ContextEvidence[],
		fallbackSymbol?: string,
	): void {
		evidence.push({
			type: "lsp",
			range: { startLine: symbolInfo.range.start.line + 1, endLine: symbolInfo.range.end.line + 1 },
			symbol: symbolInfo.name || fallbackSymbol,
			detail: `document symbol: ${symbolInfo.name}`,
		});
		for (const child of symbolInfo.children ?? []) {
			this.#collectDocumentSymbolEvidence(child, evidence, fallbackSymbol);
		}
	}

	#estimateTokens(answer: string, evidence: ContextEvidence[]): number {
		return Math.ceil((answer.length + evidence.reduce((sum, item) => sum + item.detail.length, 0)) / 4);
	}

	async #scopeStamp(scope?: string): Promise<string> {
		if (!scope || scope === "*") return `cwd:${this.session.cwd}`;
		return this.#fileStamp(this.#resolve(scope)).catch(() => `scope:${scope}`);
	}

	async #symbolStamp(options: ContextOracleOptions): Promise<string> {
		if (options.file) return this.#fileStamp(this.#resolve(options.file)).catch(() => `file:${options.file}`);
		return await this.#workspaceStamp();
	}

	async #workspaceStamp(): Promise<string> {
		let count = 0;
		let newest = 0;
		let totalSize = 0;
		await this.#walk(this.session.cwd, async file => {
			const stat = await fs.stat(file).catch(() => undefined);
			if (!stat) return;
			count += 1;
			newest = Math.max(newest, stat.mtimeMs);
			totalSize += stat.size;
		});
		return `workspace:${this.session.cwd}:${count}:${newest}:${totalSize}`;
	}

	async #fileStamp(absolute: string): Promise<string> {
		// mtime+size alone misses same-length rewrites within the filesystem's
		// timestamp granularity (two writes in the same millisecond), serving a
		// stale summary from the shared cache. A content digest closes that hole;
		// the summary path reads the file anyway, so the extra read is cheap
		// relative to the LSP/summary work a miss triggers.
		const [stat, content] = await Promise.all([fs.stat(absolute), fs.readFile(absolute)]);
		const digest = createHash("sha1").update(content).digest("hex");
		return `${absolute}:${stat.mtimeMs}:${stat.size}:${digest}`;
	}

	#resolve(filePath: string): string {
		return path.isAbsolute(filePath) ? filePath : path.resolve(this.session.cwd, filePath);
	}

	#relative(filePath: string): string {
		return path.relative(this.session.cwd, filePath).replaceAll(path.sep, "/") || ".";
	}

	#relativeFromUri(uri: string): string {
		const prefix = "file://";
		const raw = uri.startsWith(prefix) ? decodeURIComponent(uri.slice(prefix.length)) : uri;
		const windowsPath = raw.startsWith("/") && /^[A-Za-z]:/.test(raw.slice(1)) ? raw.slice(1) : raw;
		return this.#relative(windowsPath);
	}

	async #walk(dir: string, visit: (file: string) => Promise<void>): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build")
				continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await this.#walk(full, visit);
			} else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|md|rs|go|py)$/.test(entry.name)) {
				await visit(full);
			}
		}
	}
}
