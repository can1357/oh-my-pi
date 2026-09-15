/**
 * prompt-suggestions — Claude Code-style "next prompt" ghost text for OMP.
 *
 * After a successful final `agent_end` (not willContinue / error / abort /
 * queued messages), while the editor is empty, ask the runtime's `tiny` role
 * model for one short predicted next user message and render it as native dim
 * ghost text in the prompt editor. Tab accepts it into the editor (without
 * sending); any typing, paste, submitted input, new agent turn, or session
 * change invalidates the pending generation and clears the ghost — a late
 * result can never resurrect after input.
 *
 * Known security limitation: do not use with `secrets.enabled`. Extension
 * events contain original display text, and this example sends it to @tiny
 * without session secret obfuscation. The public extension API does not expose
 * the protected side-request path. See README for the maintainer decision.
 *
 * Integration (all public, confirmed against oh-my-pi v18.2.0):
 *  - `ctx.ui.addAutocompleteProvider(factory)` stacks a wrapper around the
 *    built-in editor autocomplete provider. The editor calls the wrapper's
 *    `getInlineHint()` on every render and draws the returned string as dim
 *    ghost text after the cursor (auto-truncated to the line width), so the
 *    ghost is never real editor text and never enters history.
 *  - `ctx.ui.onTerminalInput(handler)` invalidates pending suggestions,
 *    ignoring terminal→host reports (SGR mouse, CPR / cell-size replies)
 *    that reach input listeners but are not typing. A CustomEditor subclass
 *    accepts Tab only when the composer has focus — and only when the ghost
 *    is actually painted: the IME-safe hardware-cursor layout skips drawing
 *    the inline hint when the composer has side borders, so neither the
 *    provider nor the Tab handler offers a ghost there.
 *  - `ctx.models.resolve("@tiny")` resolves the tiny role dynamically (no
 *    hardcoded provider/model). Credentials come from
 *    `ctx.modelRegistry.resolver(model, sessionId)` — credential affinity
 *    stays on the live session — while the request omits `sessionId` so the
 *    transport mints an isolated id and never reuses the main provider
 *    conversation. The non-streaming `completeSimple` uses
 *    `disableReasoning: true`, a small `maxTokens`, and one bounded
 *    deadline; pi-ai's thinking-loop guard may still re-sample a stalled
 *    attempt internally (up to 3 attempts).
 *  - `/suggestions on|off|status` toggles or reports state for this session.
 */

import { completeSimple } from "@oh-my-pi/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { getComposerStyle, isKeyRelease, matchesKey, parseSgrMouse, type AutocompleteProvider } from "@oh-my-pi/pi-tui";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import suggestionSystemPrompt from "./prompt-suggestions-system.md" with { type: "text" };
import suggestionUserPrompt from "./prompt-suggestions-user.md" with { type: "text" };

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Recent user/assistant text turns sent as context (most recent last). */
export const MAX_CONTEXT_TURNS = 6;
/** Hard character budget for the conversation context. */
export const MAX_CONTEXT_CHARS = 8000;
/** Maximum accepted suggestion length (single line). */
export const MAX_SUGGESTION_CHARS = 120;
/** Output cap for the tiny request: the prompt asks for one short line, so a
 * small cap suffices and bounds pathological output. */
const MAX_OUTPUT_TOKENS = 128;
/** Hard deadline for the tiny request. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Sentinel the model replies with when no suggestion is obvious. */
export const NO_SUGGESTION = "NO_SUGGESTION";
/** Role resolved through the runtime — never a literal provider/model id. */
const TINY_ROLE = "@tiny";
/** Invisible repaint key (`setWidget(key, undefined)` removes + repaints). */
const REPAINT_WIDGET_KEY = "prompt-suggestions.repaint";

// ── Pure helpers (exported for tests/fixtures) ──────────────────────────────

/** One recent text turn extracted from agent history. */
export interface TextTurn {
	role: "user" | "assistant";
	text: string;
}

/** Minimal structural view of an AgentMessage (camelCase roles). */
interface MessageLike {
	role?: string;
	content?: string | ReadonlyArray<{ type?: string; text?: string }>;
	/** True on system-injected user messages (auto-continue etc.) — skipped. */
	injected?: boolean;
	stopReason?: string;
}

function messageText(content: MessageLike["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * Extract the recent user/assistant TEXT conversation from an agent history.
 * Tool results, thinking, images, attachments, injected/system messages, and
 * every other role are ignored. Returns at most {@link MAX_CONTEXT_TURNS}
 * turns (consecutive same-role messages merged) clipped to
 * {@link MAX_CONTEXT_CHARS} from the end.
 */
export function extractRecentTurns(messages: readonly unknown[]): TextTurn[] {
	const turns: TextTurn[] = [];
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const m = raw as MessageLike;
		if (m.role !== "user" && m.role !== "assistant") continue;
		if (m.role === "user" && m.injected === true) continue;
		const text = messageText(m.content).trim();
		if (!text) continue;
		const last = turns[turns.length - 1];
		if (last && last.role === m.role) last.text = `${last.text}\n${text}`;
		else turns.push({ role: m.role, text });
	}
	const clipped = turns.slice(-MAX_CONTEXT_TURNS);
	// Enforce the character budget from the end (most recent context wins).
	let used = 0;
	for (let i = clipped.length - 1; i >= 0; i -= 1) {
		const turn = clipped[i]!;
		const room = MAX_CONTEXT_CHARS - used;
		if (turn.text.length > room) {
			turn.text = turn.text.slice(Math.max(0, turn.text.length - room));
			for (let j = i - 1; j >= 0; j -= 1) clipped.splice(j, 1);
			break;
		}
		used += turn.text.length;
	}
	return clipped;
}

/**
 * Whether an agent_end payload looks like a successful final stop: history is
 * non-empty and the last message is an assistant that ended with
 * `stopReason: "stop"` (aborted / error / mid-loop stops are rejected).
 */
export function isSuccessfulFinalStop(messages: readonly unknown[]): boolean {
	if (!Array.isArray(messages) || messages.length === 0) return false;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const m = raw as MessageLike;
		if (m.role !== "assistant") return false;
		return m.stopReason === "stop";
	}
	return false;
}

// Prompt wording lives in the sibling .md templates (role labels, rules, and
// the system persona). `prompt.compile` — not `prompt.render` — keeps the
// output byte-exact: render's post-format pass would rewrite ASCII arrows and
// RFC wording inside injected conversation text.
const SUGGESTION_SYSTEM_PROMPT = suggestionSystemPrompt.trimEnd();
const compileSuggestionPrompt = prompt.compile(suggestionUserPrompt.trimEnd());

/** Build the single user prompt sent to the tiny model. */
export function buildSuggestionPrompt(turns: readonly TextTurn[]): string {
	return compileSuggestionPrompt({ turns });
}

const LABEL_PREFIX_RE =
	/^(?:suggestion|next(?:\s+(?:message|prompt|input))?|prompt|message|建议|下一条|下一句|预测)\s*[:：]\s*/i;

/**
 * Sanitize the model output into a displayable one-line suggestion, or `""`
 * when there is none. Strips labels/quotes/fences, collapses whitespace,
 * rejects the NO_SUGGESTION sentinel and non-text junk, and caps length.
 */
export function cleanSuggestion(raw: unknown): string {
	if (typeof raw !== "string") return "";
	let text = sanitizeText(raw).trim();
	if (text.includes(NO_SUGGESTION)) return "";
	// Apply suggestion-specific invisible-mark and whitespace cleanup after
	// the shared sanitizer handles terminal escapes and malformed Unicode.
	text = text
		.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
		.replace(/[\t\n\u2028\u2029]/g, " ")
		.trim();
	text = text.replace(/^```[a-zA-Z0-9_-]*\s*|```$/g, "").trim();
	if (!text) return "";
	// Collapse to a single line.
	text = text
		.replace(/\s*\r?\n\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	if (!text) return "";
	// Strip one wrapping pair of quotes (directional curly pairs included).
	const quote = text.match(/^["'“”‘’`]([\s\S]*)["'“”‘’`]$/);
	if (quote && quote[1]!.trim()) text = quote[1]!.trim();
	// Strip a leading label ("Suggestion: …").
	text = text.replace(LABEL_PREFIX_RE, "").trim();
	if (!text) return "";
	// Must contain actual word characters (letters, CJK, digits).
	if (!/[\p{L}\p{N}]/u.test(text)) return "";
	// Do not count punctuation as sentences: code paths and versions contain dots.
	if (text.length > MAX_SUGGESTION_CHARS * 1.5) return "";
	// Drop trailing partial punctuation pile-ups and cap.
	text = text.replace(/[.。,，;；]+$/u, "").trim();
	if (!text) return "";
	if (text.length > MAX_SUGGESTION_CHARS) {
		// Clipping UTF-16 can split a valid surrogate pair at the boundary.
		text = sanitizeText(text.slice(0, MAX_SUGGESTION_CHARS)).trimEnd();
	}
	return text;
}

/**
 * Whether a raw terminal-input chunk is a terminal→host report rather than a
 * keystroke: an SGR mouse report, an XTWINOPS cell-size reply, or a CPR
 * cursor-position reply. These bytes reach input listeners — the host
 * consumes cell-size replies only after listeners run, and routes mouse to
 * components without filtering — but they are never typing. Modified F3
 * (`CSI 1 ;<mod> R`), the one keystroke shaped like CPR, is excluded,
 * mirroring the host's own dispatch rule.
 */
export function isTerminalReport(data: string): boolean {
	if (parseSgrMouse(data) !== null) return true;
	if (/^\x1b\[6;\d+;\d+t$/.test(data)) return true;
	const cpr = /^\x1b\[(\d+);(\d+)R$/.exec(data);
	return cpr !== null && !(Number(cpr[1]) === 1 && Number(cpr[2]) >= 2);
}

// ── Extension ───────────────────────────────────────────────────────────────

type Outcome =
	| "idle"
	| "disabled"
	| "generating"
	| "shown"
	| "no suggestion"
	| "skipped: editor not empty"
	| "skipped: no recent text"
	| "skipped: tiny role unconfigured"
	| "failed";

/** Structural contract satisfied by the extension's CustomEditor subclass. */
interface GhostPaintProbe {
	/** Whether the render loop paints the inline hint on an empty cursor line. */
	ghostPaintedForEmptyLine(): boolean;
}

interface SuggestionState {
	enabled: boolean;
	/** Bumped on every invalidation; in-flight results must match it to land. */
	epoch: number;
	suggestion: string | null;
	modelLabel: string | null;
	outcome: Outcome;
	abort: AbortController | null;
	installedProvider: boolean;
	unsubscribeInput: (() => void) | null;
	ui: ExtensionContext["ui"] | null;
	/** Live PredictionEditor, once the host has constructed it. */
	editor: GhostPaintProbe | null;
}

function safe(fn: () => void): void {
	try {
		fn();
	} catch {
		/* feature-missing or wrong mode: never break the host */
	}
}

export default function promptSuggestionsExtension(pi: ExtensionAPI): void {
	const state: SuggestionState = {
		enabled: true,
		epoch: 0,
		suggestion: null,
		modelLabel: null,
		outcome: "idle",
		abort: null,
		installedProvider: false,
		unsubscribeInput: null,
		ui: null,
		editor: null,
	};

	const invalidate = (): void => {
		state.epoch += 1;
		state.suggestion = null;
		safe(() => state.abort?.abort());
		state.abort = null;
		if (!state.enabled) state.outcome = "disabled";
		else if (state.outcome === "disabled" || state.outcome === "generating" || state.outcome === "shown") {
			state.outcome = "idle";
		}
	};

	const editorEmpty = (): boolean => {
		try {
			const text = state.ui?.getEditorText?.();
			return text === "";
		} catch {
			return false;
		}
	};

	/** Ghost is only eligible on a completely empty single-line editor. */
	const ghostForLines = (lines: readonly string[]): string | null => {
		if (!state.enabled || !state.suggestion) return null;
		if (lines.length !== 1 || lines[0] !== "") return null;
		// Never offer an unpainted ghost: the IME-safe hardware-cursor layout
		// with side borders skips drawing the inline hint entirely.
		if (state.editor && !state.editor.ghostPaintedForEmptyLine()) return null;
		return state.suggestion;
	};

	// ── Detached, fully-contained tiny generation ───────────────────────────

	const launchGeneration = (ctx: ExtensionContext, messages: readonly unknown[], epoch: number): void => {
		let model: Model | undefined;
		try {
			model = ctx.models?.resolve?.(TINY_ROLE);
		} catch {
			model = undefined;
		}
		if (!model) {
			state.outcome = "skipped: tiny role unconfigured";
			return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		// Credential affinity stays on the live session; the request itself
		// omits sessionId so the transport mints an isolated id and never
		// reuses the main provider conversation.
		const apiKey = ctx.modelRegistry.resolver(model, sessionId);
		const turns = extractRecentTurns(messages);
		if (turns.length === 0 || turns[turns.length - 1]!.role !== "assistant") {
			state.outcome = "skipped: no recent text";
			return;
		}

		state.outcome = "generating";
		state.modelLabel = `${model.provider}/${model.id}`;
		const controller = new AbortController();
		state.abort = controller;
		const prompt = buildSuggestionPrompt(turns);

		// Contained one-shot timer: the runtime contains callback throws,
		// unrefs the handle, and clears it on session_shutdown.
		const timer = ctx.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		void completeSimple(
			model,
			{
				systemPrompt: [SUGGESTION_SYSTEM_PROMPT],
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			{
				apiKey,
				// No sessionId: pi-ai mints an isolated transport session id.
				maxTokens: MAX_OUTPUT_TOKENS,
				disableReasoning: true,
				temperature: 0.4,
				signal: controller.signal,
			},
		)
			.then(response => {
				if (state.epoch !== epoch || !state.enabled) return;
				if (controller.signal.aborted || response?.stopReason !== "stop") {
					state.outcome = "failed";
					return;
				}
				const text = Array.isArray(response?.content)
					? response.content
							.filter(
								(b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string",
							)
							.map(b => b.text)
							.join("\n")
					: "";
				const suggestion = cleanSuggestion(text);
				if (!suggestion || !editorEmpty()) {
					state.outcome = suggestion ? "skipped: editor not empty" : "no suggestion";
					state.suggestion = null;
					return;
				}
				state.suggestion = suggestion;
				state.outcome = "shown";
				safe(() => ctx.ui?.setWidget?.(REPAINT_WIDGET_KEY, undefined)); // invisible repaint
			})
			.catch(() => {
				if (state.epoch === epoch) state.outcome = "failed";
			})
			.finally(() => {
				safe(() => ctx.clearTimer(timer));
				if (state.abort === controller) state.abort = null;
			});
	};

	// Terminal listeners never consume input: dialogs must keep their own Tab.

	const onTerminalInput = (data: string): undefined => {
		try {
			if (data.length === 0 || isKeyRelease(data) || isTerminalReport(data)) return undefined;
			if (matchesKey(data, "tab") && state.enabled && state.suggestion && editorEmpty()) {
				return undefined; // Only the focused composer may accept it.
			}
			// Any other keystroke/paste invalidates pending generation and the
			// displayed ghost (the ghost also self-hides because the editor is
			// no longer empty at render time).
			invalidate();
			return undefined;
		} catch {
			return undefined;
		}
	};

	class PredictionEditor extends CustomEditor {
		// The host reconfigures the swapped-in editor after the factory returns
		// (terminal cursor, IME-safe layout, composer shape). Mirror the two
		// flag setters that have no public getter.
		#imeSafeCursorLayout = false;
		#borderVisible = true;

		override setImeSafeCursorLayout(enabled: boolean): void {
			this.#imeSafeCursorLayout = enabled;
			super.setImeSafeCursorLayout(enabled);
		}

		override setBorderVisible(borderVisible: boolean): void {
			this.#borderVisible = borderVisible;
			super.setBorderVisible(borderVisible);
		}

		/**
		 * Whether the render loop actually paints the inline hint on an empty
		 * cursor line in this configuration. The IME-safe hardware-cursor
		 * layout keeps the row after the cursor empty when the composer has
		 * side borders, so a ghost exists there but is never drawn.
		 */
		ghostPaintedForEmptyLine(): boolean {
			if (!this.getUseTerminalCursor() || !this.#imeSafeCursorLayout) return true;
			const sideBorders = this.#borderVisible && getComposerStyle(this.getBorderStyle()).sideBorders;
			return !sideBorders;
		}

		override handleInput(data: string): void {
			if (!isKeyRelease(data) && matchesKey(data, "tab")) {
				const suggestion = state.enabled ? state.suggestion : null;
				const accept =
					suggestion && editorEmpty() && !this.isShowingAutocomplete() && this.ghostPaintedForEmptyLine();
				invalidate();
				if (accept) {
					state.ui?.setEditorText(suggestion);
					return;
				}
			}
			super.handleInput(data);
		}
	}

	/** Install the ghost provider once; refresh the input listener per session. */
	const installUiHooks = (ctx: ExtensionContext): void => {
		state.ui = ctx.ui ?? state.ui;
		if (!state.installedProvider) {
			try {
				ctx.ui.setEditorComponent((tui, theme, keybindings) => {
					const editor = new PredictionEditor(tui, theme, keybindings);
					state.editor = editor;
					return editor;
				});
				ctx.ui?.addAutocompleteProvider?.((base: AutocompleteProvider): AutocompleteProvider => {
					const wrapped: AutocompleteProvider = {
						getSuggestions: (lines, cursorLine, cursorCol, signal) =>
							base.getSuggestions(lines, cursorLine, cursorCol, signal),
						applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
							base.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
						getInlineHint: (lines, cursorLine, cursorCol) =>
							ghostForLines(lines) ?? base.getInlineHint?.(lines, cursorLine, cursorCol) ?? null,
					};
					if (base.trySyncSlashCompletion) {
						wrapped.trySyncSlashCompletion = text => base.trySyncSlashCompletion!(text);
					}
					if (base.trySyncInlineReplace) {
						wrapped.trySyncInlineReplace = text => base.trySyncInlineReplace!(text);
					}
					if (base.getForceFileSuggestions) {
						wrapped.getForceFileSuggestions = (lines, cursorLine, cursorCol, signal) =>
							base.getForceFileSuggestions!(lines, cursorLine, cursorCol, signal);
					}
					if (base.shouldTriggerFileCompletion) {
						wrapped.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) =>
							base.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol);
					}
					return wrapped;
				});
				state.installedProvider = true;
			} catch {
				state.outcome = "failed";
			}
		}
		// The controller clears extension input listeners on session switches;
		// re-register (replace) so invalidation keeps working.
		safe(() => state.unsubscribeInput?.());
		state.unsubscribeInput = null;
		try {
			const unsub = ctx.ui?.onTerminalInput?.(onTerminalInput);
			if (typeof unsub === "function") state.unsubscribeInput = unsub;
		} catch {
			/* wrong mode: no keyboard surface */
		}
	};

	// ── Event wiring ─────────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		installUiHooks(ctx);
		invalidate();
		state.outcome = "idle";
	});

	pi.on("agent_start", () => invalidate());

	pi.on("agent_end", (event, ctx) => {
		try {
			if (!state.enabled || !ctx.hasUI) return;
			if ((event as { willContinue?: boolean } | undefined)?.willContinue === true) return;
			try {
				if (ctx.hasPendingMessages?.()) return;
			} catch {
				/* optional surface in proxies: treat as no queue */
			}
			const messages = Array.isArray((event as { messages?: unknown[] } | undefined)?.messages)
				? (event as { messages: unknown[] }).messages
				: [];
			if (!isSuccessfulFinalStop(messages)) return;
			invalidate();
			const epoch = state.epoch;
			if (!editorEmpty()) {
				state.outcome = "skipped: editor not empty";
				return;
			}
			launchGeneration(ctx, messages, epoch);
		} catch {
			state.outcome = "failed";
		}
	});

	pi.on("input", () => invalidate());

	const onSessionChange = (_event: unknown, ctx: ExtensionContext): void => {
		invalidate();
		installUiHooks(ctx);
	};
	pi.on("session_switch", onSessionChange);
	pi.on("session_branch", onSessionChange);
	pi.on("session_tree", onSessionChange);
	pi.on("session_compact", onSessionChange);
	pi.on("session_shutdown", () => {
		invalidate();
		safe(() => state.unsubscribeInput?.());
		state.unsubscribeInput = null;
	});

	// ── /suggestions command ─────────────────────────────────────────────────

	pi.registerCommand("suggestions", {
		description: "Next-prompt ghost suggestions: on | off | status",
		handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on") {
				state.enabled = true;
				invalidate();
			} else if (arg === "off") {
				state.enabled = false;
				invalidate();
			} else if (arg !== "" && arg !== "status") {
				safe(() => ctx.ui?.notify?.("Usage: /suggestions on | off | status", "warning"));
				return;
			}
			let modelLabel = state.modelLabel;
			safe(() => {
				const resolved = ctx.models?.resolve?.(TINY_ROLE);
				if (resolved) modelLabel = `${resolved.provider}/${resolved.id}`;
			});
			const mode = state.enabled ? (ctx.hasUI ? "on" : "on (no UI this session)") : "off";
			safe(() =>
				ctx.ui?.notify?.(
					`[suggestions] ${mode} · tiny: ${modelLabel ?? "role unconfigured"} · ${state.outcome}`,
					"info",
				),
			);
		},
	});

	safe(() => pi.setLabel?.("Prompt Suggestions"));
}
