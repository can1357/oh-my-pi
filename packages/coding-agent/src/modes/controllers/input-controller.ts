import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import { type AutocompleteProvider, matchesKey, type SlashCommand } from "@pk-nerdsaver-ai/pi-tui";
import { $env, isEnoent, logger, sanitizeText } from "@pk-nerdsaver-ai/pi-utils";
import { isSettingsInitialized, settings } from "../../config/settings";
import { resolveLocalRoot } from "../../internal-urls";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { extractImagePathFromText } from "../../modes/components/custom-editor";
import { renderSegmentTrack } from "../../modes/components/segment-track";
import { TinyTitleDownloadProgressComponent } from "../../modes/components/tiny-title-download-progress";
import { expandEmoticons } from "../../modes/emoji-autocomplete";
import { materializeImageReferenceLinks, shiftImageMarkers } from "../../modes/image-references";
import { isOwnerCommandInFlight } from "../../modes/owner-command-guard";
import { createPromptActionAutocompleteProvider } from "../../modes/prompt-action-autocomplete";
import type { InteractiveModeContext } from "../../modes/types";
import manualContinuePrompt from "../../prompts/system/manual-continue.md" with { type: "text" };
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails, USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeBuiltinSlashCommand, shouldPersistBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { isTinyTitleLocalModelKey } from "../../tiny/models";
import { isLowSignalTitleInput } from "../../tiny/text";
import { tinyTitleClient } from "../../tiny/title-client";
import type { TinyTitleProgressEvent } from "../../tiny/title-protocol";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import {
	copyToClipboard,
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "../../utils/clipboard";
import { EnhancedPasteController } from "../../utils/enhanced-paste";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { ensureSupportedImageInput, ImageInputTooLargeError, loadImageInput } from "../../utils/image-loading";
import { resizeImage } from "../../utils/image-resize";
import { generateSessionTitle, setSessionTerminalTitle } from "../../utils/title-generator";

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
	return {
		code: trimmed.slice(prefixLength).trim(),
		isExcluded: prefixLength === 2,
	};
}

/**
 * Parse a Codex-style `$<skill-name> [args]` explicit skill invocation. Returns
 * the bare skill name + trailing args, or null when the text is not a `$`-skill
 * token: the Python sigils `$ `/`$$ ` (whitespace after `$`), `${…}` prose, and a
 * bare `$` all return null. The caller still checks the name against the skill
 * registry, so `$HOME`-style prose with no matching skill falls through too.
 */
export function parseDollarSkillInput(text: string): { name: string; args: string } | null {
	if (text.charCodeAt(0) !== 36 /* $ */) return null;
	const second = text.charCodeAt(1);
	if (
		Number.isNaN(second) ||
		second === 36 /* $ */ ||
		second === 123 /* { */ ||
		second === 32 /* space */ ||
		second === 9 /* tab */
	) {
		return null;
	}
	const spaceIndex = text.indexOf(" ");
	const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	return { name, args };
}

/** Wrap pasted text in `<attachment>` tags so the model treats it as one quoted block. */
function wrapPasteInAttachmentBlock(content: string): string {
	return `<attachment>\n${content}\n</attachment>`;
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
// Aborting an active stream takes a confirming second Esc within this window;
// the arm is per-turn and clears on any agent_start/agent_end transition.
const STREAMING_ESC_CONFIRM_WINDOW_MS = 2_000;

export function shouldSkipHistory(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return false;
	if (!shouldPersistBuiltinSlashCommand(trimmed)) return true;
	const match = /^\/([^:\s]+)(?::|\s+)?(.*)$/s.exec(trimmed);
	if (!match) return false;
	const command = match[1]?.toLowerCase();
	const args = match[2]?.trim() ?? "";
	if ((command === "login" || command === "join") && args.length > 0) return true;
	return command === "mcp" && /^add\b/i.test(args) && /(?:^|\s)--token(?:=|\s|$)/i.test(args);
}

export class InputController {
	constructor(
		private ctx: InteractiveModeContext,
		/** Injectable clipboard reads so tests can drive paste flows without a real clipboard. */
		private clipboard: {
			readImage: typeof readImageFromClipboard;
			readText: typeof readTextFromClipboard;
			/** Darwin-only AppleScript bridge for `public.file-url` pasteboard items (#3506). */
			readMacFileUrls?: typeof readMacFileUrlsFromClipboard;
		} = {
			readImage: readImageFromClipboard,
			readText: readTextFromClipboard,
			readMacFileUrls: readMacFileUrlsFromClipboard,
		},
	) {}

	#enhancedPaste?: EnhancedPasteController;
	#focusedLeftTapListenerInstalled = false;
	#btwBranchListenerInstalled = false;
	#btwCopyListenerInstalled = false;
	// Tap counter for the double-← gesture; reset whenever a quiet gap
	// (>= LEFT_DOUBLE_TAP_MAX_GAP_MS) starts a fresh sequence. See
	// #detectLeftDoubleTap.
	#leftTapCount = 0;
	// Sequential index for `local://attachment-N` references created by the large-paste local-file
	// action. Seeded from 0 and bumped past any existing attachment files in #attachPasteAsFile.
	#attachmentCounter = 0;
	// First Esc while streaming arms a confirm window instead of aborting; the
	// timestamp is the arm token and the subscription clears it at the next
	// turn boundary so a stale arm can never fast-abort a fresh turn.
	#streamingEscArmedAt: number | undefined;
	#streamingEscUnsubscribe: (() => void) | undefined;
	// Serializes editor submit handling. editor.onSubmit is dispatched
	// fire-and-forget (tui editor.ts), so without this a fast second (empty)
	// Enter runs a concurrent handler and races shared submit state — e.g. a
	// steer still registering into the agent queue when the empty Enter reads
	// queuedMessageCount (still 0) and no-ops instead of flushing. Chaining each
	// submit onto the previous makes successive Enters strictly sequential.
	#submitChain: Promise<void> = Promise.resolve();

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

	setupKeyHandlers(): void {
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
				if (!this.ctx.canBranchBtw()) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				// Another focused input (selector, hook prompt) owns the keystroke.
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				void this.ctx.handleBtwBranchKey();
				return { consume: true };
			});
		}
		if (!this.#btwCopyListenerInstalled) {
			this.#btwCopyListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!matchesKey(data, "c")) return undefined;
				if (!this.ctx.canCopyBtw()) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				// Another focused input (selector, hook prompt) owns the keystroke.
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				void this.ctx.handleBtwCopyKey();
				return { consume: true };
			});
		}
		this.ctx.editor.onClearDraft = () => {
			// The pending-image buffer and its hyperlinks live on the mode
			// context; drop them together with the editor's draft text.
			this.ctx.editor.pendingImages = [];
			this.ctx.editor.pendingImageLinks = [];
		};
		this.ctx.editor.onEscape = () => {
			// Active context maintenance owns Esc: auto/manual compaction,
			// handoff generation, and auto-retry backoff all advertise
			// "(esc to cancel)". Dispatch on live session state instead of
			// swapping onEscape handlers — interleaved start/end events used
			// to clobber the single saved-handler slot (auto-compaction start
			// → /compact → auto end → manual finally), leaving Esc wired to a
			// stale no-op closure until restart.
			if (!this.ctx.focusedAgentId) {
				const viewSession = this.ctx.viewSession;
				let aborted = false;
				if (viewSession.isCompacting) {
					try {
						viewSession.abortCompaction();
					} catch {}
					aborted = true;
				}
				if (viewSession.isGeneratingHandoff) {
					try {
						viewSession.abortHandoff();
					} catch {}
					aborted = true;
				}
				if (viewSession.isRetrying) {
					try {
						viewSession.abortRetry();
					} catch {}
					aborted = true;
				}
				if (aborted) return;
			}

			if (this.ctx.loopModeEnabled) {
				this.ctx.pauseLoop();
				if (this.ctx.session.isStreaming) {
					void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
				} else {
					this.ctx.cancelPendingSubmission();
				}
				return;
			}
			if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) {
				return;
			}
			if (this.ctx.hasActiveOmfg() && this.ctx.handleOmfgEscape()) {
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
				const now = Date.now();
				if (
					this.#streamingEscArmedAt !== undefined &&
					now - this.#streamingEscArmedAt < STREAMING_ESC_CONFIRM_WINDOW_MS
				) {
					this.#clearStreamingEscArm();
					void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
				} else {
					this.#streamingEscArmedAt = now;
					if (!this.#streamingEscUnsubscribe) {
						this.#streamingEscUnsubscribe = this.ctx.session.subscribe(event => {
							if (event.type === "agent_start" || event.type === "agent_end") {
								this.#clearStreamingEscArm();
							}
						});
					}
					this.ctx.showStatus("Press Esc again within 2s to cancel streaming.");
				}
			} else if (this.ctx.editor.getText().trim()) {
				// Esc with typed text clears the draft instead of (or before) any double-Esc action
				this.ctx.editor.setText("");
				this.ctx.ui.requestRender();
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
						this.ctx.ui.resetDisplay();
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
		this.ctx.editor.onDisplayReset = () => this.ctx.ui.resetDisplay();
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
		this.ctx.editor.setActionKeys("app.tools.expand", this.ctx.keybindings.getKeys("app.tools.expand"));
		this.ctx.editor.onExpandTools = () => this.toggleToolOutputExpansion();
		this.ctx.editor.setActionKeys("app.message.dequeue", this.ctx.keybindings.getKeys("app.message.dequeue"));
		this.ctx.editor.onDequeue = () => this.handleDequeue();
		this.ctx.editor.setActionKeys("app.retry", this.ctx.keybindings.getKeys("app.retry"));
		this.ctx.editor.onRetry = () => void this.handleRetry();
		this.ctx.editor.clearCustomKeyHandlers();
		// Wire up extension shortcuts
		this.registerExtensionShortcuts();
		const planModeKeys = this.ctx.keybindings.getKeys("app.plan.toggle");
		for (const key of planModeKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				// Work-mode mutations always target the main session; ignore the
				// legacy plan toggle while a subagent is focus-proxied so the
				// composer cannot silently change the main session's mode.
				if (this.ctx.focusedAgentId) return;
				void this.ctx.handlePlanModeCommand();
			});
		}
		for (const key of this.ctx.keybindings.getKeys("app.composer.mode.cycle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => {
				if (this.ctx.focusedAgentId) return;
				if (!this.ctx.isIntentComposerEnabled?.() && this.ctx.getComposerWorkMode?.() === "ask") {
					void this.ctx
						.restoreComposerAskTools?.()
						.catch(error => this.ctx.showError(error instanceof Error ? error.message : String(error)));
					return;
				}
				if (this.ctx.isIntentComposerEnabled?.()) {
					void this.ctx
						.cycleComposerWorkMode?.()
						.catch(error => this.ctx.showError(error instanceof Error ? error.message : String(error)));
				}
			});
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
			...this.ctx.keybindings.getKeys("app.session.backgrounds"),
		]);
		for (const key of hubKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showAgentHub());
		}

		// Double-tap left arrow on an empty editor: opens the agent hub from the
		// main session, or returns the focused subagent view to the main session.
		// Focused ←← intentionally matches Esc. From the main session the gesture
		// stays inert when there are no subagents (requireContent); the explicit
		// hub key still opens the empty roster.
		this.ctx.editor.onLeftAtStart = () => {
			if (this.ctx.focusedAgentId) {
				this.#handleFocusedLeftTap();
				return;
			}
			if (this.#detectLeftDoubleTap()) {
				this.ctx.showAgentHub({ requireContent: true });
			}
		};

		this.#setupEnhancedPaste();

		this.ctx.editor.onChange = (text: string) => {
			const wasBashMode = this.ctx.isBashMode;
			const wasPythonMode = this.ctx.isPythonMode;
			const trimmed = text.trimStart();
			this.ctx.isBashMode = trimmed.startsWith("!");
			this.ctx.isPythonMode = pythonCommandPrefixLength(trimmed) > 0;
			if (wasBashMode !== this.ctx.isBashMode || wasPythonMode !== this.ctx.isPythonMode) {
				this.ctx.updateEditorBorderColor();
			}
		};
	}

	#clearStreamingEscArm(): void {
		this.#streamingEscArmedAt = undefined;
		this.#streamingEscUnsubscribe?.();
		this.#streamingEscUnsubscribe = undefined;
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

	setupEditorSubmitHandler(): void {
		const handle = async (text: string): Promise<void> => {
			text = text.trim();
			if ((!isSettingsInitialized() || settings.get("emojiAutocomplete")) && text) text = expandEmoticons(text);
			if (this.ctx.isIntentComposerEnabled?.()) await this.ctx.waitForComposerTransition?.();

			// Focused subagent session: the editor is a plain chat box for it.
			// Everything below (continue shortcuts, slash/bash/python, loop,
			// compaction queueing) is main-session-only.
			if (this.ctx.focusedAgentId) {
				await this.#submitToFocusedSession(text, "steer");
				return;
			}
			if (this.#ownerCommandBlocksSubmission()) return;

			// Empty submit while streaming with queued messages: abort the active
			// turn and let the post-unwind drain deliver the agent-core queue.
			// An image-only draft (pasted screenshot, no caption) is real input,
			// not an abort request — queue it as a steer instead.
			if (!text && this.ctx.session.isStreaming) {
				if (this.ctx.editor.pendingImages.length > 0) {
					const images = [...this.ctx.editor.pendingImages];
					const imageLinks =
						this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
					this.ctx.editor.setText("");
					this.ctx.editor.imageLinks = undefined;
					this.ctx.editor.pendingImages = [];
					this.ctx.editor.pendingImageLinks = [];
					try {
						await this.ctx.withLocalSubmission(
							text,
							() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
							{ imageCount: images.length },
						);
					} catch (error) {
						this.ctx.editor.setText(text);
						this.ctx.editor.pendingImages = images;
						this.ctx.editor.pendingImageLinks = imageLinks ?? images.map(() => undefined);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
					this.ctx.updatePendingMessagesDisplay();
					this.ctx.ui.requestRender();
					return;
				}
				if (this.ctx.session.queuedMessageCount > 0) {
					const aborting = this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
					await aborting;
					this.ctx.updatePendingMessagesDisplay();
					this.ctx.ui.requestRender();
				}
				return;
			}

			if (!text) return;

			// Continue shortcuts: "." or "c" resume the agent with a hidden agent-authored
			// developer directive (no visible user message) instead of an empty turn, so the
			// model continues the prior intent rather than second-guessing the interrupt.
			if (text === "." || text === "c") {
				if (this.ctx.onInputCallback) {
					this.ctx.editor.setText("");
					this.ctx.editor.pendingImages = [];
					this.ctx.editor.pendingImageLinks = [];
					this.ctx.editor.imageLinks = undefined;
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

			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, inputImages, "interactive");
				if (result?.handled) {
					this.ctx.editor.setText("");
					this.ctx.editor.pendingImages = [];
					this.ctx.editor.pendingImageLinks = [];
					this.ctx.editor.imageLinks = undefined;
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
			}

			if (this.#ownerCommandBlocksSubmission()) return;

			if (!text) return;

			// Handle built-in slash commands
			const slashResult = await executeBuiltinSlashCommand(text, {
				ctx: this.ctx,
			});
			if (slashResult === true) {
				if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
				return;
			}
			if (typeof slashResult === "string") {
				// Command handled but returned remaining text to use as prompt
				text = slashResult;
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
				if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
				this.ctx.editor.setText("");
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];
				// No local render: the prompt comes back from the host as a
				// collab-prompt event/entry and renders with the author badge.
				this.ctx.collabGuest.sendPrompt(text, images);
				return;
			}

			// Handle skill commands (/skill:name [args]). Enter ⇒ steer (matches the
			// free-text Enter semantics applied a few lines below at the streaming
			// branch). Ctrl+Enter routes through `handleFollowUp` and dispatches the
			// same helper with `"followUp"`.
			if (await this.#invokeSkillCommand(text, "steer")) {
				return;
			}

			// Codex-style `$<skill-name> [args]` explicit skill invocation (Enter ⇒ steer).
			if (await this.#invokeDollarSkillCommand(text, "steer")) {
				return;
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
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
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
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					await this.ctx.handlePythonCommand(code, isExcluded);
					this.ctx.isPythonMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			if (this.#ownerCommandBlocksSubmission()) return;

			// While loop mode is on, every user-typed prompt becomes the new loop
			// prompt that auto-resubmits after each yield.
			if (this.ctx.loopModeEnabled) {
				this.ctx.loopPrompt = text;
			}

			// Queue input during compaction
			if (this.ctx.session.isCompacting) {
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.queueCompactionMessage(text, "steer", images);
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.ctx.session.isStreaming) {
				if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
				this.ctx.editor.setText("");
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];
				// Record the signature so the queued message's eventual delivery
				// (a user-role `message_start` event) leaves any draft the user has
				// typed since queuing intact. Same protection as #783, applied to
				// the streaming/queue path.
				await this.ctx.withLocalSubmission(
					text,
					() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
					{ imageCount: images?.length ?? 0 },
				);
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.ctx.flushPendingBashComponents();

			// Auto-generate a session title while the session is still unnamed.
			// Greetings / acknowledgements / empty input carry no task, so they are
			// skipped deterministically (no model invoked, no download-progress UI)
			// and the session stays unnamed — the next user message gets a fresh
			// chance, so titling defers past "hi" instead of latching onto it.
			if (!this.ctx.sessionManager.getSessionName() && !$env.PI_NO_TITLE && !isLowSignalTitleInput(text)) {
				this.#showTinyTitleDownloadProgress(this.ctx.settings.get("providers.tinyModel"));
				const registry = this.ctx.session.modelRegistry;
				generateSessionTitle(
					text,
					registry,
					this.ctx.settings,
					this.ctx.session.sessionId,
					this.ctx.session.model,
					provider => this.ctx.session.agent.metadataForProvider(provider),
					this.ctx.titleSystemPrompt,
				)
					.then(async title => {
						// Re-check: a concurrent attempt for an earlier message may have
						// already named the session. Don't clobber it.
						if (title && !this.ctx.sessionManager.getSessionName()) {
							const applied = await this.ctx.sessionManager.setSessionName(title, "auto");
							if (applied) {
								setSessionTerminalTitle(
									this.ctx.sessionManager.getSessionName()!,
									this.ctx.sessionManager.getCwd(),
								);
								this.ctx.updateEditorBorderColor();
							}
						}
					})
					.catch(err => {
						logger.warn("title-generator: uncaught auto-title error", {
							sessionId: this.ctx.session.sessionId,
							reason: "uncaught-auto-title-error",
							error: err instanceof Error ? err.message : String(err),
						});
					});
			}

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
				try {
					await this.ctx.withLocalSubmission(
						text,
						() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
						{
							imageCount: images?.length ?? 0,
						},
					);
				} catch (error) {
					// Don't lose the message: hand the text and images back to the
					// editor so the user can retry (e.g. prompt dispatch rejecting an
					// extension command).
					this.ctx.editor.setText(text);
					if (images && images.length > 0) {
						this.ctx.editor.pendingImages = [...images];
						this.ctx.editor.pendingImageLinks = inputImageLinks
							? [...inputImageLinks]
							: images.map(() => undefined);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
			if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
		};
		this.ctx.editor.onSubmit = (text: string) => {
			// Serialize: run each submit only after the previous one settles, so a
			// fast double-Enter (fire-and-forget onSubmit) can't race a steer that is
			// still registering. Both arms run `handle` — a rejected prior submit must
			// not swallow the next one.
			this.#submitChain = this.#submitChain.then(
				() => handle(text),
				() => handle(text),
			);
			return this.#submitChain;
		};
	}

	/** Submit editor text to the focused subagent session (chat-only focus policy). */
	async #submitToFocusedSession(text: string, streamingBehavior: "steer" | "followUp"): Promise<void> {
		const target = this.ctx.viewSession;
		// An empty submit only aborts/queues when there is truly no input —
		// an image-only draft (pasted screenshot, no caption) still dispatches.
		if (!text && this.ctx.editor.pendingImages.length === 0) {
			if (target.isStreaming && target.queuedMessageCount > 0) {
				const aborting = target.abort({ reason: USER_INTERRUPT_LABEL });
				await aborting;
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
			return;
		}
		if (text.startsWith("/") || text.startsWith("!") || parsePythonCommandInput(text)) {
			this.ctx.showStatus("Commands run in the main session — press ←← to return first");
			return; // editor text not cleared: Editor does not auto-clear on submit
		}
		const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
		const imageLinks =
			this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
		if (text) this.ctx.editor.addToHistory(text);
		this.ctx.editor.setText("");
		this.ctx.editor.imageLinks = undefined;
		this.ctx.editor.pendingImages = [];
		this.ctx.editor.pendingImageLinks = [];
		try {
			// prompt() handles idle (new turn) and streaming (queues per streamingBehavior).
			await this.ctx.withLocalSubmission(text, () => target.prompt(text, { streamingBehavior, images }), {
				imageCount: images?.length ?? 0,
			});
		} catch (error) {
			// Hand the whole draft back — text AND images — mirroring the main
			// submit error path; previously only text was restored, so a pasted
			// image silently disappeared from the composer on retry.
			this.ctx.editor.setText(text);
			if (images) {
				this.ctx.editor.pendingImages = images;
				this.ctx.editor.pendingImageLinks = imageLinks ?? images.map(() => undefined);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
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
		// Suspension is POSIX job-control: Windows has no equivalent and
		// `process.kill(_, "SIGSTOP")` throws `TypeError: Unknown signal:
		// SIGSTOP` there, taking the whole agent down via an uncaught
		// exception (issue #2036). No-op on platforms that cannot suspend.
		if (process.platform === "win32") {
			this.ctx.showStatus("Suspend (Ctrl+Z) is not supported on this platform");
			return;
		}

		// Capture the listener so we can detach it if the signal never
		// fires; otherwise a failed suspend would leave a stale SIGCONT
		// handler that fires on the next unrelated continue and tries to
		// re-`start()` an already-running TUI.
		const onResume = (): void => {
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
		};
		process.once("SIGCONT", onResume);

		// Stop the TUI (restore terminal to normal mode) before sending the
		// signal so the parent shell sees a sane terminal state.
		this.ctx.ui.stop();

		try {
			// pid=0 → entire foreground process group; the uncatchable SIGSTOP
			// parks the job in the parent shell (#3461).
			process.kill(0, "SIGSTOP");
		} catch (err) {
			// Either the runtime refused the signal or the kernel rejected
			// it (some sandboxes block sending to pid=0). Tear the resume
			// hook down and bring the TUI back so the user is not stranded
			// on a frozen prompt.
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
	 * using the supplied `streamingBehavior`. Returns true if the text was a
	 * recognised skill command and was dispatched. A failure to load the skill
	 * file is surfaced via `showError` but still returns true — the editor was
	 * already cleared on the success path, so falling through to plain-text
	 * handling at that point would double-submit. Returns false when the text
	 * isn't a `/skill:` prefix or the command name isn't a registered skill,
	 * so the caller can fall through to plain-text handling (this branch
	 * leaves the editor state untouched). `streamingBehavior` is only consulted
	 * while the agent is streaming; the idle path of `promptCustomMessage`
	 * ignores it.
	 */
	async #invokeSkillCommand(text: string, streamingBehavior: "steer" | "followUp"): Promise<boolean> {
		if (!text.startsWith("/skill:")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
		return this.#dispatchSkillCommand(commandName, args, text, streamingBehavior);
	}

	/**
	 * Codex-style explicit skill invocation: `$<skill-name> [args]`. The `$` sigil
	 * is shared with the Python REPL, but that path requires whitespace right after
	 * the sigil (`$ code` / `$$ code`), so `$name` is unambiguous. Returns false
	 * (falls through to plain text) for `$`, `$$`, `${`, `$ …`, and any name that is
	 * not a registered skill, leaving `$HOME`-style prose untouched.
	 */
	async #invokeDollarSkillCommand(text: string, streamingBehavior: "steer" | "followUp"): Promise<boolean> {
		const parsed = parseDollarSkillInput(text);
		if (!parsed) return false;
		return this.#dispatchSkillCommand(`skill:${parsed.name}`, parsed.args, text, streamingBehavior);
	}

	/**
	 * Load a registered skill's SKILL.md (frontmatter stripped) and dispatch it via
	 * `promptCustomMessage`. `commandName` is the `skill:<name>` registry key and
	 * `typedText` is the original input (history + queue chip). Returns false when
	 * the skill isn't registered so the caller can fall through to plain-text
	 * handling; returns true once dispatched (or after a load error is surfaced,
	 * since the editor was already cleared on the success path).
	 */
	async #dispatchSkillCommand(
		commandName: string,
		args: string,
		typedText: string,
		streamingBehavior: "steer" | "followUp",
	): Promise<boolean> {
		const skillPath = this.ctx.skillCommands?.get(commandName);
		if (!skillPath) return false;
		this.ctx.editor.addToHistory(typedText);
		this.ctx.editor.setText("");
		try {
			const content = await Bun.file(skillPath).text();
			const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
			const metaLines = [`Skill: ${skillPath}`];
			if (args) {
				metaLines.push(`User: ${args}`);
			}
			const message = `${body}\n\n---\n\n${metaLines.join("\n")}`;
			const skillName = commandName.slice("skill:".length);
			const details: SkillPromptDetails = {
				name: skillName || commandName,
				path: skillPath,
				args: args || undefined,
				lineCount: body ? body.split("\n").length : 0,
			};
			await this.ctx.session.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: message,
					display: true,
					details,
					attribution: "user",
				},
				{ streamingBehavior, queueChipText: typedText },
			);
			if (this.ctx.session.isStreaming) {
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
		} catch (err) {
			this.ctx.showError(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
		}
		return true;
	}

	async handleRetry(): Promise<void> {
		if (this.ctx.collabGuest) {
			this.ctx.showStatus("/retry is host-only during a collab session");
			return;
		}
		const didRetry = await this.ctx.viewSession.retry();
		if (didRetry) {
			this.ctx.editor.setText("");
			this.ctx.editor.pendingImages = [];
			this.ctx.editor.pendingImageLinks = [];
			this.ctx.editor.imageLinks = undefined;
		} else {
			this.ctx.showStatus("Nothing to retry");
		}
	}

	#ownerCommandBlocksSubmission(): boolean {
		if (!isOwnerCommandInFlight(this.ctx.sessionManager)) return false;
		this.ctx.showStatus("Busy: Hub session handoff is in progress.");
		this.ctx.ui.requestRender();
		return true;
	}

	/** Send editor text as a follow-up message (queued behind current stream). */
	async handleFollowUp(): Promise<void> {
		let text = this.ctx.editor.getText().trim();
		// An image-only draft (pasted screenshot, no caption) still dispatches.
		if (!text && this.ctx.editor.pendingImages.length === 0) return;

		// Focused subagent session: follow-ups go to it; non-chat input is gated.
		if (this.ctx.focusedAgentId) {
			await this.#submitToFocusedSession(text, "followUp");
			return;
		}
		if (this.#ownerCommandBlocksSubmission()) return;

		// Compaction first: while compacting, free text gets queued via
		// `queueCompactionMessage`, and `/skill:*` rides the same queue so a
		// skill typed during compaction is not lost or short-circuited through
		// `promptCustomMessage`. The skill text is queued verbatim; whether
		// the queued entry is later re-parsed into a skill invocation is a
		// separate concern owned by the compaction-resume path.
		if (this.ctx.session.isCompacting) {
			const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
			this.ctx.queueCompactionMessage(text, "followUp", images);
			return;
		}

		const slashResult = await executeBuiltinSlashCommand(text, {
			ctx: this.ctx,
		});
		if (slashResult === true) {
			return;
		}
		if (typeof slashResult === "string") {
			text = slashResult;
		}

		// Skill commands invoke through the custom-message path regardless of
		// which keybinding submitted them. Enter routes them as `steer`;
		// Ctrl+Enter (this handler) routes them as `followUp`.
		if (await this.#invokeSkillCommand(text, "followUp")) {
			return;
		}

		// Codex-style `$<skill-name> [args]` explicit skill invocation (Ctrl+Enter ⇒ followUp).
		if (await this.#invokeDollarSkillCommand(text, "followUp")) {
			return;
		}

		if (this.#ownerCommandBlocksSubmission()) return;

		// Forward any pending clipboard-pasted images alongside the queued text;
		// otherwise the follow-up would drop the image (mirrors the Enter/steer path).
		const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
		const imageLinks =
			this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
		const consumeDraft = (): void => {
			if (text) this.ctx.editor.addToHistory(text);
			this.ctx.editor.setText("");
			this.ctx.editor.imageLinks = undefined;
			this.ctx.editor.pendingImages = [];
			this.ctx.editor.pendingImageLinks = [];
		};
		// Dispatch failure hands the whole draft back — text AND images — so
		// the composer can retry without the pasted image silently vanishing.
		const restoreDraft = (error: unknown): void => {
			this.ctx.editor.setText(text);
			if (images) {
				this.ctx.editor.pendingImages = images;
				this.ctx.editor.pendingImageLinks = imageLinks ?? images.map(() => undefined);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		};

		if (this.ctx.session.isStreaming) {
			consumeDraft();
			try {
				await this.ctx.withLocalSubmission(
					text,
					() => this.ctx.session.prompt(text, { streamingBehavior: "followUp", images }),
					{ imageCount: images?.length ?? 0 },
				);
			} catch (error) {
				restoreDraft(error);
			}
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		// Not streaming — just submit normally
		consumeDraft();
		try {
			await this.ctx.withLocalSubmission(text, () => this.ctx.session.prompt(text, { images }), {
				imageCount: images?.length ?? 0,
			});
		} catch (error) {
			restoreDraft(error);
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
		// Image markers are positional: `[Image #N]` ↔ `pendingImages[N-1]`. Each
		// queued message numbered its markers against its own local image list
		// (1..K). Because we prepend the queued text but append the queued images
		// to `pendingImages`, any existing draft images (M of them) — plus images
		// already pulled in by earlier queued messages — shift the slot index that
		// every marker must point to. Bumping each message's markers by the
		// running offset keeps the merged text aligned with the merged
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
		this.ctx.editor.setText(combinedText);
		// Hand queued images back to the pending-image buffer (links are
		// re-materialized lazily; the restored text already carries the
		// renumbered `[Image #N, WxH]` markers).
		if (queuedImages.length > 0) {
			this.ctx.editor.pendingImages.push(...queuedImages);
			this.ctx.editor.pendingImageLinks.push(...queuedImages.map(() => undefined));
			this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		}
		this.ctx.updatePendingMessagesDisplay();
		if (options?.abort) {
			void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		return allQueued.length;
	}

	async #insertPendingImage(imageData: ImageContent): Promise<void> {
		const imageLink = (
			await materializeImageReferenceLinks(
				[
					{
						type: "image",
						data: imageData.data,
						mimeType: imageData.mimeType,
					},
				],
				this.ctx.sessionManager.putBlob.bind(this.ctx.sessionManager),
			)
		)?.[0];
		this.ctx.editor.pendingImages.push({
			type: "image",
			data: imageData.data,
			mimeType: imageData.mimeType,
		});
		this.ctx.editor.pendingImageLinks.push(imageLink);
		this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		const imageNum = this.ctx.editor.pendingImages.length;
		const dims = await this.#imageDimensions(imageData);
		const label = dims ? `[Image #${imageNum}, ${dims.width}x${dims.height}]` : `[Image #${imageNum}]`;
		this.ctx.editor.insertText(`${label} `);
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
			const image = await this.clipboard.readImage();
			if (!image) {
				// macOS Finder `Cmd+C` puts only a `public.file-url` pasteboard
				// item: arboard reports ContentNotAvailable and `pbpaste` (the
				// Darwin readText backing) surfaces nothing. The AppleScript
				// bridge reaches the file-URL representation — attach every
				// image-shaped entry instead of bailing or pasting text (#3506).
				if (this.clipboard.readMacFileUrls) {
					try {
						const urls = await this.clipboard.readMacFileUrls();
						const imagePaths = urls
							.map(url => extractImagePathFromText(url))
							.filter((imagePath): imagePath is string => imagePath !== undefined);
						if (imagePaths.length > 0) {
							for (const imagePath of imagePaths) {
								await this.handleImagePathPaste(imagePath);
							}
							return true;
						}
					} catch {
						// Bridge unavailable — fall through to the text paths.
					}
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
				// Clipboard text that IS an explicit image file path (Finder copy,
				// `file://` URL, macOS screenshot name with unescaped spaces) must
				// attach the image, never land in the editor as literal text (#3506).
				const imagePath = extractImagePathFromText(text);
				if (imagePath !== undefined) {
					await this.handleImagePathPaste(imagePath);
					return true;
				}
				// Route to the focused component when it accepts pastes (modal
				// Input prompts), matching the enhanced-paste text path (#2127).
				const focused = this.ctx.ui.getFocused();
				const target = focused && focused !== this.ctx.editor && hasPasteText(focused) ? focused : this.ctx.editor;
				target.pasteText(text);
				this.ctx.ui.requestRender();
				return true;
			}
			return await this.#normalizeAndInsertPastedImage(
				{
					type: "image",
					data: image.data.toBase64(),
					mimeType: image.mimeType,
				},
				`Unsupported clipboard image format: ${image.mimeType}`,
			);
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
		if (!(threshold > 0) || lineCount < threshold) return false;
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
					{ label: LOCAL_FILE, description: "Save the text to a local://attachment file" },
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
				this.ctx.editor.insertPaste(wrapPasteInAttachmentBlock(text));
				break;
			case LOCAL_FILE:
				await this.#attachPasteAsFile(text, lineCount);
				break;
			case INLINE:
				this.ctx.editor.insertPaste(text);
				break;
			default:
				// Esc / cancel: keep the original behavior — collapse to an inline paste marker.
				this.ctx.editor.insertPaste(text);
				break;
		}
		this.ctx.ui.requestRender();
	}

	/**
	 * Save a large paste to the session's `local://` store and insert a clean `local://attachment-N`
	 * reference into the editor so the agent can `read` it on demand — instead of inlining the text or
	 * leaking a raw temp path. Falls back to an inline paste marker when the write fails, so the
	 * content is never lost.
	 */
	async #attachPasteAsFile(text: string, lineCount: number): Promise<void> {
		try {
			// Mirror the exact mapping the read tool's local:// resolver uses so a later
			// `read local://attachment-N` lands on the file written here.
			const localRoot = resolveLocalRoot({
				getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
				getSessionId: () => this.ctx.sessionManager.getSessionId(),
			});
			let name: string;
			let filePath: string;
			do {
				this.#attachmentCounter++;
				name = `attachment-${this.#attachmentCounter}`;
				filePath = path.join(localRoot, name);
			} while (await Bun.file(filePath).exists());
			await Bun.write(filePath, text);
			this.ctx.editor.insertText(`local://${name} `);
			this.ctx.showStatus(`Saved ${lineCount} pasted lines to local://${name}`);
		} catch (error) {
			logger.warn("failed to save large paste to file", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.ctx.editor.insertPaste(text);
			this.ctx.showError("Failed to save paste to a file — pasted inline instead");
		}
	}

	createAutocompleteProvider(commands: SlashCommand[], basePath: string): AutocompleteProvider {
		return createPromptActionAutocompleteProvider({
			commands,
			basePath,
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
		this.setToolsExpanded(!this.ctx.toolOutputExpanded);
	}

	setToolsExpanded(expanded: boolean): void {
		this.ctx.toolOutputExpanded = expanded;
		for (const child of this.ctx.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		// Toggling expansion mutates every block, but on ED3-risk terminals the
		// transcript freezes a snapshot of each block once it scrolls past the live
		// region (committed native scrollback is immutable there). A plain repaint
		// replays those stale snapshots, so the toggle appears to do nothing above
		// the live block. resetDisplay() invalidates the snapshots and forces a
		// full clear + replay — the keyboard-accessible resize-reset equivalent —
		// which is the only path that re-emits the whole transcript at its new
		// heights.
		this.ctx.ui.resetDisplay();
	}

	toggleThinkingBlockVisibility(): void {
		// With thinking off there are no blocks to reveal: effective visibility is
		// forced hidden regardless of the persisted preference, so a toggle would
		// only corrupt the setting. Refuse and say why instead of silently no-op'ing.
		const thinkingLevel = (this.ctx.viewSession ?? this.ctx.session).thinkingLevel;
		if (thinkingLevel === ThinkingLevel.Off) {
			this.ctx.showStatus("Thinking is off — enable thinking to show blocks");
			return;
		}

		// Transcript-display preference only: the agent's hideThinkingSummary stream
		// option is seeded from settings at session build and stays untouched here.
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

		// Every block now carries the new flag, but on ED3-risk terminals the
		// blocks that scrolled past the live region are frozen snapshots in
		// committed scrollback — a plain repaint replays them stale, so scrolling
		// up still shows the old thinking expanded. resetDisplay() retires those
		// snapshots (it invalidates every block) and forces a full clear + replay
		// of the whole transcript, matching setToolsExpanded()'s redraw.
		this.ctx.ui.resetDisplay();

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	#getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	async #openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.#getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	async openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.ctx.editor.getExpandedText?.() ?? this.ctx.editor.getText();

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ctx.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, { extension: ".omp.md", stdio });
			if (result !== null) {
				this.ctx.editor.setText(result);
			}
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}

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
