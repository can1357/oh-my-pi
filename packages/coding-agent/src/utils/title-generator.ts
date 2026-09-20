/**
 * Generate session titles using a smol, fast model.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as path from "node:path";

import {
	type Api,
	type AssistantMessage,
	completeSimple,
	type Message,
	type Model,
	retryTransientCompletion,
} from "@oh-my-pi/pi-ai";
import { StreamMarkupHealing } from "@oh-my-pi/pi-ai/utils/stream-markup-healing";
import { writeThroughActiveTerminal } from "@oh-my-pi/pi-tui";
import { SPINNER_FRAMES } from "@oh-my-pi/pi-tui/theme/symbols";
import { $env, isTerminalHeadless, isWsl, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";

import { roleCandidatePool } from "../config/model-roles";
import { formatModelStringWithRouting } from "../config/model-resolver";
import { collectOnlineTinyCandidates, expandOnlineTinyModelFallbacks } from "../tiny/online-candidates";
import type { Settings } from "../config/settings";
import titleMarkerInstruction from "../prompts/system/title-marker-instruction.md" with { type: "text" };
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import { formatTitleUserMessage } from "../tiny/message-preproc";
import { isLowSignalTitleInput, normalizeGeneratedTitle } from "../tiny/text";
import { tinyTitleClient } from "../tiny/title-client";

const TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);
const TITLE_MARKER_INSTRUCTION = prompt.render(titleMarkerInstruction);

// Plain π, not the nerd-font `icon.omp` glyph: window/tab titles render in the
// OS UI font, which has no nerd-font PUA coverage.
const DEFAULT_TERMINAL_TITLE = "π";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * Emit a raw title escape sequence. While the TUI owns stdout its frames are
 * written by an off-thread pump, and a direct `process.stdout.write` can land
 * mid-frame — inside a torn escape sequence — making the terminal print the
 * title payload as text into the viewport. Route through the active terminal's
 * write path; fall back to stdout only when no TUI has the terminal.
 */
function writeTitleSequence(seq: string): void {
	if (!writeThroughActiveTerminal(seq)) process.stdout.write(seq);
}

interface WindowsConsoleTitleApi {
	set(title: string): boolean;
	close(): void;
}

let windowsConsoleTitleApi: WindowsConsoleTitleApi | null | undefined;
let lastTerminalTitle: string | undefined;

function getWindowsConsoleTitleApi(): WindowsConsoleTitleApi | null {
	if (process.platform !== "win32") return null;
	if (windowsConsoleTitleApi !== undefined) return windowsConsoleTitleApi;
	try {
		const kernel32 = dlopen("kernel32.dll", {
			SetConsoleTitleW: { args: [FFIType.ptr], returns: FFIType.bool },
		});
		windowsConsoleTitleApi = {
			set(title) {
				const wideTitle = Buffer.from(`${title}\0`, "utf16le");
				return kernel32.symbols.SetConsoleTitleW(ptr(wideTitle));
			},
			close: () => kernel32.close(),
		};
	} catch {
		windowsConsoleTitleApi = null;
	}
	return windowsConsoleTitleApi;
}

function setWindowsConsoleTitle(title: string): boolean {
	const api = getWindowsConsoleTitleApi();
	if (!api) return false;
	try {
		return api.set(title);
	} catch {
		try {
			api.close();
		} catch {
			// Ignore cleanup failures after the native title path has already failed.
		}
		windowsConsoleTitleApi = null;
		return false;
	}
}

function disposeWindowsConsoleTitleApi(): void {
	try {
		windowsConsoleTitleApi?.close();
	} catch {
		// Terminal teardown must remain best-effort.
	}
	windowsConsoleTitleApi = undefined;
}

// Cover the "backend ignores `disableReasoning`" case unconditionally: the
// static `model.reasoning` catalog flag can't distinguish a thinking model that
// was declared with `reasoning: false` (e.g. Qwen3 served locally via llama.cpp,
// whose bundled jinja chat template forces `enable_thinking: true`) from one
// that never emits thinking. `maxTokens` is a hard cap, not a target — the
// happy-path completion still returns in a handful of tokens, so raising the
// ceiling costs nothing when thinking is genuinely suppressed and keeps the
// `<title>` marker output reachable when it isn't (issue #4355).
const TITLE_MAX_TOKENS = 1024;

/** Matches the title the model wraps in `<title>...</title>`. */
const TITLE_MARKER_GLOBAL_RE = /<title>([\s\S]*?)<\/title>|<title\s*\/>|<title>\s*$/gi;
const TITLE_VISIBILITY_SENTINEL = "\uE000omp-title-visible\uE000";
const THINKING_TAG_ENVELOPE_RE = /<(think|thinking|reasoning)>\s*[\s\S]*?<\/\1>/gi;
const THINKING_FENCE_ENVELOPE_RE = /```(?:thinking|reasoning)\b[\s\S]*?```/gi;
const LEADING_THINKING_TAG_RE = /^\s*<(think|thinking|reasoning)>\s*[\s\S]*?<\/\1>\s*/i;
const LEADING_THINKING_FENCE_RE = /^\s*```(?:thinking|reasoning)\b[\s\S]*?```\s*/i;
const LEADING_PROSE_THINKING_PREAMBLE_RE =
	/^[ \t]*(?:(?:here(?:['’]s| is)[ \t]+(?:a|the|my)[ \t]+)|my[ \t]+)?(?:thinking|thought|reasoning)[ \t]+process[ \t]*:?[ \t]*(?:\r?\n|$)/i;

function getTitleModels(registry: ModelRegistry, settings: Settings, currentModel?: Model<Api>): Model<Api>[] {
	const availableModels = roleCandidatePool("tiny", settings, registry);
	if (availableModels.length === 0) return [];

	const models = collectOnlineTinyCandidates(["tiny", "commit", "smol"], settings, availableModels).map(
		candidate => candidate.model,
	);
	if (
		currentModel &&
		(models.length === 0 || settings.get("retry.modelFallback") !== false) &&
		!models.some(model => formatModelStringWithRouting(model) === formatModelStringWithRouting(currentModel))
	) {
		// Append currentModel and expand its own chain separately — never merge it
		// into the tiny/commit/smol role collection (that would apply role defaults).
		const seen = new Set(models.map(formatModelStringWithRouting));
		for (const model of expandOnlineTinyModelFallbacks(currentModel, settings, availableModels)) {
			const key = formatModelStringWithRouting(model);
			if (seen.has(key)) continue;
			seen.add(key);
			models.push(model);
		}
	}
	return models;
}

/**
 * Generate a title for a session based on the first user message.
 *
 * @param firstMessage The first user message
 * @param registry Model registry
 * @param settings Settings used to resolve the smol role
 * @param sessionId Optional session id for sticky API key selection
 * @param currentModel Current model (used to derive title model)
 * @param metadataResolver Optional resolver evaluated after credential selection
 *   to produce request metadata (e.g. user_id for session attribution). Using a
 *   resolver instead of a pre-evaluated value ensures the metadata's account_uuid
 *   reflects the credential actually selected for this request.
 * @param customSystemPrompt Optional title-specific system prompt override
 * @param signal Session-lifecycle cancellation for background title requests
 * @param credentialSourceSessionId Optional foreground session whose selected
 *   OAuth credential should seed an isolated title-request session.
 */
export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	customSystemPrompt?: string,
	signal?: AbortSignal,
	credentialSourceSessionId?: string,
): Promise<string | null> {
	// Defer titling for greetings / acknowledgements / empty input. The default
	// tiny title model can't reliably decline trivial input, so this happens
	// deterministically before any model is invoked; the caller retries on the
	// next user message while the session stays unnamed.
	if (isLowSignalTitleInput(firstMessage)) {
		logger.debug("title-generator: skipped low-signal input", { sessionId, reason: "low-signal" });
		return null;
	}

	const models = getTitleModels(registry, settings, currentModel);
	const firstModel = models[0];
	if (!firstModel) {
		logger.warn("title-generator: no title model found", { sessionId, reason: "no-title-model" });
		return null;
	}

	const titleSystemPrompt = customSystemPrompt?.trim() || undefined;
	if (firstModel.api !== "local-inference") {
		return generateTitleOnlineWithModels(
			firstMessage,
			models,
			registry,
			sessionId,
			metadataResolver,
			signal,
			titleSystemPrompt,
			credentialSourceSessionId,
		);
	}

	// A local role selection is an explicit no-billing boundary. If the worker
	// fails (download missing, runtime crash, abort, or no output), leave the
	// session untitled rather than advancing into a paid fallback candidate.
	try {
		let localTitle: string | null;
		if (signal) {
			localTitle = await tinyTitleClient.generate(
				firstModel.id,
				firstMessage,
				titleSystemPrompt ? { signal, systemPrompt: titleSystemPrompt } : { signal },
			);
		} else if (titleSystemPrompt) {
			localTitle = await tinyTitleClient.generate(firstModel.id, firstMessage, {
				systemPrompt: titleSystemPrompt,
			});
		} else {
			localTitle = await tinyTitleClient.generate(firstModel.id, firstMessage);
		}
		if (!localTitle) {
			logger.warn("title-generator: local tiny model produced no title; skipping (no online fallback)", {
				sessionId,
				model: firstModel.id,
				reason: "local-no-output",
			});
			return null;
		}
		return localTitle;
	} catch (err) {
		logger.warn("title-generator: local tiny model errored; skipping (no online fallback)", {
			sessionId,
			model: firstModel.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

export async function generateTitleOnline(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	signal?: AbortSignal,
	customSystemPrompt?: string,
	credentialSourceSessionId?: string,
): Promise<string | null> {
	const models = getTitleModels(registry, settings, currentModel);
	if (models.length === 0) {
		logger.warn("title-generator: no title model found", { sessionId, reason: "no-title-model" });
		return null;
	}
	return generateTitleOnlineWithModels(
		firstMessage,
		models,
		registry,
		sessionId,
		metadataResolver,
		signal,
		customSystemPrompt,
		credentialSourceSessionId,
	);
}

async function generateTitleOnlineWithModels(
	firstMessage: string,
	models: Model<Api>[],
	registry: ModelRegistry,
	sessionId?: string,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	signal?: AbortSignal,
	customSystemPrompt?: string,
	credentialSourceSessionId?: string,
): Promise<string | null> {
	const titleSystemPrompt = customSystemPrompt?.trim() || undefined;
	// The model is always asked to wrap the title in `<title>...</title>` and
	// the title is parsed from text. A forced `set_title` tool call was the old
	// scheme, but hosts that ignore or reject forced `tool_choice` then echoed
	// the prompt's `{"title": ...}` JSON example verbatim as the session title;
	// markers work uniformly everywhere.
	const systemPrompt = titleSystemPrompt ? [titleSystemPrompt, TITLE_MARKER_INSTRUCTION] : [TITLE_SYSTEM_PROMPT];
	const userMessage = formatTitleUserMessage(firstMessage);

	for (const model of models) {
		const modelName = `${model.provider}/${model.id}`;
		const modelContext = {
			sessionId,
			provider: model.provider,
			id: model.id,
			model: modelName,
		};
		logger.debug("title-generator: start", modelContext);

		if (signal?.aborted) {
			logger.debug("title-generator: aborted before attempt", {
				...modelContext,
				reason: "aborted",
			});
			return null;
		}

		try {
			if (credentialSourceSessionId && sessionId && credentialSourceSessionId !== sessionId) {
				const foregroundCredential = registry.authStorage
					.listOAuthAccounts(model.provider, credentialSourceSessionId)
					.find(account => account.active);
				if (foregroundCredential) {
					registry.authStorage.pinSessionOAuthAccount(
						model.provider,
						sessionId,
						foregroundCredential.credentialId,
					);
				}
			}
			const apiKey = await registry.getApiKey(model, sessionId);
			if (!apiKey) {
				logger.warn("title-generator: no API key", { ...modelContext, reason: "missing-api-key" });
				continue;
			}
			if (signal?.aborted) {
				logger.debug("title-generator: aborted after credential", {
					...modelContext,
					reason: "aborted",
				});
				return null;
			}
			// Resolve metadata after getApiKey so the session-sticky credential for this
			// request is already recorded; metadataResolver can then return the correct
			// account_uuid rather than the snapshot-at-call-site value.
			const metadata = metadataResolver?.(model.provider);

			// Title generation is a 3-7 word task, but the ceiling has to survive
			// backends that ignore `disableReasoning` (see TITLE_MAX_TOKENS above).
			const maxTokens = TITLE_MAX_TOKENS;
			logger.debug("title-generator: request", { ...modelContext, maxTokens });

			const messages: Message[] = [{ role: "user", content: userMessage, timestamp: Date.now() }];
			if (model.supportsAssistantPrefill) messages.push(titlePrefill(model));

			const response = await retryTransientCompletion(
				() =>
					completeSimple(
						model,
						{
							systemPrompt,
							messages,
						},
						{
							apiKey: registry.resolver(model, sessionId),
							sessionId,
							maxTokens,
							disableReasoning: true,
							// Greedy decode: titling is extraction, not generation. Backends that
							// default temperature high (e.g. Ollama's 0.8) otherwise garble names
							// from the message ("hashline" → "HasHroshi"). Providers whose models
							// reject sampling params drop this via `supportsSamplingParams`.
							temperature: 0,
							metadata,
							signal,
						},
					),
				{ signal, provider: model.provider },
			);

			if (response.stopReason === "aborted" || signal?.aborted) {
				logger.debug("title-generator: aborted", {
					...modelContext,
					reason: "aborted",
					stopReason: response.stopReason,
				});
				return null;
			}

			if (response.stopReason === "error") {
				logger.warn("title-generator: response error", {
					...modelContext,
					reason: "provider-response-error",
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
				});
				continue;
			}

			const title = normalizeGeneratedTitle(extractGeneratedTitle(response.content), firstMessage);

			if (!title) {
				logger.debug("title-generator: no title returned", {
					...modelContext,
					reason: "model-returned-none",
					usage: response.usage,
					stopReason: response.stopReason,
				});
				continue;
			}

			logger.debug("title-generator: success", {
				...modelContext,
				title,
				usage: response.usage,
				stopReason: response.stopReason,
			});

			return title;
		} catch (err) {
			if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) {
				logger.debug("title-generator: aborted", {
					...modelContext,
					reason: "aborted",
					error: err instanceof Error ? err.message : String(err),
				});
				return null;
			}
			logger.warn("title-generator: error", {
				...modelContext,
				reason: "exception",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return null;
}

/**
 * Open the `<title>` marker as a trailing assistant turn on hosts that continue
 * it verbatim (`Model.supportsAssistantPrefill`). Some Ollama chat templates
 * (LFM2.5) open a reasoning channel regardless of the disable flag, burning the
 * whole output budget on thinking and never emitting a title. Committing the
 * marker first skips the reasoning channel entirely.
 */
function titlePrefill(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "<title>" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function extractGeneratedTitle(contentBlocks: AssistantMessage["content"]): string {
	let textTitle = "";
	for (const content of contentBlocks) {
		if (content.type === "text") {
			textTitle += content.text;
		}
	}
	// Stay lenient: prefer the first closed title marker in visible text, then
	// fall back to a plain sentence after stripping only known leading leaked
	// thinking envelopes plus any stray/unclosed title tag fragment. Reject a
	// prose thinking preamble only on the markerless path: a later marked title
	// remains authoritative.
	const markedTitle = extractVisibleMarkedTitle(textTitle);
	if (markedTitle !== undefined) return unwrapJsonTitle(markedTitle);
	const cleanedTextTitle = stripLeadingLeakedThinkingMarkup(textTitle)
		.replace(/<\/?title>/gi, "")
		.trim();
	if (LEADING_PROSE_THINKING_PREAMBLE_RE.test(cleanedTextTitle)) return "";
	return unwrapJsonTitle(cleanedTextTitle);
}

function extractVisibleMarkedTitle(text: string): string | undefined {
	TITLE_MARKER_GLOBAL_RE.lastIndex = 0;
	let marker: RegExpExecArray | null = TITLE_MARKER_GLOBAL_RE.exec(text);
	while (marker !== null) {
		const content = marker[1];
		if (isVisibleTitleMarker(text, marker.index)) return content?.trim() ?? "";
		marker = TITLE_MARKER_GLOBAL_RE.exec(text);
	}
	return undefined;
}

function isVisibleTitleMarker(text: string, markerIndex: number): boolean {
	if (isInsideKnownThinkingEnvelope(text, markerIndex)) return false;
	return stripLeakedThinkingMarkup(`${text.slice(0, markerIndex)}${TITLE_VISIBILITY_SENTINEL}`).endsWith(
		TITLE_VISIBILITY_SENTINEL,
	);
}

function isInsideKnownThinkingEnvelope(text: string, index: number): boolean {
	return (
		isInsideEnvelopeMatchedBy(THINKING_TAG_ENVELOPE_RE, text, index) ||
		isInsideEnvelopeMatchedBy(THINKING_FENCE_ENVELOPE_RE, text, index)
	);
}

function isInsideEnvelopeMatchedBy(pattern: RegExp, text: string, index: number): boolean {
	pattern.lastIndex = 0;
	let marker = pattern.exec(text);
	while (marker !== null) {
		const start = marker.index;
		const end = start + marker[0].length;
		if (index > start && index < end) return true;
		if (start > index) return false;
		marker = pattern.exec(text);
	}
	return false;
}

function stripLeadingLeakedThinkingMarkup(text: string): string {
	let current = text;
	while (true) {
		const withoutTag = current.replace(LEADING_THINKING_TAG_RE, "");
		const withoutFence = withoutTag.replace(LEADING_THINKING_FENCE_RE, "");
		if (withoutFence === current) return current;
		current = withoutFence;
	}
}

function stripLeakedThinkingMarkup(text: string): string {
	const healer = new StreamMarkupHealing({ pattern: "thinking" });
	return healer.feed(text) + healer.flushPending();
}

/**
 * Unwrap a JSON-shaped response (`{"title": "..."}`, optionally code-fenced)
 * into the bare title. Models occasionally emit the structured shape they were
 * trained on for title tasks instead of plain text; without this the raw JSON
 * became the session title.
 */
function unwrapJsonTitle(candidate: string): string {
	const text = candidate
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```$/, "")
		.trim();
	if (!text.startsWith("{")) return candidate;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") {
			return parsed.title.trim();
		}
	} catch {
		// Truncated/malformed JSON: salvage the quoted title value if present.
		const quoted = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
		if (quoted) {
			const salvaged: unknown = JSON.parse(quoted[1]);
			if (typeof salvaged === "string") return salvaged.trim();
		}
	}
	return candidate;
}

/**
 * Remove control characters so model-generated titles cannot inject terminal escapes.
 */
function sanitizeTerminalTitlePart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(TERMINAL_TITLE_CONTROL_CHARS, "").trim();
	return sanitized || undefined;
}

function getFallbackTerminalTitle(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const resolvedCwd = path.resolve(cwd);
	const baseName = path.basename(resolvedCwd);
	if (!baseName || baseName === path.parse(resolvedCwd).root) return undefined;
	return sanitizeTerminalTitlePart(baseName);
}

function getProjectTerminalTitleSuffix(cwd: string | undefined): string | undefined {
	// Kept separate from the no-session fallback above: when a session title
	// exists the project directory is appended (`label - project`) so tabs on
	// different repositories stay identifiable (issue #12600).
	return getFallbackTerminalTitle(cwd);
}

export function formatSessionTerminalTitle(sessionName: string | undefined, cwd?: string): string {
	const label = sanitizeTerminalTitlePart(sessionName) ?? getFallbackTerminalTitle(cwd);
	const project =
		label !== undefined && sanitizeTerminalTitlePart(sessionName) !== undefined
			? getProjectTerminalTitleSuffix(cwd)
			: undefined;
	const fullLabel = project !== undefined && project !== label ? `${label} - ${project}` : label;
	return fullLabel ? `${DEFAULT_TERMINAL_TITLE}: ${fullLabel}` : DEFAULT_TERMINAL_TITLE;
}

/**
 * Set the terminal title through the native Win32 API or OSC 0.
 *
 * Repeating the same sanitized title is a no-op on every platform.
 */
export function setTerminalTitle(title: string): void {
	writeTerminalTitle(title);
}

/**
 * The sink every title write funnels through — and it is exported via
 * {@link setTerminalTitle}, so the teardown latch belongs HERE, not only on
 * the composed-state path: a direct importer firing from a delayed callback
 * after `disposeTerminalTitleState()` would otherwise write straight into the
 * parent shell's tab whose title teardown just restored.
 *
 * When `recomposeStaticOnFailure` is set (only the composed working title
 * passes it), a native-path failure on Windows re-composes the title with the
 * failure latched — the static `:` separator — instead of emitting the
 * animated frame that just failed as OSC. Direct titles always preserve
 * verbatim: the caller's own sanitized title is the OSC fallback. The latch
 * check runs on every failure, not just the first: a direct write may latch
 * first, and a later working emit must still collapse to static rather than
 * emit one animated OSC frame.
 */
function writeTerminalTitle(title: string, recomposeStaticOnFailure = false): void {
	if (terminalTitleRuntime.disposed) return;
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	const next = sanitizeTerminalTitlePart(title) ?? DEFAULT_TERMINAL_TITLE;
	if (next === lastTerminalTitle) return;
	if (!setWindowsConsoleTitle(next)) {
		// Native path failed on a Windows console: every later frame would cross
		// ConPTY as OSC and reintroduce the write-loop CPU cost the static
		// separator exists to avoid. Latch static and stop the interval now.
		// WSL never reaches this branch (the API getter returns null off win32);
		// the platform guard keeps a mocked win32 in tests from mislatching.
		if (process.platform === "win32") {
			if (!terminalTitleRuntime.nativeTitleFailed) {
				terminalTitleRuntime.nativeTitleFailed = true;
				stopTerminalTitleSpinner();
			}
			if (recomposeStaticOnFailure) {
				const latched =
					terminalTitleRuntime.extensionOverride ??
					buildTerminalTitleWithState(
						terminalTitleRuntime.label,
						terminalTitleRuntime.state,
						terminalTitleRuntime.frame,
						terminalTitleRuntime.enabled,
						process.platform,
						terminalTitleRuntime.style,
						$env as NodeJS.ProcessEnv,
						true,
					);
				if (latched === lastTerminalTitle) return;
				writeTitleSequence(`\x1b]0;${latched}\x07`);
				lastTerminalTitle = latched;
				return;
			}
		}
		writeTitleSequence(`\x1b]0;${next}\x07`);
	}
	lastTerminalTitle = next;
}

export function setSessionTerminalTitle(sessionName: string | undefined, cwd?: string): void {
	// An authoritative session title (rename, new session, focus swap) supersedes
	// any extension override so the base title tracks the real session again.
	//
	// It does NOT release the teardown latch. Every caller here is a routine
	// session update, and several arrive from async transitions that can resume
	// AFTER teardown restored the shell's title (an extension `newSession()`
	// continuing past its `await`, a collab host frame) — work `stop()` cannot
	// cancel. Releasing here would let the emit below, and a re-armed spinner,
	// write into the parent shell's tab. Only `initTerminalTitleState()`, the
	// explicit terminal-ownership path, releases the latch.
	terminalTitleRuntime.extensionOverride = undefined;
	const sessionLabel = sanitizeTerminalTitlePart(sessionName);
	const project = sessionLabel !== undefined ? getProjectTerminalTitleSuffix(cwd) : undefined;
	terminalTitleRuntime.label =
		sessionLabel !== undefined && project !== undefined && project !== sessionLabel
			? `${sessionLabel} - ${project}`
			: (sessionLabel ?? getFallbackTerminalTitle(cwd));
	emitTerminalTitle();
}

/**
 * Set a terminal title from an extension's `setTitle()`. Unlike the session base
 * title, this owns the terminal verbatim: periodic and run-state updates will not
 * rewrite it. Cleared when the app next sets an authoritative session title via
 * {@link setSessionTerminalTitle}, or when the extension passes an empty or blank
 * title to release its claim.
 */
export function setExtensionTerminalTitle(title: string): void {
	// A title that renders to nothing RELEASES the override rather than owning the
	// terminal with it: `emitTerminalTitle` falls through on nullish only, so a
	// latched blank would strand the title at the bare brand and silence every
	// subsequent run-state change. Reuse the sink's own emptiness predicate so
	// "releases its claim" means the same thing here as it does at the sink, and
	// so the stored override is the value that will actually render.
	terminalTitleRuntime.extensionOverride = sanitizeTerminalTitlePart(title);
	emitTerminalTitle();
}

export type TerminalTitleState = "idle" | "working" | "attention";

export type TerminalTitleSpinnerStyle = "braille" | "pulse" | "dots" | "line";

/**
 * Working-state spinner frames per `tui.titleSpinner` style. `braille` is the
 * historical default; `pulse` fills and empties a moon; `dots` cycles single
 * braille dots; `line` is plain ASCII (`- \ | /`) for fonts without braille
 * coverage. Every frame is a single column so the separator never reflows the
 * title.
 */
export const TERMINAL_TITLE_SPINNER_STYLES: Record<TerminalTitleSpinnerStyle, readonly string[]> = {
	braille: SPINNER_FRAMES.unicode.activity,
	pulse: ["○", "◔", "◑", "◕", "●", "◕", "◑", "◔"],
	dots: ["⠁", "⠂", "⠄", "⠠", "⠐", "⠈"],
	line: ["-", "\\", "|", "/"],
};

/** WSL stdout still crosses ConPTY at the `wslhost` boundary, so its working title stays static (`:`). */
const isStaticTitleHost = (
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = $env as NodeJS.ProcessEnv,
): boolean => isWsl(platform, env);
const STATIC_TITLE_WORKING_SEPARATOR = ":";
const TITLE_SPINNER_INTERVAL_MS = 80;
/** The user's turn: the title reads like a shell prompt awaiting input. */
const TITLE_IDLE_SEPARATOR = ">";
/** Agent blocked on the user (ask / approval prompt). */
const TITLE_ATTENTION_SEPARATOR = "!";

const terminalTitleRuntime: {
	label: string | undefined;
	state: TerminalTitleState;
	frame: number;
	enabled: boolean;
	style: TerminalTitleSpinnerStyle;
	timer: NodeJS.Timeout | undefined;
	/** A title an extension set via `setTitle()`. While set, it owns the terminal
	 *  title verbatim: the run-state separator never rewrites it. Cleared when the
	 *  app next establishes an authoritative session title (rename, new session,
	 *  focus swap) via `setSessionTerminalTitle`. */
	extensionOverride: string | undefined;
	/** Set by `disposeTerminalTitleState()` at teardown. While set, nothing may
	 *  re-arm the spinner or emit an OSC title — teardown restores the shell's own
	 *  title, so a later write would land in the parent shell's tab. Cleared only
	 *  by `initTerminalTitleState()`, when the app takes the terminal over again. */
	disposed: boolean;
	/** Latched the first time the sink falls back to OSC on a Windows console.
	 *  The 80ms spinner interval is only cheap through `SetConsoleTitleW`; once
	 *  the native path fails, every new frame would cross ConPTY as OSC and
	 *  reintroduce the write-loop CPU cost the static separator exists to avoid.
	 *  While latched the working separator stays `:` and no interval is
	 *  scheduled. */
	nativeTitleFailed: boolean;
} = {
	label: undefined,
	state: "idle",
	frame: 0,
	enabled: true,
	style: "braille",
	timer: undefined,
	extensionOverride: undefined,
	disposed: false,
	nativeTitleFailed: false,
};

/**
 * Compose the terminal title from the `π` brand, a state-carrying separator, and
 * the session label. Pure (no I/O) so the state→separator contract is testable:
 *   - `idle` (user's turn):  `π > label`;
 *   - `working`:             `π ⠋ label` (static `π : label` under WSL, or on Windows once the native title path has failed);
 *   - `attention`:           `π ! label`;
 *   - disabled:              `π: label`.
 * Without a label the separator trails the brand (`π >`) so the state stays visible.
 * The `working` separator cycles `TERMINAL_TITLE_SPINNER_STYLES[style]`; `style`
 * defaults to `braille` so existing 5-arg callers keep the historical frames.
 */
export function buildTerminalTitleWithState(
	label: string | undefined,
	state: TerminalTitleState,
	frame: number,
	enabled: boolean,
	platform: NodeJS.Platform = process.platform,
	style: TerminalTitleSpinnerStyle = "braille",
	env: NodeJS.ProcessEnv = $env as NodeJS.ProcessEnv,
	nativeTitleFailed = false,
): string {
	if (!enabled) return label ? `${DEFAULT_TERMINAL_TITLE}: ${label}` : DEFAULT_TERMINAL_TITLE;
	const frames = TERMINAL_TITLE_SPINNER_STYLES[style] ?? TERMINAL_TITLE_SPINNER_STYLES.braille;
	const staticHost = isStaticTitleHost(platform, env) || (platform === "win32" && nativeTitleFailed);
	const separator =
		state === "working"
			? staticHost
				? STATIC_TITLE_WORKING_SEPARATOR
				: frames[frame % frames.length]
			: state === "attention"
				? TITLE_ATTENTION_SEPARATOR
				: TITLE_IDLE_SEPARATOR;
	return label ? `${DEFAULT_TERMINAL_TITLE} ${separator} ${label}` : `${DEFAULT_TERMINAL_TITLE} ${separator}`;
}

function emitTerminalTitle(): void {
	// The teardown latch lives at the sink (`writeTerminalTitle`), so every path
	// here is covered without a second check.
	// An extension override owns the terminal verbatim; the terminal sink
	// deduplicates repeated state updates.
	const next =
		terminalTitleRuntime.extensionOverride ??
		buildTerminalTitleWithState(
			terminalTitleRuntime.label,
			terminalTitleRuntime.state,
			terminalTitleRuntime.frame,
			terminalTitleRuntime.enabled,
			process.platform,
			terminalTitleRuntime.style,
			$env as NodeJS.ProcessEnv,
			terminalTitleRuntime.nativeTitleFailed,
		);
	// The composed working title is the only write that can fail into an
	// animated OSC frame: on native failure it re-pins static (`:`), while a
	// direct `setTerminalTitle` preserves its caller's title verbatim.
	const recomposeStaticOnFailure =
		terminalTitleRuntime.extensionOverride === undefined &&
		terminalTitleRuntime.state === "working" &&
		terminalTitleRuntime.enabled &&
		!isStaticTitleHost();
	writeTerminalTitle(next, recomposeStaticOnFailure);
}

function stopTerminalTitleSpinner(): void {
	clearInterval(terminalTitleRuntime.timer);
	terminalTitleRuntime.timer = undefined;
}

function startTerminalTitleSpinner(): void {
	if (
		isStaticTitleHost() ||
		terminalTitleRuntime.disposed ||
		terminalTitleRuntime.timer ||
		terminalTitleRuntime.nativeTitleFailed ||
		!process.stdout.isTTY
	)
		return;

	terminalTitleRuntime.timer = setInterval(() => {
		terminalTitleRuntime.frame =
			(terminalTitleRuntime.frame + 1) % TERMINAL_TITLE_SPINNER_STYLES[terminalTitleRuntime.style].length;
		emitTerminalTitle();
	}, TITLE_SPINNER_INTERVAL_MS);
	// Never keep the event loop alive for a cosmetic animation.
	terminalTitleRuntime.timer.unref?.();
}

/**
 * Reflect the agent run state in the terminal title's separator: `working`
 * animates (static `:` under WSL), `idle` shows `>` (your turn), and
 * `attention` shows `!` (agent blocked on you). Gated off by `tui.titleState`.
 */
export function setTerminalTitleState(state: TerminalTitleState): void {
	terminalTitleRuntime.state = state;
	if (state === "working" && terminalTitleRuntime.enabled) startTerminalTitleSpinner();
	else stopTerminalTitleSpinner();
	emitTerminalTitle();
}

/** Enable/disable the run-state separator (driven by the `tui.titleState` setting). */
export function setTerminalTitleStateEnabled(enabled: boolean): void {
	terminalTitleRuntime.enabled = enabled;
	if (enabled && terminalTitleRuntime.state === "working") startTerminalTitleSpinner();
	else stopTerminalTitleSpinner();
	emitTerminalTitle();
}

/**
 * Select the working-state spinner glyph set (driven by `tui.titleSpinner`).
 * Unknown values fall back to `braille`; switching style resets the frame so a
 * shorter set never indexes out of range, and re-arms the live interval when
 * `working` so the tick cadence stays on the new frames.
 */
export function setTerminalTitleSpinnerStyle(style: string | undefined): void {
	const next: TerminalTitleSpinnerStyle =
		style === "braille" || style === "pulse" || style === "dots" || style === "line" ? style : "braille";
	if (next === terminalTitleRuntime.style) return;
	terminalTitleRuntime.style = next;
	terminalTitleRuntime.frame = 0;
	if (terminalTitleRuntime.state === "working" && terminalTitleRuntime.enabled) {
		stopTerminalTitleSpinner();
		startTerminalTitleSpinner();
	}
	emitTerminalTitle();
}

/**
 * Take ownership of the terminal title: the counterpart to
 * {@link disposeTerminalTitleState}, called once when the UI claims the terminal.
 * This is the ONLY release of the teardown latch. Routine updates — session
 * rename, cwd change, focus swap, collab host state — must not release it: they
 * can arrive from an async transition that resumes after teardown already handed
 * the tab back to the shell.
 */
export function initTerminalTitleState(): void {
	terminalTitleRuntime.disposed = false;
	// The native-failure latch is claim-scoped like the spinner timer: a fresh
	// owner gets a re-probed native path, so a transient SetConsoleTitleW
	// failure in one session must not pin every later session static. The next
	// write re-latches only if the native path still fails. Reset the cached
	// binding too — tests swap the dlopen double per case via beforeEach, and a
	// stale failure-shaped binding would otherwise survive the reset.
	disposeWindowsConsoleTitleApi();
	terminalTitleRuntime.nativeTitleFailed = false;
	// A fresh claim starts from the shell's title, not whatever the previous
	// session last emitted: the dedupe cache must not swallow the first write.
	// Releasing the latch alone would leave a stopped timer behind a `working`
	// state — a frozen spinner frame. Mirror the enable path and re-arm.
	if (terminalTitleRuntime.state === "working" && terminalTitleRuntime.enabled) startTerminalTitleSpinner();
}

/**
 * Stop the spinner timer and latch the runtime off; call on session/UI teardown.
 * The latch is the load-bearing half: `shutdown()` disposes and restores the shell
 * title BEFORE it unsubscribes the session, so a live `#handleAgentStart` in that
 * window would otherwise re-arm the spinner and write `π ⠋ …` into the parent
 * shell's tab. Released only by {@link initTerminalTitleState}.
 */
export function disposeTerminalTitleState(): void {
	terminalTitleRuntime.disposed = true;
	// `popTerminalTitle()` hands the terminal back to the shell, so the runtime no
	// longer knows what is on screen: the stale dedupe cache (`lastTerminalTitle`,
	// cleared below) must not swallow the first write after the latch releases.
	stopTerminalTitleSpinner();
	disposeWindowsConsoleTitleApi();
	lastTerminalTitle = undefined;
}

/**
 * Save the current terminal title on terminals that support xterm window ops.
 */
export function pushTerminalTitle(): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	writeTitleSequence("\x1b[22;2t");
}

/**
 * Restore the previously saved terminal title on terminals that support xterm window ops.
 */
export function popTerminalTitle(): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	writeTitleSequence("\x1b[23;2t");
}
