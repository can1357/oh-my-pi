import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { completeSimple, Effort, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { prompt, withFileLock } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { truncateApproxTokens } from "../mnemopi/config";
import consolidateInputTemplate from "../prompts/memories/sharpshooter-consolidate-input.md" with { type: "text" };
import consolidateSystemTemplate from "../prompts/memories/sharpshooter-consolidate-system.md" with { type: "text" };
import { resolveSharpshooterModel } from "./extract";
import {
	readSharpshooterState,
	sharpshooterBankDir,
	sharpshooterLockPath,
	sharpshooterMemoryFilePath,
	writeSharpshooterState,
} from "./paths";
import { consumeSharpshooterDeltas, listSharpshooterDeltas, type SharpshooterSessionDeltas } from "./queue";
import {
	SHARPSHOOTER_MAX_FILE_LINES,
	SHARPSHOOTER_MEMORY_FILES,
	type SharpshooterMemoryFile,
	type SharpshooterState,
} from "./types";

const DEFAULT_INTERVAL_MINUTES = 5;
const PROJECT_DOC_TOKEN_LIMIT = 6000;

const replaceMemoryFilesTool = {
	name: "replace_memory_files",
	description: "Replace complete sharpshooter memory files after consolidating queued decision deltas.",
	parameters: type({
		files: type({
			name: "'architecture.md' | 'product.md' | 'style.md'",
			content: "string",
		}).array(),
	}),
};

export interface SharpshooterConsolidationResult {
	ran: boolean;
	reason?: "not_due" | "locked" | "empty" | "no_model" | "error";
	sessions?: number;
	deltas?: number;
	error?: string;
}

interface ReplacementFile {
	name: SharpshooterMemoryFile;
	content: string;
}

export function renderSharpshooterSessions(groups: readonly SharpshooterSessionDeltas[]): string {
	return [...groups]
		.sort((a, b) => (a.deltas[0]?.delta.ts ?? 0) - (b.deltas[0]?.delta.ts ?? 0))
		.map(group => {
			const lines = [...group.deltas]
				.sort((a, b) => a.delta.ts - b.delta.ts)
				.map(({ delta }) => {
					const fields = [
						`kind=${delta.kind}`,
						`statement=${JSON.stringify(delta.statement)}`,
						`evidence=${JSON.stringify(delta.evidence)}`,
						`source=${delta.source}`,
						`friction(corrective=${delta.friction.corrective}, regression=${delta.friction.regression}, subtle=${delta.friction.subtle})`,
					];
					if (delta.rejectedAlternative) {
						fields.push(`rejectedAlternative=${JSON.stringify(delta.rejectedAlternative)}`);
					}
					if (delta.rationale) fields.push(`rationale=${JSON.stringify(delta.rationale)}`);
					return `- ${fields.join("; ")}`;
				});
			return [`### session ${group.sessionId}`, ...lines].join("\n");
		})
		.join("\n\n");
}

export async function runSharpshooterConsolidation(options: {
	agentDir: string;
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionId: string;
	force?: boolean;
}): Promise<SharpshooterConsolidationResult> {
	const bankDir = sharpshooterBankDir(options.agentDir, options.cwd);
	try {
		await fs.mkdir(bankDir, { recursive: true });
	} catch (error) {
		return { ran: false, reason: "error", error: errorMessage(error) };
	}

	let acquired = false;
	try {
		return await withFileLock(
			sharpshooterLockPath(options.agentDir, options.cwd),
			async () => {
				acquired = true;
				return await consolidateLocked(options, bankDir);
			},
			{ retries: 1, retryDelayMs: 1 },
		);
	} catch (error) {
		if (!acquired) return { ran: false, reason: "locked" };
		return { ran: false, reason: "error", error: errorMessage(error) };
	}
}

async function consolidateLocked(
	options: {
		agentDir: string;
		cwd: string;
		settings: Settings;
		modelRegistry: ModelRegistry;
		sessionId: string;
		force?: boolean;
	},
	bankDir: string,
): Promise<SharpshooterConsolidationResult> {
	const state = await readSharpshooterState(options.agentDir, options.cwd);
	try {
		const intervalMinutes = options.settings.get("sharpshooter.intervalMinutes") ?? DEFAULT_INTERVAL_MINUTES;
		if (!options.force && Date.now() - state.lastConsolidatedAt < intervalMinutes * 60_000) {
			return { ran: false, reason: "not_due" };
		}

		const groups = await listSharpshooterDeltas(options.agentDir, options.cwd);
		if (groups.length === 0) {
			await writeSharpshooterState(options.agentDir, options.cwd, {
				...state,
				lastConsolidatedAt: Date.now(),
			});
			return { ran: false, reason: "empty" };
		}

		const model = await resolveSharpshooterModel(options.settings, options.modelRegistry);
		if (!model) return { ran: false, reason: "no_model" };

		const currentFiles = await readCurrentMemoryFiles(options.agentDir, options.cwd);
		const projectDocs = await readProjectDocs(options.cwd);
		const sessions = renderSharpshooterSessions(groups);
		const input = prompt.render(consolidateInputTemplate, {
			architecture: currentFiles["architecture.md"],
			product: currentFiles["product.md"],
			style: currentFiles["style.md"],
			projectDocs,
			sessions,
		});
		const system = prompt.render(consolidateSystemTemplate, {
			maxFileLines: SHARPSHOOTER_MAX_FILE_LINES,
		});

		const response = await retryTransientCompletion(() =>
			completeSimple(
				model,
				{
					systemPrompt: [system],
					messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
					tools: [replaceMemoryFilesTool],
				},
				{
					apiKey: options.modelRegistry.resolver(model, options.sessionId),
					sessionId: options.sessionId,
					maxTokens: 8192,
					reasoning: clampThinkingLevelForModel(model, Effort.Medium),
					toolChoice: "required",
				},
			),
		);
		if (response.stopReason === "error") {
			throw new Error(response.errorMessage || "sharpshooter consolidation model error");
		}

		const files = parseReplacementFiles(response.content, currentFiles);
		await applyReplacementFiles(bankDir, files);

		const consumedFiles = groups.flatMap(group => group.deltas.map(item => item.file));
		const deltaCount = consumedFiles.length;
		await consumeSharpshooterDeltas(consumedFiles);
		const at = Date.now();
		await writeSharpshooterState(options.agentDir, options.cwd, {
			v: 1,
			lastConsolidatedAt: at,
			lastResult: {
				at,
				sessions: groups.length,
				deltas: deltaCount,
				model: model.id,
			},
		});
		return { ran: true, sessions: groups.length, deltas: deltaCount };
	} catch (error) {
		const message = errorMessage(error);
		await recordConsolidationError(options.agentDir, options.cwd, state, message);
		return { ran: false, reason: "error", error: message };
	}
}

async function readCurrentMemoryFiles(agentDir: string, cwd: string): Promise<Record<SharpshooterMemoryFile, string>> {
	const files: Record<SharpshooterMemoryFile, string> = {
		"architecture.md": "",
		"product.md": "",
		"style.md": "",
	};
	await Promise.all(
		SHARPSHOOTER_MEMORY_FILES.map(async name => {
			files[name] = await Bun.file(sharpshooterMemoryFilePath(agentDir, cwd, name))
				.text()
				.catch(() => "");
		}),
	);
	return files;
}

async function readProjectDocs(cwd: string): Promise<string> {
	const blocks: string[] = [];
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const content = await Bun.file(path.join(cwd, name))
			.text()
			.catch(() => "");
		if (content.trim()) blocks.push(`--- ${name} ---\n${content.trim()}`);
	}
	return truncateApproxTokens(blocks.join("\n\n"), PROJECT_DOC_TOKEN_LIMIT);
}

function parseReplacementFiles(
	content: readonly unknown[],
	currentFiles: Readonly<Record<SharpshooterMemoryFile, string>>,
): ReplacementFile[] {
	const toolCalls = content.filter(
		(block): block is { type: "toolCall"; name: string; arguments: unknown } =>
			typeof block === "object" && block !== null && "type" in block && block.type === "toolCall",
	);
	if (toolCalls.length !== 1 || toolCalls[0]?.name !== replaceMemoryFilesTool.name) {
		throw new Error("sharpshooter consolidation must call replace_memory_files exactly once");
	}

	const args = toolCalls[0].arguments;
	if (!args || typeof args !== "object" || !("files" in args) || !Array.isArray(args.files)) {
		throw new Error("replace_memory_files requires a files array");
	}

	const seen = new Set<SharpshooterMemoryFile>();
	const files: ReplacementFile[] = [];
	for (const item of args.files) {
		if (!item || typeof item !== "object" || !("name" in item) || !("content" in item)) {
			throw new Error("replace_memory_files contains an invalid file entry");
		}
		const name = item.name;
		const rawContent = item.content;
		if (!isMemoryFileName(name) || typeof rawContent !== "string") {
			throw new Error("replace_memory_files contains an invalid file entry");
		}
		if (seen.has(name)) throw new Error(`replace_memory_files contains duplicate ${name}`);
		seen.add(name);
		const redacted = redactSecrets(rawContent);
		let lines = redacted.length > 0 ? 1 : 0;
		for (let index = 0; index + 1 < redacted.length; index++) {
			if (redacted.charCodeAt(index) === 10) lines += 1;
		}
		if (lines > SHARPSHOOTER_MAX_FILE_LINES) {
			throw new Error(`${name} exceeds the ${SHARPSHOOTER_MAX_FILE_LINES}-line limit`);
		}
		files.push({ name, content: redacted });
	}
	const totalChars = files.reduce((sum, file) => sum + file.content.trim().length, 0);
	if (totalChars === 0 && SHARPSHOOTER_MEMORY_FILES.some(name => currentFiles[name].trim().length > 0)) {
		throw new Error("replace_memory_files returned all-empty content; refusing to wipe memory files");
	}
	return files;
}

function isMemoryFileName(value: unknown): value is SharpshooterMemoryFile {
	return typeof value === "string" && (SHARPSHOOTER_MEMORY_FILES as readonly string[]).includes(value);
}

async function applyReplacementFiles(bankDir: string, files: readonly ReplacementFile[]): Promise<void> {
	const staged = files.map(file => ({
		...file,
		tempPath: path.join(bankDir, `.${file.name}.${process.pid}.${crypto.randomUUID()}.tmp`),
	}));
	try {
		await Promise.all(staged.map(file => Bun.write(file.tempPath, file.content)));
		for (const file of staged) await fs.rename(file.tempPath, path.join(bankDir, file.name));
	} finally {
		await Promise.all(staged.map(file => fs.rm(file.tempPath, { force: true }).catch(() => {})));
	}
}

async function recordConsolidationError(
	agentDir: string,
	cwd: string,
	state: SharpshooterState,
	message: string,
): Promise<void> {
	try {
		await writeSharpshooterState(agentDir, cwd, {
			...state,
			lastError: { at: Date.now(), message },
		});
	} catch {
		// The original consolidation error is more actionable than a secondary state-write failure.
	}
}

function redactSecrets(input: string): string {
	let out = input;
	const patterns = [
		/(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/g,
		/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
		/(?:AKIA|ASIA)[A-Z0-9]{16}/g,
		/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
		/github_pat_[A-Za-z0-9_]{20,}/g,
		/npm_[A-Za-z0-9]{30,}/g,
		/xox[baprs]-[A-Za-z0-9-]{10,}/g,
		/AIza[A-Za-z0-9_-]{30,}/g,
	];
	for (const pattern of patterns) out = out.replace(pattern, "[REDACTED]");
	return out;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
