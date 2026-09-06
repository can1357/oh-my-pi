import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type AutocompleteProvider, matchesKey, type SlashCommand } from "@oh-my-pi/pi-tui";
import { isEnoent, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../../config/settings";
import { resolveLocalRoot } from "../../internal-urls";
import { AskDialogComponent } from "../../modes/components/ask-dialog";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { extractImagePathFromText } from "../../modes/components/custom-editor";
import { ReadToolGroupComponent } from "../../modes/components/read-tool-group";
import { renderSegmentTrack } from "../../modes/components/segment-track";
import { TinyTitleDownloadProgressComponent } from "../../modes/components/tiny-title-download-progress";
import { ToolExecutionComponent } from "../../modes/components/tool-execution";
import { TreeSelectorComponent } from "../../modes/components/tree-selector";
import { chipLabel, compactImageMarkers, shiftImageMarkers } from "../../modes/composer-attachments";
import { expandEmoticons } from "../../modes/emoji-autocomplete";
import { materializeImageReferenceLinks, setCachedImageDimensions } from "../../modes/image-references";
import { createPromptActionAutocompleteProvider } from "../../modes/prompt-action-autocomplete";
import { parseQueueShorthand, splitQueuedMessages } from "../../modes/queue-input";
import { buildSkillCommandPrompt, isKnownSkillCommand } from "../../modes/skill-command";
import type { InteractiveModeContext } from "../../modes/types";
import manualContinuePrompt from "../../prompts/system/manual-continue.md" with { type: "text" };
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeBuiltinSlashCommand, lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import { isTinyTitleLocalModelKey } from "../../tiny/models";
import { tinyTitleClient } from "../../tiny/title-client";
import type { TinyTitleProgressEvent } from "../../tiny/title-protocol";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import { vocalizer } from "../../tts/vocalizer";
import {
	copyToClipboard,
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "../../utils/clipboard";
import { getSlashCommandUsage, loadSlashCommandUsage, recordSlashCommandUsage } from "../../utils/command-usage";
import { EnhancedPasteController } from "../../utils/enhanced-paste";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { ensureSupportedImageInput, ImageInputTooLargeError, loadImageInput } from "../../utils/image-loading";
import { resizeImage } from "../../utils/image-resize";

/**
 * Slash commands that may carry secrets in their arguments should never be
 * persisted to history.
 *
 * - /login accepts three callback forms (redirect URL, query string, raw auth
 *   code) — all can contain OAuth code=/state= params.
 * - /join <link> carries a 32-byte room key and optional write token.
 * - /mcp add --token <token> carries a bearer token.
 *
 * The command name is extracted the same way as parseSlashCommand() — splitting
 * on the earliest whitespace or colon — so /login:?code=... is correctly matched.
 */
export function shouldSkipHistory(slashText: string): boolean {
	if (!slashText.startsWith("/")) return false;
	const body = slashText.slice(1);
	// Match parseSlashCommand: split on earliest whitespace or colon.
	const firstWs = body.search(/\s/);
	const firstColon = body.indexOf(":");
	const sep = firstWs === -1 ? firstColon : firstColon === -1 ? firstWs : Math.min(firstWs, firstColon);
	const name = sep === -1 ? body : body.slice(0, sep);
	const hasArgs = sep !== -1;
	// /login <anything> — parseCallbackInput() accepts redirect URLs, query
	// strings (?code=...), and raw auth codes, all of which carry secrets.
	if (name === "login" && hasArgs) return true;
	// /join <link> — the link carries the 32-byte room key and write token.
	if (name === "join" && hasArgs) return true;
	if (name === "mcp") {
		const args = body.slice(sep + 1).trim();
		return args.startsWith("add") && /--token\s/.test(args);
	}
	return false;
}

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

/** Minimal contract for any component that can receive a paste payload directly. */
interface PasteTarget {
	pasteText(text: string): void;
}

function hasPasteText(value: unknown): value is PasteTarget {
	return typeof value === "object" && value !== null && typeof (value as PasteTarget).pasteText === "function";
}

const SHELL_PROMPT_COMMAND_RE =
	/^(?:\.{0,2}\/|~\/|cd(?:\s|$)|sudo(?:\s|$)|git(?:\s|$)|bun(?:\s|$)|npm(?:\s|$)|pnpm(?:\s|$)|yarn(?:\s|$)|node(?:\s|$)|python\d*(?:\s|$)|cargo(?:\s|$)|go(?:\s|$)|make(?:\s|$)|docker(?:\s|$)|kubectl(?:\s|$))/;
const SHELL_PROMPT_OPERATOR_RE = /(?:^|\s)(?:&&|\|\||\||2>&1|[<>]{1,2})(?:\s|$)/;
const OMP_STATUS_LINE_RE = /^\s*in:\s+\d+\s+out:\s+\d+(?:\s+cache\s+\S+)?\s+t:\s+\S+\s+tok\/s:\s+\S+/m;

function looksLikePastedShellPrompt(code: string): boolean {
	const firstLine = code.split("\n", 1)[0]?.trimStart() ?? "";
	return (
		SHELL_PROMPT_COMMAND_RE.test(firstLine) ||
		SHELL_PROMPT_OPERATOR_RE.test(firstLine) ||
		OMP_STATUS_LINE_RE.test(code)
	);
}

function pythonCommandPrefixLength(trimmedText: string): 0 | 1 | 2 {
	if (trimmedText.charCodeAt(0) !== 36 /* $ */) return 0;
	if (trimmedText.charCodeAt(1) === 123 /* { */) return 0;

	const prefixLength = trimmedText.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = trimmedText.charCodeAt(prefixLength);
	if (Number.isNaN(next)) return prefixLength;
	return next === 32 || next === 9 || next === 10 || next === 13 ? prefixLength : 0;
}

function parsePythonCommandInput(text: string): { code: string; isExcluded: boolean } | undefined {
	const trimmed = text.trimStart();
	const prefixLength = pythonCommandPrefixLength(trimmed);
	if (prefixLength === 0) return undefined;
	const code = trimmed.slice(prefixLength).trim();
	if (prefixLength === 1 && looksLikePastedShellPrompt(code)) return undefined;
	return {
		code,
		isExcluded: prefixLength === 2,
	};
}

/** Wrap pasted text in `<attachment>` tags so the model treats it as one quoted block. */
function wrapPasteInAttachmentBlock(content: string): string {
	return `<attachment>\n${content}\n</attachment>`;
}

/** Run a teardown abort that must never throw (Esc / Ctrl+C path). A thrown
 *  error is logged at debug instead of silently swallowed, so a failing abort
 *  stays diagnosable without disturbing teardown ordering. */
function safeAbort(label: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		logger.debug(`Failed to abort ${label}`, { error: err instanceof Error ? err.message : String(err) });
	}
}

const TINY_TITLE_PROGRESS_DONE_TTL_MS = 3_000;
// A cached model fires its file-load events in a short burst and then goes silent
// while onnxruntime builds the session; a genuine download keeps streaming progress
// events for seconds. Only reveal the bar once a still-incomplete event arrives after
// this grace window, so an already-downloaded model never flashes the bar.
const TINY_TITLE_PROGRESS_REVEAL_DELAY_MS = 1_000;
// Double-tap ← on an empty editor opens the Agent Hub (and, in a focused
// subagent view, ←← returns to the main session). The second tap must land
// inside this window. The lower bound rejects terminal-synthesized arrow-key
// bursts: "click to move cursor" / pointer features in iTerm2, WezTerm, kitty,
// and tmux emit several arrow keys in a single stdin read (sub-millisecond
// apart) on a stray click, which used to pop the hub with no key ever pressed.
// Three or more rapid taps are likewise treated as a burst, not a gesture. A
// deliberate human double-tap is always tens of milliseconds apart.
const LEFT_DOUBLE_TAP_MIN_GAP_MS = 40;
const LEFT_DOUBLE_TAP_MAX_GAP_MS = 500;

export class InputController {
	constructor(
		private ctx: InteractiveModeContext,
		/** Injectable clipboard reads so tests can drive paste flows without a real clipboard. */
		private clipboard: {
			readImage: typeof readImageFromClipboard;
			readText: typeof readTextFromClipboard;
			readMacFileUrls?: typeof readMacFileUrlsFromClipboard;
		} = {
			readImage: readImageFromClipboard,
			readText: readTextFromClipboard,
			readMacFileUrls: readMacFileUrlsFromClipboard,
		},
	) {}

	/** Session-level title starts (user `/skill:` via promptCustomMessage) reuse this UI. */
	notifyTitleGenerationStart(): void {
		this.#showTinyTitleDownloadProgress(this.ctx.settings.get("providers.tinyModel"));
	}

	#enhancedPaste?: EnhancedPasteController;
	#draftText: string | undefined;
	#focusedLeftTapListenerInstalled = false;
	#focusedPasteListenerInstalled = false;
	#btwBranchListenerInstalled = false;
	#btwCopyListenerInstalled = false;
	#expandToolsListenerInstalled = false;

	/** Return the last full editor snapshot delivered by its change contract. */
	getDraftText(): string {
		return this.#draftText ?? this.ctx.editor.getText();
	}

	// Tap counter for the double-← gesture; reset whenever a quiet gap
	// (>= LEFT_DOUBLE_TAP_MAX_GAP_MS) starts a fresh sequence. See
	// #detectLeftDoubleTap.
	#leftTapCount = 0;
	// Sequential index for `local://paste-N.md` references created by the large-paste
	// flow. Seeded from 0 and bumped past existing paste files.
	#pasteCounter = 0;
	// Visible-chip signature from the last editor change; a difference escapes the
	// scoped-input render fast path so the attachment chips band repaints.
	#lastChipsSignature = "";

	#showTinyTitleDownloadProgress(modelKey: string): void {
		if (!isTinyTitleLocalModelKey(modelKey)) return;
		const component = new TinyTitleDownloadProgressComponent(modelKey);
		let added = false;
		let disposed = false;
		let removeTimer: NodeJS.Timeout | undefined;
		const remove = (): void => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			if (removeTimer) {
				clearTimeout(removeTimer);
				removeTimer = undefined;
			}
			if (added) {
				this.ctx.chatContainer.removeChild(component);
				this.ctx.ui.requestRender();
			}
		};
		const scheduleRemove = (): void => {
			if (removeTimer) clearTimeout(removeTimer);
			removeTimer = setTimeout(remove, TINY_TITLE_PROGRESS_DONE_TTL_MS);
			removeTimer.unref?.();
		};
		let revealAt = 0;
		const update = (event: TinyTitleProgressEvent): void => {
			if (disposed || event.modelKey !== modelKey) return;
			component.update(event);
			if (revealAt === 0) revealAt = performance.now() + TINY_TITLE_PROGRESS_REVEAL_DELAY_MS;
			const complete = component.isComplete();
			// Reveal only for a download still in flight past the grace window. Cache hits
			// either complete or fall silent (onnx init emits no events) before this fires.
			if (!added && !complete && performance.now() >= revealAt) {
				this.ctx.chatContainer.addChild(component);
				added = true;
			}
			if (added) this.ctx.ui.requestRender();
			if (complete) {
				if (added) scheduleRemove();
				else remove();
			}
		};
		const unsubscribe = tinyTitleClient.onProgress(update);
	}

	#abortStreamingTurn(): void {
		void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
	}

	setupKeyHandlers(): void {
		this.#draftText ??= this.ctx.editor.getText();
		this.ctx.editor.setActionKeys("app.interrupt", this.ctx.keybindings.getKeys("app.interrupt"));
		if (!this.#focusedLeftTapListenerInstalled) {
			this.#focusedLeftTapListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!this.ctx.focusedAgentId) return undefined;
				if (!matchesKey(data, "left")) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				this.#handleFocusedLeftTap();
				return { consume: true };
			});
		}
		if (!this.#btwBranchListenerInstalled) {
			this.#btwBranchListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!matchesKey(data, "b")) return undefined;
				if (!this.ctx.handlesBtwBranchKey()) return undefined;
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				void this.ctx.handleBtwBranchKey();
				return { consume: true };
			});
		}
		if (!this.#btwCopyListenerInstalled) {
			this.#btwCopyListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!matchesKey(data, "c")) return undefined;
				if (!this.ctx.canCopyBtw()) return undefined;
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				void this.ctx.handleBtwCopyKey();
				return { consume: true };
			});
		}
		if (!this.#focusedPasteListenerInstalled) {
			this.#focusedPasteListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				const focused = this.ctx.ui.getFocused();
				if (!focused || focused === this.ctx.editor || !hasPasteText(focused)) return undefined;
				if (!this.ctx.keybindings.matches(data, "app.clipboard.pasteImage")) return undefined;
				void this.handleImagePaste();
				return { consume: true };
			});
		}
		if (!this.#expandToolsListenerInstalled) {
			this.#expandToolsListenerInstalled = true;
			// `app.tools.expand` (Ctrl+O) toggles the transcript's tool-output
			// preview. It must fire regardless of focus so a truncated edit stays
			// expandable while an approval prompt / select dialog holds keyboard
			// focus (#7837). Defers when the main transcript is not the active
			// surface (a fullscreen/anchored overlay — agent hub, transcript
			// viewer, log viewer, model picker) or when the focused component
			// rebinds Ctrl+O for its own use (the tree selector's filter cycle).
			this.ctx.ui.addInputListener(data => {
				if (!this.ctx.keybindings.matches(data, "app.tools.expand")) return undefined;
				if (this.ctx.ui.hasOverlay()) return undefined;
				if (this.ctx.ui.getFocused() instanceof TreeSelectorComponent && matchesKey(data, "ctrl+o"))
					return undefined;
				const focused = this.ctx.ui.getFocused();
				// A truncated ask question lives in the editor slot, not chat
				// transcript, so expand it in-place instead of (or before)
				// toggling tool-output previews.
				if (focused instanceof AskDialogComponent && focused.toggleQuestionExpansion()) {
					return { consume: true };
				}
				this.toggleToolOutputExpansion();
				return { consume: true };
			});
		}
		this.ctx.editor.onEscape = () => {
			// `/mcp test` advertises Esc until each owner's post-settlement grace expires.
			// Cancel every overlapping test before any main-turn or side-channel action.
			if (this.ctx.mcpTestEscapeHandlers.size > 0) {
				// One Esc cancels every advertised /mcp test and consumes the ownership;
				// the next Esc must reach the actions below instead of being swallowed
				// by a stale registration or grace timer.
				const handlers = [...this.ctx.mcpTestEscapeHandlers];
				this.ctx.mcpTestEscapeHandlers.clear();
				for (const handler of handlers) handler();
				return;
			}

			// Side-channel panels are the topmost view. Esc dismisses them before
			// touching loop mode, maintenance, or the underlying main turn.
			// Active context maintenance owns Esc: auto/manual compaction,
			// handoff generation, and auto-retry backoff all advertise
			// "(esc to cancel)". Dispatch on live session state instead of
			// swapping onEscape handlers — interleaved start/end events used
			// to clobber the single saved-handler slot (auto-compaction start
			// → /compact → auto end → manual finally), leaving Esc wired to a
			// stale no-op closure until restart.
			//
			// While a subagent is focused, Esc honors the advertised view action
			// ("Esc returns to main") instead of cancelling maintenance —
			// accidentally killing a focused subagent's compaction on the way out
			// was #2819. The auto-maintenance loaders relabel their hint to match
			// (see EventController). Main-session maintenance still owns Esc and
			// stays cancellable from the main view (focused submit gates /compact
			// and handoff, so manual maintenance is main-only anyway).
			if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) {
				return;
			}
			if (this.ctx.hasActiveOmfg() && this.ctx.handleOmfgEscape()) {
				return;
			}
			if (this.ctx.hasActiveCleanse() && this.ctx.handleCleanseEscape()) {
				return;
			}

			if (!this.ctx.focusedAgentId) {
				const viewSession = this.ctx.viewSession;
				let aborted = false;
				if (viewSession.isCompacting) {
					safeAbort("compaction", () => viewSession.abortCompaction());
					aborted = true;
				}
				if (viewSession.isGeneratingHandoff) {
					safeAbort("handoff", () => viewSession.abortHandoff());
					aborted = true;
				}
				if (viewSession.isRetrying) {
					safeAbort("retry", () => viewSession.abortRetry());
					aborted = true;
				}
				if (aborted) return;
			}

			if (vocalizer.isSpeaking()) {
				// Playback from the completed response can overlap the next agent
				// turn. Silence it before interrupting any ongoing main-turn work.
				vocalizer.clear();
				this.ctx.lastEscapeTime = 0;
				return;
			}

			if (this.ctx.loopModeEnabled) {
				if (this.ctx.session.isStreaming) {
					this.#abortStreamingTurn();
				} else {
					this.ctx.pauseLoop();
					this.ctx.cancelPendingSubmission();
				}
				return;
			}
			if (this.ctx.focusedAgentId) {
				// Esc never interrupts the focused agent's turn: clear typed text,
				// else return the view to the main session. Interrupt via empty
				// steer-flush submit if needed.
				if (this.ctx.editor.getText().trim()) {
					this.ctx.editor.setText("");
					this.ctx.ui.requestRender();
				} else {
					void this.ctx.unfocusSession();
				}
				return; // double-escape backtrack (/tree, /branch) stays main-only
			}
			if (this.ctx.collabGuest) {
				// Guest Esc: ask the host to interrupt its agent; the local replica
				// session is never streaming, so the native abort path below would
				// no-op.
				if (this.ctx.collabGuest.state?.isStreaming || this.ctx.loadingAnimation) {
					this.ctx.collabGuest.sendAbort();
				}
				return;
			}
			if (this.ctx.loadingAnimation) {
				if (this.ctx.cancelPendingSubmission()) {
					return;
				}
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.ctx.session.isBashRunning) {
				this.ctx.session.abortBash();
			} else if (this.ctx.isBashMode) {
				this.ctx.editor.setText("");
				this.ctx.isBashMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isEvalRunning) {
				this.ctx.session.abortEval();
			} else if (this.ctx.isPythonMode) {
				this.ctx.editor.setText("");
				this.ctx.isPythonMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isStreaming) {
				this.#abortStreamingTurn();
			} else if (this.ctx.editor.getText().trim()) {
				// Esc must not destroy an in-progress draft.
				this.ctx.lastEscapeTime = 0;
			} else {
				// Double-interrupt with empty editor triggers /tree, /branch, or nothing based on setting
				const action = settings.get("doubleEscapeAction");
				if (action !== "none") {
					const now = Date.now();
					if (now - this.ctx.lastEscapeTime < 500) {
						if (action === "tree") {
							this.ctx.showTreeSelector();
						} else {
							this.ctx.showUserMessageSelector();
						}
						// Forced viewport repaint only: `resetDisplay()` replays the whole
						// committed transcript (and clears native scrollback on direct
						// terminals), which blocks on PTY backpressure for tens of seconds
						// on long sessions — the selector opens invisibly and double-Esc
						// reads as dead. O(viewport) is enough to settle the editor-slot swap.
						this.ctx.ui.requestRender(true);
						this.ctx.lastEscapeTime = 0;
					} else {
						this.ctx.lastEscapeTime = now;
					}
				}
			}
		};

		this.ctx.editor.setActionKeys("app.clear", this.ctx.keybindings.getKeys("app.clear"));
		this.ctx.editor.onClear = () => this.handleCtrlC();
		this.ctx.editor.setActionKeys("app.exit", this.ctx.keybindings.getKeys("app.exit"));
		this.ctx.editor.setActionKeys("app.display.reset", this.ctx.keybindings.getKeys("app.display.reset"));
		this.ctx.editor.onDisplayReset = () => {
			// Explicit user gesture (display reset, Alt+L by default): re-query the
			// terminal background once so a mid-session light/dark switch is picked
			// up even on terminals without an end-to-end Mode 2031 notification
			// path (#5352). The appearance callback re-evaluates the auto theme; the
			// repaint below then renders the resolved palette. Bounded to one OSC 11
			// probe per gesture — no timers, no periodic polling.
			this.ctx.resetDisplayAfterAppearanceRefresh();
		};
		this.ctx.editor.onExit = () => this.handleCtrlD();
		this.ctx.editor.setActionKeys("app.suspend", this.ctx.keybindings.getKeys("app.suspend"));
		this.ctx.editor.onSuspend = () => this.handleCtrlZ();
		this.ctx.editor.setActionKeys("app.thinking.cycle", this.ctx.keybindings.getKeys("app.thinking.cycle"));
		this.ctx.editor.onCycleThinkingLevel = () => this.cycleThinkingLevel();
		this.ctx.editor.setActionKeys("app.model.cycleForward", this.ctx.keybindings.getKeys("app.model.cycleForward"));
		this.ctx.editor.onCycleModelForward = () => this.cycleRoleModel("forward");
		this.ctx.editor.setActionKeys("app.model.cycleBackward", this.ctx.keybindings.getKeys("app.model.cycleBackward"));
		this.ctx.editor.onCycleModelBackward = () => this.cycleRoleModel("backward");
		this.ctx.editor.setActionKeys(
			"app.model.selectTemporary",
			this.ctx.keybindings.getKeys("app.model.selectTemporary"),
		);
		this.ctx.editor.onSelectModelTemporary = () => this.ctx.showModelSelector({ temporaryOnly: true });

		// Global debug handler on TUI (works regardless of focus)
		this.ctx.ui.onDebug = () => this.ctx.showDebugSelector();
		this.ctx.editor.setActionKeys("app.model.select", this.ctx.keybindings.getKeys("app.model.select"));
		this.ctx.editor.onSelectModel = () => this.ctx.showModelSelector();
		this.ctx.editor.setActionKeys("app.history.search", this.ctx.keybindings.getKeys("app.history.search"));
		this.ctx.editor.onHistorySearch = () => this.ctx.showHistorySearch();
		this.ctx.editor.setActionKeys("app.thinking.toggle", this.ctx.keybindings.getKeys("app.thinking.toggle"));
		this.ctx.editor.onToggleThinking = () => this.ctx.toggleThinkingBlockVisibility();
		this.ctx.editor.setActionKeys("app.editor.external", this.ctx.keybindings.getKeys("app.editor.external"));
		this.ctx.editor.onExternalEditor = () => void this.openExternalEditor();
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteImage",
			this.ctx.keybindings.getKeys("app.clipboard.pasteImage"),
		);
		this.ctx.editor.onPasteImage = () => this.handleImagePaste();
		this.ctx.editor.onPasteImagePath = path => this.handleImagePathPaste(path);
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteTextRaw",
			this.ctx.keybindings.getKeys("app.clipboard.pasteTextRaw"),
		);
		this.ctx.editor.onPasteTextRaw = () => void this.handleClipboardTextRawPaste();
		this.ctx.editor.onLargePaste = (text, lineCount) => this.handleLargePaste(text, lineCount);
		this.ctx.editor.setActionKeys(
			"app.clipboard.copyPrompt",
			this.ctx.keybindings.getKeys("app.clipboard.copyPrompt"),
		);
		this.ctx.editor.onCopyPrompt = () => this.handleCopyPrompt();
		this.ctx.editor.setActionKeys(
			"app.tools.toggleVisibility",
			this.ctx.keybindings.getKeys("app.tools.toggleVisibility"),
		);
		this.ctx.editor.onToggleToolActivity = () => this.toggleToolActivityVisibility();
		this.ctx.editor.setActionKeys("app.message.dequeue", this.ctx.keybindings.getKeys("app.message.dequeue"));
		this.ctx.editor.onDequeue = () => this.handleDequeue();
		this.ctx.editor.setActionKeys("app.retry", this.ctx.keybindings.getKeys("app.retry"));
		this.ctx.editor.onRetry = () => void this.handleRetry();
		this.ctx.editor.clearCustomKeyHandlers();
		// Wire up extension shortcuts
		this.registerExtensionShortcuts();
		const planModeKeys = this.ctx.keybindings.getKeys("app.plan.toggle");
		for (const key of planModeKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handlePlanModeCommand());
		}

		for (const key of this.ctx.keybindings.getKeys("app.session.new")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.handleClearCommand());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.tree")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showTreeSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.fork")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showUserMessageSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.resume")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showSessionSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.message.followUp")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.handleFollowUp());
		}
		for (const key of this.ctx.keybindings.getKeys("app.stt.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handleSTTToggle());
		}
		for (const key of this.ctx.keybindings.getKeys("app.live.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handleLiveCommand());
		}
		// Hold the space bar to push-to-talk: the editor recognizes the auto-repeat burst, tracks
		// the spam back out, and toggles STT on hold start / release. Gated on `stt.enabled` so a
		// disabled STT leaves the space bar typing normally.
		this.ctx.editor.sttHoldEnabled = () => settings.get("stt.enabled");
		this.ctx.editor.onSpaceHoldStart = () => void this.ctx.handleSTTToggle();
		this.ctx.editor.onSpaceHoldEnd = () => void this.ctx.handleSTTToggle();
		for (const key of this.ctx.keybindings.getKeys("app.clipboard.copyLine")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.handleCopyCurrentLine());
		}
		const hubKeys = new Set([
			...this.ctx.keybindings.getKeys("app.agents.hub"),
			...this.ctx.keybindings.getKeys("app.session.observe"),
		]);
		for (const key of hubKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showAgentHub());
		}

		// Double-tap left arrow on an empty editor: opens the agent hub from the
		// main session, or returns the focused subagent view to the main session.
		// Focused ←← intentionally matches Esc. From the main session the gesture
		// stays inert when there are no subagents (requireContent); the explicit
		// hub key still opens the empty roster. `armCloseTap` hands this gesture's
		// tap state to the hub so the same ←← that opened it also arms its close —
		// otherwise the hub's fresh detector demands a second ←← (issue #4780).
		this.ctx.editor.onLeftAtStart = () => {
			if (this.ctx.focusedAgentId) {
				this.#handleFocusedLeftTap();
				return;
			}
			if (this.#detectLeftDoubleTap()) {
				this.ctx.showAgentHub({ requireContent: true, armCloseTap: true });
			}
		};

		this.#setupEnhancedPaste();

		this.ctx.editor.onChange = (text: string) => {
			this.#draftText = text;
			const wasBashMode = this.ctx.isBashMode;
			const wasPythonMode = this.ctx.isPythonMode;
			const trimmed = text.trimStart();
			this.ctx.isBashMode = trimmed.startsWith("!");
			this.ctx.isPythonMode = parsePythonCommandInput(trimmed) !== undefined;
			if (wasBashMode !== this.ctx.isBashMode || wasPythonMode !== this.ctx.isPythonMode) {
				this.ctx.updateEditorBorderColor();
			}
			// Editor input repaints through the scoped fast path (only the editor
			// component). The attachment chips band lives outside the editor, so a
			// visibility change — a chip pasted in or its token deleted — must escape
			// the fast path with a full render or the band goes stale.
			const chipsSignature = this.ctx.editor
				.composerChips()
				.map(chip => `${chip.kind}${chip.n}`)
				.join(",");
			if (chipsSignature !== this.#lastChipsSignature) {
				this.#lastChipsSignature = chipsSignature;
				this.ctx.ui.requestRender();
			}
		};
	}

	#handleFocusedLeftTap(): void {
		if (this.#detectLeftDoubleTap()) {
			void this.ctx.unfocusSession();
		}
	}

	/**
	 * Detect a deliberate double-← gesture, rejecting terminal-synthesized arrow
	 * bursts. Returns true only on the *second* tap of a fresh sequence when it
	 * lands a human-plausible interval after the first
	 * (`[LEFT_DOUBLE_TAP_MIN_GAP_MS, LEFT_DOUBLE_TAP_MAX_GAP_MS)`). Taps closer
	 * than the lower bound, or any third-and-later tap before a quiet gap, are a
	 * burst and never fire — so a stray click that makes the terminal emit a run
	 * of ← keys can no longer pop the Agent Hub.
	 */
	#detectLeftDoubleTap(): boolean {
		const now = Date.now();
		const sinceLast = now - this.ctx.lastLeftTapTime;
		this.ctx.lastLeftTapTime = now;
		if (sinceLast >= LEFT_DOUBLE_TAP_MAX_GAP_MS) {
			// Quiet gap: this tap starts a fresh sequence.
			this.#leftTapCount = 1;
			return false;
		}
		this.#leftTapCount += 1;
		if (this.#leftTapCount === 2 && sinceLast >= LEFT_DOUBLE_TAP_MIN_GAP_MS) {
			// Exactly two taps, the second a human-plausible interval after the first.
			this.#leftTapCount = 0;
			this.ctx.lastLeftTapTime = 0;
			return true;
		}
		return false;
	}

	#setupEnhancedPaste(): void {
		if (this.#enhancedPaste) return;

		this.#enhancedPaste = new EnhancedPasteController({
			write: data => this.ctx.ui.terminal.write(data),
			pasteText: text => {
				// Route enhanced-paste text to the currently focused component when it
				// exposes a `pasteText` hook (modal Input prompts: OAuth API-key entry,
				// Perplexity OTP, GitHub Enterprise URL, manual redirect URL). Falling
				// back to the main editor would have buried the text in the detached
				// editor while the modal Input had focus (#2127).
				const focused = this.ctx.ui.getFocused();
				const target = focused && focused !== this.ctx.editor && hasPasteText(focused) ? focused : this.ctx.editor;
				target.pasteText(text);
				this.ctx.ui.requestRender();
			},
			pasteImage: async image => {
				// Images can only land in the main editor — when a modal Input is
				// focused, refuse rather than dump the binary blob in a hidden buffer.
				const focused = this.ctx.ui.getFocused();
				if (focused && focused !== this.ctx.editor && hasPasteText(focused)) {
					this.ctx.showStatus("Image paste is not supported in this prompt");
					return;
				}
				await this.#normalizeAndInsertPastedImage(image, `Unsupported pasted image format: ${image.mimeType}`);
			},
			showStatus: message => this.ctx.showStatus(message),
		});
		this.ctx.ui.addInputListener(data => (this.#enhancedPaste?.handleInput(data) ? { consume: true } : undefined));
		this.ctx.ui.addStartListener(() => this.#enhancedPaste?.enable());
	}

	/** Enforce the deleted-chip contract at submit time: images whose inline token was removed
	 *  from the draft are dropped, and surviving markers are renumbered to the dense 1..K the
	 *  positional `[Image #N] ↔ images[N-1]` mapping requires. Returns the rewritten text. */
	#compactDraftImages(text: string): string {
		const editor = this.ctx.editor;
		const compacted = compactImageMarkers(text, editor.pendingImages.length);
		if (!compacted) return text;
		editor.pendingImages = compacted.keep.map(i => editor.pendingImages[i]);
		editor.pendingImageLinks = compacted.keep.map(i => editor.pendingImageLinks[i]);
		editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		return compacted.text.trim();
	}

	setupEditorSubmitHandler(): void {
		this.ctx.editor.onSubmit = async (text: string) => {
			text = this.#compactDraftImages(text.trim());
			const hasPendingImages = this.ctx.editor.pendingImages.length > 0;
			if ((!isSettingsInitialized() || settings.get("emojiAutocomplete")) && text) text = expandEmoticons(text);

			// Focused subagent session: the editor is a plain chat box for it.
			// Everything below (continue shortcuts, slash/bash/python, loop,
			// compaction queueing) is main-session-only.
			if (this.ctx.focusedAgentId) {
				await this.#submitToFocusedSession(text, "steer");
				return;
			}

			// Empty submit while streaming with queued messages: abort the active
			// turn and let the post-unwind drain deliver the agent-core queue.
			if (!text && !hasPendingImages && this.ctx.session.isStreaming) {
				if (this.ctx.session.queuedMessageCount > 0) {
					const aborting = this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
					await aborting;
					this.ctx.updatePendingMessagesDisplay();
					this.ctx.ui.requestRender();
				}
				return;
			}

			if (!text && !hasPendingImages) return;

			// Continue shortcuts: "." or "c" resume the agent with a hidden agent-authored
			// developer directive (no visible user message) instead of an empty turn, so the
			// model continues the prior intent rather than second-guessing the interrupt.
			if (text === "." || text === "c") {
				if (this.ctx.onInputCallback) {
					this.ctx.editor.clearDraft();
					this.ctx.onInputCallback({
						text: manualContinuePrompt,
						cancelled: false,
						started: true,
						synthetic: true,
						userInitiated: true,
					});
				}
				return;
			}

			const runner = this.ctx.session.extensionRunner;
			let inputImages = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
			let inputImageLinks =
				this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
			let hasInputImages = (inputImages?.length ?? 0) > 0;
			const submittedImages = inputImages;

			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, inputImages, "interactive");
				if (result?.handled) {
					this.ctx.editor.clearDraft();
					return;
				}
				if (result?.text !== undefined) {
					text = result.text.trim();
				}
				if (result?.images !== undefined) {
					inputImages = result.images;
					inputImageLinks = await materializeImageReferenceLinks(
						inputImages,
						this.ctx.sessionManager.putBlob.bind(this.ctx.sessionManager),
					);
				}
				hasInputImages = (inputImages?.length ?? 0) > 0;
			}
			const submittedMode = parseSlashCommand(text)?.name;
			const draftDetached =
				submittedMode === "plan" ||
				submittedMode === "vibe" ||
				submittedMode === "goal" ||
				submittedMode === "guided-goal";
			if (
				draftDetached &&
				submittedImages?.length &&
				submittedImages.every((image, index) => this.ctx.editor.pendingImages[index] === image)
			) {
				this.ctx.editor.pendingImages.splice(0, submittedImages.length);
				this.ctx.editor.pendingImageLinks.splice(0, submittedImages.length);
				this.ctx.editor.imageLinks =
					this.ctx.editor.pendingImageLinks.length > 0 ? this.ctx.editor.pendingImageLinks : undefined;
			}

			if (!text && !hasInputImages) return;

			const queueBody = parseQueueShorthand(text);
			if (queueBody !== undefined) {
				await this.#queueForYield(queueBody, {
					historyText: text,
					images: inputImages,
					imageLinks: inputImageLinks,
				});
				return;
			}

			// Handle built-in slash commands
			if (text) {
				this.#recordSlashCommandUsage(text);
				const input =
					(inputImages?.length ?? 0) > 0 || (inputImageLinks?.length ?? 0) > 0
						? { images: inputImages, imageLinks: inputImageLinks }
						: undefined;
				const slashResult = await executeBuiltinSlashCommand(text, { ctx: this.ctx, input, draftDetached });
				if (slashResult === true) {
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					return;
				}
				if (typeof slashResult === "string") {
					// Command handled but returned remaining text to use as prompt.
					// Record the original slash command text so Up Arrow recalls
					// "/loop 10 fix bug" rather than just "fix bug".
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					text = slashResult;
				}
			}

			// Collab guest: prompts execute on the host; local slash/skill/bash/
			// python execution is host-only (builtins are gated inside
			// executeBuiltinSlashCommand, which already consumed allowed ones).
			if (this.ctx.collabGuest) {
				if (text.startsWith("/")) {
					this.ctx.showStatus(`${text.split(/\s+/, 1)[0]} is host-only during a collab session`);
					this.ctx.editor.setText("");
					return;
				}
				if (text.startsWith("!") || parsePythonCommandInput(text)) {
					this.ctx.showStatus("Local execution is host-only during a collab session");
					this.ctx.editor.setText("");
					return;
				}
				if (this.ctx.collabGuest.readOnly) {
					// Keep the typed text: the prompt was not consumed.
					this.ctx.showStatus("This collab link is read-only — prompting is disabled");
					return;
				}
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.clearDraft(text);
				// No local render: the prompt comes back from the host as a
				// collab-prompt event/entry and renders with the author badge.
				this.ctx.collabGuest.sendPrompt(text, images);
				return;
			}

			// Handle skill commands (/skill:name [args]). Enter ⇒ steer (matches the
			// free-text Enter semantics below); Ctrl+Enter routes through `handleFollowUp`.
			// During compaction, queue immediately so bash/python/loop-mode branches do
			// not consume the skill before the compaction-resume path re-parses it.
			if (text && isKnownSkillCommand(this.ctx, text)) {
				if (this.ctx.session.isCompacting) {
					const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
					this.ctx.queueCompactionMessage(text, "steer", images);
					return;
				}
				if (await this.#invokeSkillCommand(text, "steer", inputImages, inputImageLinks)) {
					return;
				}
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.ctx.session.isBashRunning) {
						this.ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handleBashCommand(command, isExcluded);
					this.ctx.isBashMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			// Handle python command (`$ <code>` for normal, `$$ <code>` for excluded from context).
			// Shell-style variables such as `$HOME` are normal prose unless a space follows the sigil.
			const pythonCommand = parsePythonCommandInput(text);
			if (pythonCommand) {
				const { code, isExcluded } = pythonCommand;
				if (code) {
					if (this.ctx.session.isEvalRunning) {
						this.ctx.showWarning("A Python execution is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handlePythonCommand(code, isExcluded);
					this.ctx.isPythonMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			// While loop mode is on, every user-typed prompt becomes the new loop
			// prompt that auto-resubmits after each yield.
			if (this.ctx.loopModeEnabled) {
				this.ctx.setLoopPrompt(text);
			}

			// Queue input during compaction
			if (this.ctx.session.isCompacting) {
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.queueCompactionMessage(text, "steer", images);
				return;
			}
			// Extension commands are local actions. Execute them before the normal
			// submission path creates an optimistic user message; otherwise a
			// consumed command remains rendered like a prompt sent to the model.
			if (this.#isLocalExtensionCommand(text)) {
				this.ctx.editor.clearDraft(text);
				try {
					await this.ctx.session.prompt(text, { images: inputImages });
				} catch (error) {
					if (inputImages && inputImages.length > 0) {
						this.ctx.editor.pendingImages = [...inputImages];
						this.ctx.editor.pendingImageLinks = inputImageLinks
							? [...inputImageLinks]
							: inputImages.map(() => undefined);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
					this.ctx.editor.setCollapsedText(text);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.ctx.session.isStreaming) {
				this.ctx.editor.addToHistory(text);
				this.ctx.editor.setText("");
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];
				// Record the signature so the queued message's eventual delivery
				// (a user-role `message_start` event) leaves any draft the user has
				// typed since queuing intact. Same protection as #783, applied to
				// the streaming/queue path.
				try {
					await this.ctx.withLocalSubmission(
						text,
						() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
						{ imageCount: images?.length ?? 0 },
					);
				} catch (error) {
					// Don't lose the queued steer draft: restore images then the collapsed
					// text so chip tokens (and band cards) survive the retry.
					if (images && images.length > 0) {
						this.ctx.editor.pendingImages = [...images];
						this.ctx.editor.pendingImageLinks = inputImageLinks
							? [...inputImageLinks]
							: images.map(() => undefined);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
					this.ctx.editor.setCollapsedText(text);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.ctx.flushPendingBashComponents();

			if (this.ctx.onInputCallback) {
				// Include any pending images from clipboard paste
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];

				// Render user message immediately, then let session events catch up.
				// Tag the submission as "steer": this is a normal Enter the controller
				// believed was idle, but a background turn can start in the gap before
				// `submitInteractiveInput` dispatches it. Steering matches the
				// streaming-branch Enter (above) and keeps the message from throwing
				// AgentBusyError on that race.
				const submission = this.ctx.startPendingSubmission({
					text,
					images,
					imageLinks: inputImageLinks,
					streamingBehavior: "steer",
				});
				// Start titling only after the optimistic row painted, so the local
				// tiny-title worker's subprocess spawn never blocks the first frame.
				this.#maybeStartTitleGeneration(text);

				this.ctx.onInputCallback(submission);
			} else {
				// No input waiter: the main loop is between turns (post-turn
				// epilogue, retry backoff, or a scheduled continue) with the agent
				// momentarily idle. The editor already cleared itself on Enter, so
				// falling through here would silently swallow the message. Submit a
				// real prompt directly; if a background turn starts in the gap,
				// `streamingBehavior: "steer"` preserves the typed-message queueing
				// semantics instead of throwing AgentBusyError.
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];
				this.#maybeStartTitleGeneration(text);
				try {
					await this.ctx.withLocalSubmission(
						text,
						() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
						{
							imageCount: images?.length ?? 0,
						},
					);
				} catch (error) {
					// Don't lose the message: hand images then collapsed text back to the
					// editor so the user can retry (e.g. prompt dispatch rejecting an
					// extension command).
					if (images && images.length > 0) {
						this.ctx.editor.pendingImages = [...images];
						this.ctx.editor.pendingImageLinks = inputImageLinks
							? [...inputImageLinks]
							: images.map(() => undefined);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
					this.ctx.editor.setCollapsedText(text);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
			this.ctx.editor.addToHistory(text);
		};
	}

	/**
	 * Kick off session-title generation after the optimistic user row paints.
	 * Local extension commands are consumed before reaching the shared session
	 * title gate and must not name the conversation.
	 */
	#isLocalExtensionCommand(text: string): boolean {
		const extensionCommandSpace = text.indexOf(" ");
		return (
			text.startsWith("/") &&
			this.ctx.session.extensionRunner?.getCommand(
				extensionCommandSpace === -1 ? text.slice(1) : text.slice(1, extensionCommandSpace),
			) !== undefined
		);
	}

	#maybeStartTitleGeneration(text: string): void {
		if (this.#isLocalExtensionCommand(text)) {
			return;
		}
		this.ctx.session.maybeStartTitleGeneration(text, () => {
			this.#showTinyTitleDownloadProgress(this.ctx.settings.get("providers.tinyModel"));
		});
	}

	/** Submit editor text to the focused subagent session (chat-only focus policy). */
	async #submitToFocusedSession(text: string, streamingBehavior: "steer" | "followUp"): Promise<void> {
		const target = this.ctx.viewSession;
		const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
		const imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
		if (!text && !images) {
			if (target.isStreaming && target.queuedMessageCount > 0) {
				const aborting = target.abort({ reason: USER_INTERRUPT_LABEL });
				await aborting;
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
			return;
		}
		if (text && (text.startsWith("/") || text.startsWith("!") || parsePythonCommandInput(text))) {
			this.ctx.showStatus("Commands run in the main session — press ←← to return first");
			return; // editor text not cleared: Editor does not auto-clear on submit
		}
		this.ctx.editor.clearDraft(text);
		try {
			// prompt() handles idle (new turn) and streaming (queues per streamingBehavior).
			await this.ctx.withLocalSubmission(text, () => target.prompt(text, { streamingBehavior, images }), {
				imageCount: images?.length ?? 0,
			});
		} catch (error) {
			// Hand the message back, mirroring the main submit error path: restore
			// pasted images so the user can retry an image-only or text+image draft.
			if (images && images.length > 0) {
				this.ctx.editor.pendingImages = [...images];
				this.ctx.editor.pendingImageLinks = imageLinks ? [...imageLinks] : images.map(() => undefined);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
			this.ctx.editor.setCollapsedText(text);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}

	handleCtrlC(): void {
		// Sync-flush the session JSONL so in-flight writes survive a hard exit.
		// The TUI consumes Ctrl+C as a key event in raw mode, so postmortem's
		// process-level SIGINT handler never fires. shutdown() awaits its own
		// async flush — this sync pass is a superset that also covers the
		// first-press case and the hard-abort path below.
		try {
			this.ctx.sessionManager.flushSync();
		} catch (err) {
			logger.warn("session-manager sync flush on Ctrl+C failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Hard-abort: a Ctrl+C arriving while shutdown() is already running
		// means the user has waited long enough for whatever teardown step is
		// stuck (typically an extension's session_shutdown handler hanging on
		// IPC). The 2s session_shutdown cap (see runner.ts) already bounds the
		// common case; this is the defense-in-depth ladder for everything
		// else. See issue #2600.
		if (this.ctx.isShuttingDown) {
			process.exit(130); // 128 + SIGINT
		}

		const now = Date.now();
		if (now - this.ctx.lastSigintTime < 500) {
			void this.ctx.shutdown();
		} else {
			this.ctx.clearEditor();
			this.ctx.lastSigintTime = now;
		}
	}

	handleCtrlD(): void {
		// Editor text (if any) is snapshotted at the start of shutdown() and
		// persisted as a draft for the next resume. Empty text is also fine —
		// shutdown clears any stale sidecar in that case.
		void this.ctx.shutdown();
	}

	handleCtrlZ(): void {
		// Job-control suspend is POSIX-only: on Windows `process.kill(_, "SIGSTOP")`
		// throws `TypeError: Unknown signal: SIGSTOP` and takes the whole agent down
		// via an uncaught exception (issue #2036, originally for SIGTSTP — same
		// shape for SIGSTOP). No-op on platforms that cannot suspend.
		if (process.platform === "win32") {
			this.ctx.showStatus("Suspend (Ctrl+Z) is not supported on this platform");
			return;
		}

		// Capture the listener so we can detach it if the signal never fires;
		// otherwise a failed suspend would leave a stale SIGCONT handler that
		// fires on the next unrelated continue and tries to re-`start()` an
		// already-running TUI.
		const onResume = (): void => {
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
		};
		process.once("SIGCONT", onResume);

		// Stop the TUI (restore terminal to normal mode) before sending the
		// signal so the parent shell sees a sane terminal state.
		this.ctx.ui.stop();

		try {
			// SIGSTOP — not SIGTSTP — to the foreground process group (pid=0).
			//
			// SIGTSTP: brush-core (the embedded shell behind every bash tool call)
			// installs a tokio SIGTSTP listener on `Process::wait` to detect when
			// its children have been stopped (`crates/vendor/brush-core/src/sys/
			// unix/signal.rs::tstp_signal_listener` → `tokio::signal::unix::
			// signal(SIGTSTP)`). Per tokio's documented contract, the first call
			// for a given SignalKind permanently replaces the kernel-default
			// handler for the lifetime of the process. So once the user has
			// issued even one bash command — e.g. `/usr/bin/true` — SIGTSTP no
			// longer stops omp: tokio swallows it and the TUI ends up torn down
			// while the process keeps running with no live terminal (issue
			// [#3461]). SIGSTOP cannot be caught, blocked, or ignored, so the
			// kernel stops the process regardless of installed handlers.
			//
			// pid=0 (foreground process group, not just our PID): omp is not
			// always the shell's direct child. Package-manager launchers (`npx`,
			// `pnpm exec`, `bunx`, …) wait on the real CLI from a parent shim
			// that shares omp's process group, and a `omp … | tee log` style
			// pipeline puts a sibling foreground job member in the same group
			// too. The shell sees the job as stopped only when its direct
			// child / pipeline leader is stopped, so suspending only our PID
			// leaves wrappers and pipeline peers running and the terminal
			// hung — exactly the failure shape we're fixing. Stopping the whole
			// group keeps the shell's job-control view consistent. Long-lived
			// children that must survive the suspend (Linux/other POSIX MCP stdio
			// servers via the platform-specific `detached: true` spawn in
			// `mcp/transports/stdio.ts`, every brush external command via brush's
			// per-child `setsid` in `crates/vendor/brush-core/src/commands.rs`) are
			// their own sessions, so pgid=0 does not reach them.
			process.kill(0, "SIGSTOP");
		} catch (err) {
			// The runtime refused the signal (e.g. seccomp filter blocks SIGSTOP
			// delivery to the process group). Tear the resume hook down and
			// bring the TUI back so the user is not stranded on a frozen prompt.
			process.removeListener("SIGCONT", onResume);
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
			const reason = err instanceof Error ? err.message : String(err);
			this.ctx.showError(`Failed to suspend: ${reason}`);
		}
	}

	handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.ctx.showStatus("No queued messages to restore");
		} else {
			this.ctx.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	/**
	 * Dispatch a `/skill:<name> [args]` invocation through `promptCustomMessage`
	 * using the supplied `streamingBehavior`. Returns false when the text is not
	 * a registered skill command and leaves the editor state untouched. Registered
	 * skills consume the full composer draft (text plus pending images) before
	 * dispatch; if dispatch rejects, the draft is restored so the user can retry.
	 */
	async #invokeSkillCommand(
		text: string,
		streamingBehavior: "steer" | "followUp",
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
	): Promise<boolean> {
		if (!isKnownSkillCommand(this.ctx, text)) return false;
		const draftImages = images && images.length > 0 ? [...images] : undefined;
		const draftImageLinks = draftImages && imageLinks && imageLinks.length > 0 ? [...imageLinks] : undefined;
		const restoreDraft = () => {
			this.ctx.editor.setText(text);
			if (draftImages && draftImages.length > 0) {
				this.ctx.editor.pendingImages = [...draftImages];
				this.ctx.editor.pendingImageLinks = draftImageLinks
					? [...draftImageLinks]
					: draftImages.map(() => undefined);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
		};

		this.ctx.editor.clearDraft(text);
		let optimistic = false;
		try {
			// Build the user-attributed skill message once so the optimistic
			// transcript row and the dispatched message share content.
			const built = await buildSkillCommandPrompt(this.ctx, text, streamingBehavior, draftImages);
			if (!built) {
				restoreDraft();
				return false;
			}
			// Paint the row before the awaited dispatch so a slow preflight (memory
			// recall, before_agent_start hooks, auto-thinking, pre-prompt compaction)
			// does not leave the submission invisible (issue #8895). A streaming
			// submission queues instead and surfaces its chip, so only paint when the
			// turn will run fresh.
			optimistic = !this.ctx.session.isStreaming;
			if (optimistic) {
				// Mirror the message promptCustomMessage will build for the turn so the
				// canonical message_start reconciles this row rather than duplicating it.
				this.ctx.renderOptimisticSkillMessage(
					{ role: "custom", ...built.message, timestamp: Date.now() },
					{ imageLinks: draftImageLinks },
				);
			}
			await this.ctx.session.promptCustomMessage(built.message, built.options);
			return true;
		} catch (error) {
			if (optimistic) this.ctx.clearOptimisticSkillMessage();
			restoreDraft();
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return true;
		} finally {
			if (optimistic && this.ctx.optimisticSkillMessagePending) {
				// Dispatch resolved without a canonical skill message_start (aborted
				// preflight, or a streaming-race requeue): drop the pending row.
				this.ctx.clearOptimisticSkillMessage();
			}
			if (this.ctx.session.isStreaming) {
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
		}
	}

	async handleRetry(): Promise<void> {
		if (this.ctx.collabGuest) {
			this.ctx.showStatus("/retry is host-only during a collab session");
			return;
		}
		const didRetry = await this.ctx.viewSession.retry();
		if (didRetry) {
			this.ctx.editor.clearDraft();
		} else {
			this.ctx.showStatus("Nothing to retry");
		}
	}

	/** Queue `/queue` input behind an active turn, or start it immediately when idle. */
	async handleQueueCommand(text: string): Promise<void> {
		const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
		const imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
		await this.#queueForYield(text, { images, imageLinks });
	}

	async #queueForYield(
		text: string,
		options: {
			historyText?: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
		},
	): Promise<void> {
		const splitMessages = splitQueuedMessages(text);
		if (splitMessages.length === 0 && !options.images?.length) {
			this.ctx.editor.clearDraft();
			this.ctx.showWarning("Usage: /queue <message> (or start a prompt with -> / =>)");
			return;
		}

		const messages = splitMessages.length > 0 ? splitMessages : [""];
		const originalDraft = this.ctx.editor.getText();
		const images = options.images?.length ? [...options.images] : undefined;
		const imageLinks = options.imageLinks
			? [...options.imageLinks]
			: images
				? images.map(() => undefined)
				: undefined;
		this.ctx.editor.clearDraft(options.historyText);

		if (this.ctx.session.isCompacting) {
			for (let index = 0; index < messages.length; index++) {
				this.ctx.compactionQueuedMessages.push({
					text: messages[index] ?? "",
					mode: "followUp",
					images: index === 0 ? images : undefined,
				});
			}
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showStatus(
				messages.length === 1
					? "Queued message for after compaction"
					: `Queued ${messages.length} messages for after compaction`,
			);
			this.ctx.ui.requestRender();
			return;
		}

		const startImmediately = !this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount === 0;
		let queuedCount = 0;
		try {
			if (startImmediately && this.ctx.onInputCallback) {
				const first = messages[0] ?? "";
				const submission = this.ctx.startPendingSubmission({
					text: first,
					images,
					imageLinks,
					streamingBehavior: "followUp",
				});
				this.ctx.onInputCallback(submission);
				queuedCount = 1;
			}
			while (queuedCount < messages.length) {
				const message = messages[queuedCount] ?? "";
				const queuedImages = queuedCount === 0 ? images : undefined;
				await this.ctx.withLocalSubmission(
					message,
					async () => {
						if (startImmediately && queuedCount === 0) {
							await this.ctx.session.prompt(message, {
								images: queuedImages,
								streamingBehavior: "followUp",
							});
						} else {
							await this.ctx.session.followUp(message, queuedImages);
						}
					},
					{ imageCount: queuedImages?.length ?? 0 },
				);
				queuedCount++;
			}
		} catch (error) {
			if (queuedCount === 0) {
				this.ctx.editor.setText(originalDraft);
				if (images) {
					this.ctx.editor.pendingImages = images;
					this.ctx.editor.pendingImageLinks = imageLinks ?? images.map(() => undefined);
					this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
				}
			} else {
				const remaining = messages.slice(queuedCount);
				const restored =
					remaining.length === 1
						? `=> ${remaining[0]}`
						: `=>\n${remaining
								.map((message, index) => `${index + 1}. ${message.replaceAll("\n", "\n   ")}`)
								.join("\n")}`;
				this.ctx.editor.setText(restored);
			}
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}

		this.ctx.updatePendingMessagesDisplay();
		if (queuedCount === messages.length) {
			this.ctx.showStatus(
				startImmediately
					? queuedCount === 1
						? "Sent queued message"
						: `Sent first message; queued ${queuedCount - 1} for later yields`
					: queuedCount === 1
						? "Queued message for when the agent yields"
						: `Queued ${queuedCount} messages for when the agent yields`,
			);
		}
		this.ctx.ui.requestRender();
	}

	/** Send editor text as a follow-up message (queued behind current stream). */
	async handleFollowUp(): Promise<void> {
		let text = this.#compactDraftImages(this.ctx.editor.getExpandedText().trim());
		const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
		const imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
		if (!text && !images) return;

		// Focused subagent session: follow-ups go to it; non-chat input is gated.
		if (this.ctx.focusedAgentId) {
			await this.#submitToFocusedSession(text, "followUp");
			return;
		}

		// Compaction first: while compacting, free text gets queued via
		// `queueCompactionMessage`, and `/skill:*` rides the same queue so a
		// skill typed during compaction is not lost or short-circuited through
		// `promptCustomMessage`. The compaction-resume path re-parses the
		// queued text into a user-attributed skill invocation before delivery.
		if (this.ctx.session.isCompacting) {
			const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
			this.ctx.queueCompactionMessage(text, "followUp", images);
			return;
		}

		if (text) {
			const input = (images?.length ?? 0) > 0 || (imageLinks?.length ?? 0) > 0 ? { images, imageLinks } : undefined;
			const slashResult = await executeBuiltinSlashCommand(text, { ctx: this.ctx, input });
			if (slashResult === true) {
				if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
				return;
			}
			if (typeof slashResult === "string") {
				// Command handled but returned remaining text to use as prompt.
				// Record the original slash command text so Up Arrow recalls it.
				if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
				text = slashResult;
			}
		}

		// Skill commands invoke through the custom-message path regardless of
		// which keybinding submitted them. Enter routes them as `steer`;
		// Ctrl+Enter (this handler) routes them as `followUp`.
		if (text && (await this.#invokeSkillCommand(text, "followUp", images, imageLinks))) {
			return;
		}

		// Hand the message back on dispatch failure (model/API-key validation,
		// queue rejection): restore both text AND pending images so an image-only
		// or text+image draft can be retried, mirroring the main submit error path.
		const restoreOnError = (error: unknown) => {
			if (images && images.length > 0) {
				this.ctx.editor.pendingImages = [...images];
				this.ctx.editor.pendingImageLinks = imageLinks ? [...imageLinks] : images.map(() => undefined);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
			// Collapse restores the chip tokens (and their band cards) for the failed draft.
			this.ctx.editor.setCollapsedText(text);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		};

		if (this.ctx.session.isStreaming) {
			this.ctx.editor.clearDraft(text);
			try {
				await this.ctx.withLocalSubmission(
					text,
					() => this.ctx.session.prompt(text, { streamingBehavior: "followUp", images }),
					{ imageCount: images?.length ?? 0 },
				);
			} catch (error) {
				restoreOnError(error);
			}
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		// Not streaming — just submit normally
		this.ctx.editor.clearDraft(text);
		try {
			await this.ctx.withLocalSubmission(text, () => this.ctx.session.prompt(text, { images }), {
				imageCount: images?.length ?? 0,
			});
		} catch (error) {
			restoreOnError(error);
		}
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		this.ctx.locallySubmittedUserSignatures.clear();
		// On Esc (abort) drop non-user internal steers so the post-abort drain can't
		// auto-resume; plain Alt+Up dequeue preserves them for the continuing stream.
		const { steering, followUp } = this.ctx.session.clearQueue({ forInterrupt: options?.abort });
		// Messages typed while compacting live in `compactionQueuedMessages`, not the
		// agent queue `clearQueue()` drains — but the pending bar shows the same
		// "Alt+Up to edit" hint for them (ui-helpers `updatePendingMessagesDisplay`).
		// Drain them here too so the dequeue restores every message the hint
		// advertises; otherwise a skill/text queued during compaction is stranded and
		// Alt+Up reports "No queued messages to restore".
		const compactionQueued = this.ctx.compactionQueuedMessages;
		this.ctx.compactionQueuedMessages = [];
		const allQueued = [
			...steering,
			...compactionQueued.filter(e => e.mode === "steer").map(e => ({ text: e.text, images: e.images })),
			...followUp,
			...compactionQueued.filter(e => e.mode === "followUp").map(e => ({ text: e.text, images: e.images })),
		];
		if (allQueued.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			if (options?.abort) {
				void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
			}
			return 0;
		}
		// Image markers are positional: `[Image #N]` ↔ `pendingImages[N-1]`
		// (legacy drafts may still carry a trailing `attachment://N`). Each queued
		// message numbered its references against its own local image list
		// (1..K). Because we prepend the queued text but append the queued images
		// to `pendingImages`, any existing draft images (M of them) — plus images
		// already pulled in by earlier queued messages — shift the slot index that
		// every reference must point to. Bumping each message's marker and URI
		// indices by the running offset keeps the merged text aligned with the merged
		// `pendingImages` order; draft markers stay valid because draft images
		// keep their original positions.
		const queuedImages = allQueued.flatMap(e => e.images ?? []);
		let queuedText: string;
		if (queuedImages.length > 0) {
			const parts: string[] = [];
			let imageOffset = this.ctx.editor.pendingImages.length;
			for (const entry of allQueued) {
				parts.push(shiftImageMarkers(entry.text, imageOffset));
				if (entry.images && entry.images.length > 0) imageOffset += entry.images.length;
			}
			queuedText = parts.join("\n\n");
		} else {
			queuedText = allQueued.map(e => e.text).join("\n\n");
		}
		const currentText = options?.currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");
		// Hand queued images back to the pending-image buffer first (links are
		// re-materialized lazily), then set the text: setCollapsedText folds the
		// renumbered `[Image #N, WxH]` references back into chip tokens, and the
		// collapse only recognizes indices within the merged pendingImages range.
		if (queuedImages.length > 0) {
			this.ctx.editor.pendingImages.push(...queuedImages);
			this.ctx.editor.pendingImageLinks.push(...queuedImages.map(() => undefined));
			this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		}
		this.ctx.editor.setCollapsedText(combinedText);
		this.ctx.updatePendingMessagesDisplay();
		if (options?.abort) {
			void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		return allQueued.length;
	}

	async #insertPendingImage(imageData: ImageContent): Promise<void> {
		const image: ImageContent = { type: "image", data: imageData.data, mimeType: imageData.mimeType };
		const imageLink = (
			await materializeImageReferenceLinks([image], this.ctx.sessionManager.putBlob.bind(this.ctx.sessionManager))
		)?.[0];
		this.ctx.editor.pendingImages.push(image);
		this.ctx.editor.pendingImageLinks.push(imageLink);
		this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		const imageNum = this.ctx.editor.pendingImages.length;
		const dims = await this.#imageDimensions(imageData);
		setCachedImageDimensions(image, dims ?? null);
		// The buffer holds the compact chip token; the atom table expands it to the bracketed
		// marker (the wire/transcript format) on submit.
		const expansion = dims ? `[Image #${imageNum}, ${dims.width}x${dims.height}]` : `[Image #${imageNum}]`;
		this.ctx.editor.insertAtom(chipLabel("image", imageNum), expansion);
		this.ctx.ui.requestRender();
	}

	/** Probe pixel dimensions for the marker label (`[Image #N, WxH]`). Returns undefined when the
	 *  header can't be decoded, so the caller falls back to a bare `[Image #N]`. */
	async #imageDimensions(image: ImageContent): Promise<{ width: number; height: number } | undefined> {
		try {
			const { width, height } = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
			if (width && height) return { width, height };
		} catch {
			// Unknown/corrupt header — fall back to a bare label.
		}
		return undefined;
	}

	async #normalizeAndInsertPastedImage(image: ImageContent, unsupportedMessage: string): Promise<boolean> {
		let imageData = await ensureSupportedImageInput(image);
		if (!imageData) {
			this.ctx.showStatus(unsupportedMessage);
			return false;
		}
		if (settings.get("images.autoResize")) {
			try {
				const resized = await resizeImage({
					type: "image",
					data: imageData.data,
					mimeType: imageData.mimeType,
				});
				imageData = { type: "image", data: resized.data, mimeType: resized.mimeType };
			} catch {
				// Keep the normalized image when resize fails.
			}
		}
		await this.#insertPendingImage(imageData);
		return true;
	}

	/**
	 * Win+Shift+S on Windows 11 leaves the screenshot bitmap on the clipboard
	 * while the terminal pastes a transient packaged-app TempState path
	 * (…\MicrosoftWindows.Client.Core_*\TempState\…) that is already gone — or
	 * never materialized — by the time we read it. Whenever a pasted image path
	 * can't be turned into an image locally, those clipboard bytes are the real
	 * payload, so prefer them before degrading to a text paste.
	 *
	 * Skipped over SSH: the clipboard read would hit the remote host, not the
	 * terminal that holds the screenshot. Returns true when the clipboard owned
	 * the outcome (image attached, or an unsupported-format status surfaced), so
	 * the caller stops without emitting its own degraded diagnostic.
	 */
	async #tryPasteClipboardImage(): Promise<boolean> {
		const env = process.env;
		if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
		try {
			const image = await this.clipboard.readImage();
			if (!image) return false;
			await this.#normalizeAndInsertPastedImage(
				{ type: "image", data: image.data.toBase64(), mimeType: image.mimeType },
				`Unsupported clipboard image format: ${image.mimeType}`,
			);
			return true;
		} catch {
			return false;
		}
	}

	async handleImagePathPaste(path: string): Promise<void> {
		try {
			const image = await loadImageInput({
				path,
				cwd: this.ctx.sessionManager.getCwd(),
				autoResize: false,
			});
			if (!image) {
				// Path resolved but is not a readable image (e.g. a zero-byte or
				// locked transient screenshot file). Prefer the clipboard bytes.
				if (await this.#tryPasteClipboardImage()) return;
				this.ctx.editor.pasteText(path);
				this.ctx.ui.requestRender();
				this.ctx.showStatus("Pasted path is not a supported image");
				return;
			}
			await this.#normalizeAndInsertPastedImage(
				{ type: "image", data: image.data, mimeType: image.mimeType },
				`Unsupported pasted image format: ${image.mimeType}`,
			);
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				this.ctx.editor.pasteText(path);
				this.ctx.ui.requestRender();
				this.ctx.showStatus(error.message);
				return;
			}
			if (isEnoent(error)) {
				// #2375: the bracketed paste forwarded by a local terminal carries a
				// path on the *local* filesystem. The bytes may still be on the
				// clipboard (Win+Shift+S), so try those before giving up.
				if (await this.#tryPasteClipboardImage()) return;
				// Over SSH the clipboard lives on the remote host, so the path is
				// genuinely unreachable; pasting it as text would look like the
				// image was attached when nothing was sent. Surface an SSH-aware
				// diagnostic instead. The pasted path is untrusted terminal input —
				// strip control/ANSI/newlines, collapse home to `~`, and bound the
				// displayed length before splicing it into the status string.
				const env = process.env;
				const overSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
				const displayPath = truncateToWidth(
					shortenPath(
						sanitizeText(path)
							.replace(/[\r\n\t]+/g, " ")
							.trim(),
					),
					TRUNCATE_LENGTHS.CONTENT,
				);
				this.ctx.showStatus(
					overSsh
						? `Image not found at ${displayPath}. Over SSH this path is local to your terminal — paste the image directly (clipboard image-paste shortcut) to send its bytes.`
						: `Image not found at ${displayPath}`,
				);
				return;
			}
			if (await this.#tryPasteClipboardImage()) return;
			this.ctx.editor.pasteText(path);
			this.ctx.ui.requestRender();
			this.ctx.showStatus("Failed to read pasted image path");
		}
	}

	async handleImagePaste(): Promise<boolean> {
		try {
			// When a modal paste-capable prompt (login/API-key Input) owns focus,
			// only clipboard text may land there. Image payloads must not mutate
			// the hidden main editor — mirror the enhanced-paste `pasteImage`
			// behavior and surface the unsupported-status instead (#6057).
			const focusedNow = this.ctx.ui.getFocused();
			const promptTarget =
				focusedNow && focusedNow !== this.ctx.editor && hasPasteText(focusedNow) ? focusedNow : null;
			// #8769: On macOS, Finder `Cmd+C` on an image file puts BOTH a
			// `public.file-url` representation and a generated 1024x1024
			// file-icon bitmap on the pasteboard. `arboard::get_image()`
			// succeeds with the icon, so probing the image representation first
			// would attach the generic Finder icon instead of the copied
			// screenshot — a vision model then sees a white `PNG` document
			// icon. Probe the file URLs before the bitmap and let any that
			// resolve to a supported image file win over the icon: the
			// authoritative file bytes are what the user copied.
			//
			// #3506: this branch also recovers file-url-only pasteboards
			// (Finder selections, certain screenshot tools) where
			// `arboard::get_image()` returns `ContentNotAvailable` and
			// `pbpaste` is empty. Every image-shaped path routes through
			// {@link handleImagePathPaste}, matching the bracketed-paste
			// handler in `CustomEditor.handleInput`; multi-image Finder
			// selections must not silently drop after the first attach.
			// `readMacFileUrls` returns an empty list off Darwin, so on every
			// other platform this is a no-op and the bitmap read below still
			// runs first.
			const fileUrls = promptTarget ? [] : ((await this.clipboard.readMacFileUrls?.()) ?? []);
			let attachedFromFileUrls = false;
			for (const url of fileUrls) {
				const candidate = extractImagePathFromText(url);
				if (!candidate) continue;
				await this.handleImagePathPaste(candidate);
				attachedFromFileUrls = true;
			}
			if (attachedFromFileUrls) return true;
			// No usable image-file URL (pure bitmap pasteboard: screenshots,
			// browser copies, or a non-image Finder selection). Fall to the
			// image representation.
			const image = await this.clipboard.readImage();
			if (image) {
				if (promptTarget) {
					this.ctx.showStatus("Image paste is not supported in this prompt");
					return false;
				}
				return await this.#normalizeAndInsertPastedImage(
					{
						type: "image",
						data: image.data.toBase64(),
						mimeType: image.mimeType,
					},
					`Unsupported clipboard image format: ${image.mimeType}`,
				);
			}
			// Smart paste (#1628): no image on the clipboard — fall back to
			// pasting its text so the same chord covers both payload kinds.
			// Hosts that pre-empt the terminal's own paste (VS Code's
			// integrated terminal, Win+V clipboard history) deliver only
			// this keypress, so a miss here must not dead-end.
			const text = await this.clipboard.readText();
			if (!text) {
				this.ctx.showStatus("Clipboard is empty");
				return false;
			}
			// #3506: when the clipboard text is an explicit image file path,
			// route through {@link handleImagePathPaste} so the image is
			// loaded and attached instead of pasting the path as literal
			// text. Covers terminals that paste the Finder file path as
			// plain text rather than as a `public.file-url` (most macOS
			// terminals do this for image clipboards).
			const imagePath = promptTarget ? null : extractImagePathFromText(text);
			if (imagePath) {
				await this.handleImagePathPaste(imagePath);
				return true;
			}
			// Route to the focused component when it accepts pastes (modal
			// Input prompts), matching the enhanced-paste text path (#2127).
			const target = promptTarget ?? this.ctx.editor;
			target.pasteText(text);
			this.ctx.ui.requestRender();
			return true;
		} catch {
			this.ctx.showStatus("Failed to read clipboard");
			return false;
		}
	}

	async handleClipboardTextRawPaste(): Promise<void> {
		try {
			const text = await this.clipboard.readText();
			if (text) {
				this.ctx.editor.insertText(text);
				this.ctx.ui.requestRender();
			} else {
				this.ctx.showStatus("No text in clipboard to paste raw");
			}
		} catch {
			this.ctx.showStatus("Failed to paste raw text from clipboard");
		}
	}

	/**
	 * Editor `onLargePaste` hook: gate a marker-sized paste behind the large-paste menu. Returns
	 * `true` to intercept (the editor skips its default `[Paste]` marker) once the paste reaches the
	 * configured `paste.largeMenuThreshold` line count; otherwise `false` for default collapse-to-marker
	 * behavior. The async menu is fired and forgotten — the editor only needs the synchronous verdict.
	 */
	handleLargePaste(text: string, lineCount: number): boolean {
		const threshold = this.ctx.settings.get("paste.largeMenuThreshold");
		if (!(threshold > 0) || lineCount < threshold) {
			// Below the menu threshold: stage the paste as a text-attachment chip
			// (compact token in the buffer, band card above the editor).
			this.ctx.editor.insertTextAttachment(text);
			return true;
		}
		void this.presentLargePasteMenu(text, lineCount);
		return true;
	}

	/**
	 * Present the large-paste menu and apply the chosen action: wrap in `<attachment>` tags (collapsed
	 * to a `[Paste]` marker that expands on submit), save the text to a file and reference its path so
	 * the agent can `read` it on demand, or paste inline. Cancelling (Esc) falls back to the default
	 * inline paste marker, so the pasted content is never lost.
	 */
	async presentLargePasteMenu(text: string, lineCount: number): Promise<void> {
		const WRAPPED_BLOCK = "Attach as a wrapped block";
		const LOCAL_FILE = "Attach as local file";
		const INLINE = "Paste inline";

		let choice: string | undefined;
		try {
			choice = await this.ctx.showHookSelector(
				`Pasted ${lineCount} lines`,
				[
					{ label: WRAPPED_BLOCK, description: "Wrap the text in <attachment> tags, collapsed to a marker" },
					{ label: LOCAL_FILE, description: "Save the text to a local://paste file" },
					{ label: INLINE, description: "Collapse the text to an inline paste marker" },
				],
				{ helpText: "Esc to paste inline" },
			);
		} catch (error) {
			logger.warn("large-paste menu failed", { error: error instanceof Error ? error.message : String(error) });
			choice = undefined;
		}

		switch (choice) {
			case WRAPPED_BLOCK:
				this.ctx.editor.insertTextAttachment(text, wrapPasteInAttachmentBlock(text));
				break;
			case LOCAL_FILE:
				await this.#attachPasteAsFile(text, lineCount);
				break;
			case INLINE:
				this.ctx.editor.insertTextAttachment(text);
				break;
			default:
				// Esc / cancel: keep the original behavior — stage as a text-attachment chip.
				this.ctx.editor.insertTextAttachment(text);
				break;
		}
		this.ctx.ui.requestRender();
	}

	/**
	 * Save a large paste to the session's `local://` store and insert a clean `local://paste-N.md`
	 * reference into the editor so the agent can `read` it on demand — instead of inlining the text or
	 * leaking a raw temp path. Falls back to an inline paste marker when the write fails, so the
	 * content is never lost.
	 */
	async #attachPasteAsFile(text: string, lineCount: number): Promise<void> {
		try {
			// Mirror the exact mapping the read tool's local:// resolver uses so a later
			// `read local://paste-N.md` lands on the file written here.
			const localRoot = resolveLocalRoot({
				getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
				getSessionId: () => this.ctx.sessionManager.getSessionId(),
			});
			let name: string;
			let filePath: string;
			do {
				this.#pasteCounter++;
				name = `paste-${this.#pasteCounter}.md`;
				filePath = path.join(localRoot, name);
			} while (await Bun.file(filePath).exists());
			await Bun.write(filePath, text);
			this.ctx.editor.insertText(`local://${name} `);
			this.ctx.showStatus(`Saved ${lineCount} pasted lines to local://${name}`);
		} catch (error) {
			logger.warn("failed to save large paste to file", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.ctx.editor.insertTextAttachment(text);
			this.ctx.showError("Failed to save paste to a file — attached as a text chip instead");
		}
	}

	/**
	 * Record a usage hit for a submitted known slash command so autocomplete
	 * can rank frequent commands first. Builtin aliases canonicalize to the
	 * primary name; skill/custom/file/template commands record their full
	 * first token (which may contain `:`).
	 */
	#recordSlashCommandUsage(text: string): void {
		if (!text.startsWith("/")) return;
		const token = text.slice(1).split(/\s+/, 1)[0] ?? "";
		if (!token) return;
		const session = this.ctx.session;
		const knownToken =
			this.ctx.skillCommands.has(token) ||
			this.ctx.fileSlashCommands.has(token) ||
			session.extensionRunner?.getCommand(token) !== undefined ||
			session.customCommands.some(loaded => loaded.command.name === token) ||
			session.promptTemplates.some(template => template.name === token);
		if (knownToken) {
			recordSlashCommandUsage(token);
			return;
		}
		const parsedName = parseSlashCommand(text)?.name;
		const builtin = parsedName ? lookupBuiltinSlashCommand(parsedName) : undefined;
		if (builtin) recordSlashCommandUsage(builtin.name);
	}

	createAutocompleteProvider(commands: SlashCommand[], basePath: string): AutocompleteProvider {
		void loadSlashCommandUsage();
		return createPromptActionAutocompleteProvider({
			commands,
			basePath,
			commandUsage: getSlashCommandUsage,
			keybindings: this.ctx.keybindings,
			copyCurrentLine: () => this.handleCopyCurrentLine(),
			copyPrompt: () => this.handleCopyPrompt(),
			undo: prefix => this.ctx.editor.undoPastTransientText(prefix),
			moveCursorToMessageEnd: () => this.ctx.editor.moveToMessageEnd(),
			moveCursorToMessageStart: () => this.ctx.editor.moveToMessageStart(),
			moveCursorToLineStart: () => this.ctx.editor.moveToLineStart(),
			moveCursorToLineEnd: () => this.ctx.editor.moveToLineEnd(),
		});
	}

	/** Copy the current editor line to the system clipboard. */
	handleCopyCurrentLine(): void {
		const { line } = this.ctx.editor.getCursor();
		const text = this.ctx.editor.getLines()[line] || "";
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied line: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	/** Copy current prompt text to system clipboard. */
	handleCopyPrompt(): void {
		const text = this.ctx.editor.getText();
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	cycleThinkingLevel(): void {
		if (this.ctx.focusedAgentId) {
			this.ctx.showStatus("Model/thinking apply to the main session — press ←← to return first");
			return;
		}
		const newLevel = this.ctx.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.ctx.showStatus("Current model does not support thinking");
		} else {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}
	}

	async cycleRoleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
		if (this.ctx.focusedAgentId) {
			this.ctx.showStatus("Model/thinking apply to the main session — press ←← to return first");
			return;
		}
		try {
			const cycleOrder = settings.get("cycleOrder");
			const result = await this.ctx.session.cycleRoleModels(cycleOrder, direction);
			if (!result) {
				this.ctx.showStatus("Only one role model available");
				return;
			}

			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			// The status line already reports the resolved model + thinking level, so
			// the cycle status is just a status-line-style chip track (active role
			// filled), matching the plan-approval model slider. It renders into its
			// own anchored container above the editor (cleared+rebuilt each cycle),
			// so it updates in place instead of stacking duplicates in the scrollback.
			const track = renderSegmentTrack(
				cycleOrder.map(role => ({ label: role })),
				cycleOrder.indexOf(result.role),
			);
			this.ctx.showModelCycleTrack(track);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	toggleToolOutputExpansion(): void {
		if (this.ctx.hideToolActivity) {
			const visibilityKey = this.ctx.keybindings.getDisplayString("app.tools.toggleVisibility");
			const visibilityHint = visibilityKey ? `${visibilityKey} or /settings` : "/settings";
			this.ctx.showStatus(`Tool activity is hidden — show it with ${visibilityHint} before expanding`);
			return;
		}
		this.setToolsExpanded(!this.ctx.toolOutputExpanded);
		this.ctx.showStatus(`Tool output expansion: ${this.ctx.toolOutputExpanded ? "enabled" : "disabled"}`);
	}

	toggleToolActivityVisibility(): void {
		this.ctx.hideToolActivity = !this.ctx.hideToolActivity;
		this.ctx.settings.set("display.hideToolActivity", this.ctx.hideToolActivity);

		if (!this.ctx.hideToolActivity) {
			this.ctx.toolOutputExpanded = false;
		}

		for (const child of this.ctx.chatContainer.children) {
			if (
				!this.ctx.hideToolActivity &&
				(child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent)
			) {
				child.setExpanded(false);
			} else if (child instanceof AssistantMessageComponent) {
				child.setToolResultImagesVisible(!this.ctx.hideToolActivity);
			}
		}
		this.ctx.chatContainer.setToolActivityVisible(!this.ctx.hideToolActivity);

		if (this.ctx.hideToolActivity) this.ctx.ui.clearInlineImages();
		this.ctx.ui.requestRender(true);
		this.ctx.showStatus(`Tool activity: ${this.ctx.hideToolActivity ? "hidden" : "visible"}`);
	}

	setToolsExpanded(expanded: boolean): void {
		this.ctx.toolOutputExpanded = expanded;
		for (const child of this.ctx.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		// Toggling expansion mutates every live block; blocks already committed to
		// terminal history stay at their committed presentation.
		this.ctx.ui.requestRender(true);
	}

	toggleThinkingBlockVisibility(): void {
		// When thinking is "off" and the session has not produced reasoning
		// content, thinking blocks stay auto-hidden; the toggle would only corrupt
		// the persisted preference. OpenAI-compatible servers can stream reasoning
		// without advertising model support, so observed thinking content unlocks
		// the display toggle.
		const thinkingOff =
			((this.ctx.viewSession ?? this.ctx.session)?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
		if (thinkingOff && !this.ctx.hasDisplayableThinkingContent) {
			this.ctx.showStatus("Thinking is off — enable thinking to show blocks");
			return;
		}
		this.ctx.hideThinkingBlock = !this.ctx.hideThinkingBlock;
		this.ctx.settings.set("hideThinkingBlock", this.ctx.hideThinkingBlock);

		for (const child of this.ctx.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			}
		}

		if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
		}

		// This is an explicit user display gesture: rebuild native history so the
		// visibility change also applies to rows already retired from the viewport.
		// Append-only thinking heads emitted their stable rows to scrollback while
		// streaming (visible); forget that emission ledger so the paired scrollback
		// clear re-renders them under the new visibility instead of replaying the
		// captured reasoning (#10177).
		this.ctx.chatContainer.resetStableEmission();
		this.ctx.ui.resetDisplay();

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	async openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.ctx.editor.getExpandedText?.() ?? this.ctx.editor.getText();

		try {
			this.ctx.ui.stop();
			const result = await openInEditor(editorCmd, currentText, { extension: ".omp.md" });
			if (result !== null) {
				this.ctx.editor.setText(result);
			}
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	registerExtensionShortcuts(): void {
		const runner = this.ctx.session.extensionRunner;
		if (!runner) return;

		const shortcuts = runner.getShortcuts();
		for (const [keyId, shortcut] of shortcuts) {
			this.ctx.editor.setCustomKeyHandler(keyId, () => {
				const ctx = runner.createCommandContext();
				try {
					shortcut.handler(ctx);
				} catch (err) {
					runner.emitError({
						extensionPath: shortcut.extensionPath,
						event: "shortcut",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			});
		}
	}
}
