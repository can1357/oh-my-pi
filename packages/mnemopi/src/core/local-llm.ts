import {
	type Api,
	type ApiKey,
	type AssistantMessage,
	completeSimple,
	type FetchImpl,
	type Model,
	retryTransientCompletion,
	withAuth,
} from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { fetchWithRetry } from "@oh-my-pi/pi-utils";
import { type CompleteOptions, callHostLlm, getHostLlmBackend } from "./llm-backends";
import {
	getMnemopiRuntimeOptions,
	isPiAiModel,
	type MnemopiLlmCompleteOptions,
	type MnemopiLlmCompletion,
} from "./runtime-options";

const ENV_MODEL_REPO = process.env.MNEMOPI_LLM_REPO ?? "";
export interface RemoteLlmOptions {
	fetch?: FetchImpl;
}

const ENV_MODEL_FILE = process.env.MNEMOPI_LLM_FILE ?? "";
export const DEFAULT_MODEL_REPO =
	ENV_MODEL_REPO !== "" && ENV_MODEL_FILE !== "" ? ENV_MODEL_REPO : "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF";
export const DEFAULT_MODEL_FILE =
	ENV_MODEL_REPO !== "" && ENV_MODEL_FILE !== "" ? ENV_MODEL_FILE : "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";

const TRUE_VALUES: Record<string, true> = { "1": true, true: true, yes: true, on: true };

function env(name: string): string {
	return process.env[name] ?? "";
}

function activeLlmOptions() {
	return getMnemopiRuntimeOptions()?.llm;
}

function activeCustomCompletion(): MnemopiLlmCompletion | undefined {
	return activeLlmOptions()?.complete;
}

function activePiAiModel(): Model<Api> | undefined {
	const model = activeLlmOptions()?.model;
	return isPiAiModel(model) ? model : undefined;
}

function envBool(name: string, defaultValue: boolean): boolean {
	const value = env(name).trim().toLowerCase();
	return value === "" ? defaultValue : TRUE_VALUES[value] === true;
}

function envInt(name: string, defaultValue: number): number {
	const parsed = Number.parseInt(env(name), 10);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

function stripTrailingSlash(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) {
		end -= 1;
	}
	return end === value.length ? value : value.slice(0, end);
}

function llmEnabled(): boolean {
	const active = activeLlmOptions();
	if (active?.enabled !== undefined) {
		return active.enabled;
	}
	if (activeCustomCompletion() !== undefined || activePiAiModel() !== undefined) {
		return true;
	}
	return envBool("MNEMOPI_LLM_ENABLED", true);
}

function llmMaxTokens(): number {
	const active = activeLlmOptions();
	if (active?.maxTokens !== undefined) {
		return active.maxTokens;
	}
	return envInt("MNEMOPI_LLM_MAX_TOKENS", 2048);
}

function llmContextTokens(): number {
	return envInt("MNEMOPI_LLM_N_CTX", 2048);
}

function hostLlmEnabled(): boolean {
	if (activeCustomCompletion() !== undefined || activePiAiModel() !== undefined) {
		return false;
	}
	const active = activeLlmOptions();
	if (active?.baseUrl !== undefined || (typeof active?.model === "string" && active.model !== "")) {
		return false;
	}
	return envBool("MNEMOPI_HOST_LLM_ENABLED", false);
}

function hostLlmContextTokens(): number {
	return envInt("MNEMOPI_HOST_LLM_N_CTX", 32000);
}

function llmBaseUrl(): string {
	const active = activeLlmOptions();
	if (active?.baseUrl !== undefined) {
		return stripTrailingSlash(active.baseUrl);
	}
	return stripTrailingSlash(env("MNEMOPI_LLM_BASE_URL"));
}

function llmModelName(): string {
	const model = activeLlmOptions()?.model;
	if (typeof model === "string") {
		return model;
	}
	return env("MNEMOPI_LLM_MODEL") || "local";
}

function llmApiKey(): ApiKey {
	const active = activeLlmOptions();
	if (active?.apiKey !== undefined) {
		return active.apiKey;
	}
	return env("MNEMOPI_LLM_API_KEY");
}

function sleepPrompt(): string {
	return env("MNEMOPI_SLEEP_PROMPT").trim();
}

function memoryLines(memories: readonly string[]): string {
	return memories
		.filter(Boolean)
		.map(memory => `- ${memory}`)
		.join("\n");
}

function formatSleepPrompt(memories: readonly string[], source = ""): string | null {
	const override = getMnemopiRuntimeOptions()?.llm?.consolidationPrompt;
	const template = override !== undefined && override !== "" ? override : sleepPrompt();
	if (template === "") {
		return null;
	}

	let rendered = template;
	rendered = rendered.split("{source}").join(source);
	rendered = rendered.split("{memories}").join(memoryLines(memories));
	rendered = rendered.split("{memory_count}").join(String(memories.filter(Boolean).length));
	return rendered;
}

export function buildPrompt(memories: readonly string[], source = ""): string {
	const custom = formatSleepPrompt(memories, source);
	if (custom !== null) {
		return custom;
	}

	let header =
		"Summarize the following memories into 1-3 concise sentences. Preserve facts, names, preferences, and decisions. Discard fluff.";
	if (source !== "") {
		header += ` Source: ${source}.`;
	}
	return `/no_think\n${header}\n\n${memoryLines(memories)}\n\nSummary:`;
}

export async function callConfiguredCompletion(
	prompt: string,
	temperature: number,
	opts: MnemopiLlmCompleteOptions = {},
): Promise<string | null> {
	const completion = activeCustomCompletion();
	if (completion !== undefined) {
		const raw = await completion(prompt, {
			maxTokens: opts.maxTokens ?? llmMaxTokens(),
			temperature,
			timeout: opts.timeout,
			provider: opts.provider,
			model: opts.model,
			task: opts.task,
		});
		return typeof raw === "string" ? raw : null;
	}
	const model = activePiAiModel();
	if (model === undefined) {
		return null;
	}
	try {
		const message = await retryTransientCompletion(() =>
			completeSimple(
				model,
				{
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				},
				{
					apiKey: llmApiKey() || undefined,
					maxTokens: opts.maxTokens ?? llmMaxTokens(),
					temperature,
				},
			),
		);
		return assistantText(message).trim() || null;
	} catch {
		return null;
	}
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

export function buildHostPrompt(memories: readonly string[], source = ""): string {
	const custom = formatSleepPrompt(memories, source);
	if (custom !== null) {
		return custom;
	}

	let header =
		"Summarize the following memories into 1-3 concise sentences. Preserve facts, names, preferences, and decisions. Discard fluff.";
	if (source !== "") {
		header += ` Source: ${source}.`;
	}
	return `${header}\n\n${memoryLines(memories)}`;
}

function hostBackendWillHandleCall(): boolean {
	return llmEnabled() && hostLlmEnabled() && getHostLlmBackend() !== null;
}

export function configuredLlmWillHandleCall(): boolean {
	return llmEnabled() && (activeCustomCompletion() !== undefined || activePiAiModel() !== undefined);
}

async function tryHostLlm(prompt: string, maxTokens: number, temperature: number): Promise<[boolean, string | null]> {
	if (!hostBackendWillHandleCall()) {
		return [false, null];
	}

	const raw = await callHostLlm(prompt, {
		maxTokens,
		temperature,
		timeout: 15,
		provider: env("MNEMOPI_HOST_LLM_PROVIDER").trim() || null,
		model: env("MNEMOPI_HOST_LLM_MODEL").trim() || null,
	});
	const text = typeof raw === "string" ? raw.trim() : "";
	return [true, text === "" ? null : text];
}

export function cleanOutput(text: string): string {
	return text
		.replaceAll("<|assistant|>", "")
		.replaceAll("<|user|>", "")
		.replaceAll("</s>", "")
		.trim()
		.replace(/^(?:\s*<think>[\s\S]*?<\/think>)+\s*/i, "")
		.replace(/^(Summarize the following memories.*?[.!?:]\s*)/is, "")
		.replace(/^(Preserve facts.*?[.!?:]\s*)/is, "")
		.replace(/^Source:.*?\n/im, "")
		.replace(/^\s*[-*]\s.*\n/gm, "")
		.trim();
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.floor(text.length / 4));
}

function promptTokenBudget(): number {
	const overhead = 80;
	const nCtx = hostBackendWillHandleCall() ? hostLlmContextTokens() : llmContextTokens();
	const outputReserve = Math.min(llmMaxTokens(), Math.max(128, Math.floor(nCtx / 4)));
	const safetyMargin = Math.floor(nCtx * 0.2);
	return Math.max(64, nCtx - overhead - outputReserve - safetyMargin);
}

export function chunkMemoriesByBudget(memories: readonly string[], source = ""): string[][] {
	if (memories.length === 0) {
		return [];
	}

	const budget = promptTokenBudget();
	const chunks: string[][] = [];
	let currentChunk: string[] = [];
	let currentTokens = 0;

	let header =
		"Summarize the following memories into 1-3 concise sentences. Preserve facts, names, preferences, and decisions. Discard fluff.";
	if (source !== "") {
		header += ` Source: ${source}.`;
	}
	const headerTokens = estimateTokens(`${header}\n\n`);
	const formatOverhead = estimateTokens("- \n");
	const available = budget - headerTokens;

	for (const memory of memories) {
		const memTokens = estimateTokens(memory) + formatOverhead;
		if (memTokens > budget) {
			continue;
		}
		if (currentTokens + memTokens > available && currentChunk.length > 0) {
			chunks.push(currentChunk);
			currentChunk = [];
			currentTokens = 0;
		}
		currentChunk.push(memory);
		currentTokens += memTokens;
	}

	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}
	return chunks;
}

export function llmAvailable(): boolean {
	if (configuredLlmWillHandleCall()) {
		return true;
	}
	if (hostBackendWillHandleCall()) {
		return true;
	}
	return llmEnabled() && llmBaseUrl() !== "";
}

export async function callRemoteLlm(
	prompt: string,
	temperature = 0.3,
	options: RemoteLlmOptions = {},
): Promise<string | null> {
	const baseUrl = llmBaseUrl();
	if (baseUrl === "") {
		return null;
	}

	const body = JSON.stringify({
		model: llmModelName(),
		messages: [{ role: "user", content: prompt }],
		max_tokens: llmMaxTokens(),
		temperature,
		stop: ["</s>", "<|user|>"],
	});
	const fetchImpl = options.fetch ?? fetch;
	try {
		// withAuth re-resolves the key on 401 (force-refresh, then sibling
		// rotation) when the configured key is a resolver. An empty static key
		// attempts without an Authorization header (local/proxy setups).
		const response = await withAuth(llmApiKey(), async key => {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (key !== "") {
				headers.Authorization = `Bearer ${key}`;
			}
			const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(60000),
				fetch: fetchImpl,
			});
			if (res.status === 401) {
				throw new ProviderHttpError("mnemopi remote LLM request unauthorized (401)", 401, { headers: res.headers });
			}
			return res;
		});
		if (!response.ok) {
			return null;
		}
		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: unknown } }>;
		};
		const content = data.choices?.[0]?.message?.content;
		return typeof content === "string" ? content : null;
	} catch {
		return null;
	}
}

export function localGgufAvailable(): false {
	return false;
}

export async function callLocalLlm(_prompt: string): Promise<string | null> {
	return null;
}

async function summarizeChunk(
	memories: readonly string[],
	source = "",
	options: RemoteLlmOptions = {},
): Promise<string | null> {
	const hostPrompt = buildHostPrompt(memories, source);
	const prompt = buildPrompt(memories, source);
	if (configuredLlmWillHandleCall()) {
		const raw = await callConfiguredCompletion(hostPrompt, 0.3, { maxTokens: llmMaxTokens() });
		if (raw === null) {
			return null;
		}
		const cleaned = cleanOutput(raw);
		return cleaned === "" ? null : cleaned;
	}
	const [attempted, hostText] = await tryHostLlm(hostPrompt, llmMaxTokens(), 0.3);
	if (attempted) {
		if (hostText !== null) {
			return hostText;
		}
		const raw = await callLocalLlm(prompt);
		if (raw !== null) {
			const cleaned = cleanOutput(raw);
			return cleaned === "" ? null : cleaned;
		}
		return null;
	}

	if (llmEnabled() && llmBaseUrl() !== "" && !envBool("MNEMOPI_FORCE_LOCAL", false)) {
		const raw = await callRemoteLlm(prompt, 0.3, options);
		if (raw !== null) {
			const cleaned = cleanOutput(raw);
			return cleaned === "" ? null : cleaned;
		}
	}

	const raw = await callLocalLlm(prompt);
	if (raw !== null) {
		const cleaned = cleanOutput(raw);
		return cleaned === "" ? null : cleaned;
	}
	return null;
}

export async function summarizeMemories(
	memories: readonly string[],
	source = "",
	options: RemoteLlmOptions = {},
): Promise<string | null> {
	if (memories.length === 0) {
		return null;
	}

	const chunks = chunkMemoriesByBudget(memories, source);
	const chunkSummaries: string[] = [];
	for (const chunk of chunks) {
		const summary = await summarizeChunk(chunk, source, options);
		if (summary !== null) {
			chunkSummaries.push(summary);
		}
	}

	if (chunkSummaries.length === 0) {
		return null;
	}
	if (chunkSummaries.length > 1) {
		const final = await summarizeChunk(chunkSummaries, `${source} [chunked ${chunks.length} parts]`, options);
		return final ?? chunkSummaries[0] ?? null;
	}
	return chunkSummaries[0] ?? null;
}

export async function complete(
	prompt: string,
	temperature = 0.3,
	options: CompleteOptions = {},
): Promise<string | null> {
	if (configuredLlmWillHandleCall()) {
		const raw = await callConfiguredCompletion(prompt, temperature, { maxTokens: llmMaxTokens() });
		return raw === null ? null : cleanOutput(raw) || null;
	}
	const [attempted, hostText] = await tryHostLlm(prompt, llmMaxTokens(), temperature);
	if (attempted) {
		return hostText;
	}
	if (llmEnabled() && llmBaseUrl() !== "" && !envBool("MNEMOPI_FORCE_LOCAL", false)) {
		const remote = await callRemoteLlm(prompt, temperature, options);
		return remote === null ? null : cleanOutput(remote) || null;
	}
	return callLocalLlm(prompt);
}
