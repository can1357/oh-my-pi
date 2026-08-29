import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, ApiKey, AssistantMessage, Message, Model, ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import { completeSimple } from "@pk-nerdsaver-ai/pi-ai";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import fileObserverSystemPrompt from "../../commit/prompts/file-observer-system.md" with { type: "text" };
import fileObserverUserPrompt from "../../commit/prompts/file-observer-user.md" with { type: "text" };
import type { FileDiff, FileObservation } from "../../commit/types";
import { isExcludedFile } from "../../commit/utils/exclusions";
import { toReasoningEffort } from "../../thinking";
import { truncateToTokenLimit } from "./utils";

const MAX_FILE_TOKENS = 50_000;
const MAX_CONTEXT_FILES = 20;
const MAX_CONCURRENCY = 5;
const MAP_PHASE_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000;

export interface MapPhaseInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	files: FileDiff[];
	config?: {
		maxFileTokens?: number;
		maxConcurrency?: number;
		timeoutMs?: number;
		maxRetries?: number;
		retryBackoffMs?: number;
	};
}

export async function runMapPhase({
	model,
	apiKey,
	thinkingLevel,
	serviceTier,
	files,
	config,
}: MapPhaseInput): Promise<FileObservation[]> {
	const filtered = files.filter(file => !isExcludedFile(file.filename));
	const systemPrompt = prompt.render(fileObserverSystemPrompt);
	const maxFileTokens = config?.maxFileTokens ?? MAX_FILE_TOKENS;
	const maxConcurrency = config?.maxConcurrency ?? MAX_CONCURRENCY;
	const timeoutMs = config?.timeoutMs ?? MAP_PHASE_TIMEOUT_MS;
	const maxRetries = config?.maxRetries ?? MAX_RETRIES;
	const retryBackoffMs = config?.retryBackoffMs ?? RETRY_BACKOFF_MS;
	return runWithConcurrency(filtered, maxConcurrency, async file => {
		if (file.isBinary) {
			return {
				file: file.filename,
				observations: ["Binary file changed."],
				additions: file.additions,
				deletions: file.deletions,
			};
		}

		const contextHeader = generateContextHeader(filtered, file.filename);
		const truncated = truncateToTokenLimit(file.content, maxFileTokens);
		const userContent = prompt.render(fileObserverUserPrompt, {
			filename: file.filename,
			diff: truncated,
			context_header: contextHeader,
		});
		const request = {
			systemPrompt: [systemPrompt],
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }] as Message[],
		};

		const response = await withRetry(
			() =>
				completeSimple(model, request, {
					apiKey,
					maxTokens: 400,
					reasoning: toReasoningEffort(thinkingLevel),
					serviceTier,
					signal: AbortSignal.timeout(timeoutMs),
				}),
			maxRetries,
			retryBackoffMs,
		);

		const observations = parseObservations(response);
		return {
			file: file.filename,
			observations,
			additions: file.additions,
			deletions: file.deletions,
		};
	});
}

function parseObservations(message: AssistantMessage): string[] {
	const text = message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();

	if (!text) return [];

	const lines = text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => line.replace(/^[-*]\s+/, ""))
		.filter(Boolean);

	return lines.slice(0, 5);
}

function generateContextHeader(files: FileDiff[], currentFile: string): string {
	if (files.length > 100) {
		return `(Large commit with ${files.length} total files)`;
	}

	const otherFiles = files.filter(file => file.filename !== currentFile);
	if (otherFiles.length === 0) return "";

	const sorted = [...otherFiles].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
	const toShow = sorted.length > MAX_CONTEXT_FILES ? sorted.slice(0, MAX_CONTEXT_FILES) : sorted;

	const lines = ["OTHER FILES IN THIS CHANGE:"];
	for (const file of toShow) {
		const lineCount = file.additions + file.deletions;
		const description = inferFileDescription(file);
		lines.push(`- ${file.filename} (${lineCount} lines): ${description}`);
	}

	if (toShow.length < sorted.length) {
		lines.push(`[…${sorted.length - toShow.length} files elided…]`);
	}

	return lines.join("\n");
}

function inferFileDescription(file: FileDiff): string {
	const filenameLower = file.filename.toLowerCase();
	if (filenameLower.includes("test")) return "test file";
	if (filenameLower.endsWith(".md")) return "documentation";
	if (
		filenameLower.includes("config") ||
		filenameLower.endsWith(".toml") ||
		filenameLower.endsWith(".yaml") ||
		filenameLower.endsWith(".yml")
	) {
		return "configuration";
	}
	if (filenameLower.includes("error")) return "error definitions";
	if (filenameLower.includes("type")) return "type definitions";
	if (filenameLower.endsWith("mod.rs") || filenameLower.endsWith("lib.rs")) return "module exports";
	if (filenameLower.endsWith("main.rs") || filenameLower.endsWith("main.go") || filenameLower.endsWith("main.py")) {
		return "entry point";
	}

	const content = file.content;
	if (content.includes("interface ") || content.includes("type ")) return "type definitions";
	if (content.includes("class ") || content.includes("function ") || content.includes("fn ")) return "implementation";
	if (content.includes("async ") || content.includes("await")) return "async code";
	return "source code";
}

async function runWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const current = nextIndex;
			nextIndex += 1;
			if (current >= items.length) return;
			results[current] = await worker(items[current] as T, current);
		}
	});
	await Promise.all(runners);
	return results;
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number, backoffMs: number): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt < attempts - 1) {
				await Bun.sleep(backoffMs * (attempt + 1));
			}
		}
	}
	throw lastError;
}
