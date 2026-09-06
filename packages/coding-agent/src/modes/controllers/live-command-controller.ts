import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { LiveSessionController, type LiveSessionControllerOptions, type LiveTranscript } from "../../live/controller";
import { LIVE_MODEL } from "../../live/protocol";
import { LiveVisualizer } from "../../live/visualizer";
import { vocalizer } from "../../tts/vocalizer";
import type { AssistantMessageComponent } from "../components/assistant-message";
import type { CustomEditor } from "../components/custom-editor";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";

const ANIMATION_INTERVAL_MS = 80;
type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionController;

const LIVE_MESSAGE_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

/** Owns the editor-replacing visualizer and realtime session lifecycle for `/live`. */
export class LiveCommandController {
	readonly #ctx: InteractiveModeContext;
	readonly #createSession: LiveSessionFactory | undefined;

	#session: LiveSessionController | undefined;
	#settling: Promise<void> | undefined;
	#visualizer: LiveVisualizer | undefined;
	#detachedEditor: CustomEditor | undefined;
	#animationInterval: NodeJS.Timeout | undefined;
	#previousShowHardwareCursor: boolean | undefined;
	#previousUseTerminalCursor: boolean | undefined;
	#resumeVocalizer: (() => void) | undefined;
	#assistantTranscriptComponent: AssistantMessageComponent | undefined;
	#assistantTranscriptTurn = 0;
	#assistantTranscriptStartedAt = 0;

	constructor(ctx: InteractiveModeContext, createSession?: LiveSessionFactory) {
		this.#ctx = ctx;
		this.#createSession = createSession;
	}

	/** Whether a live session is connected, connecting, or closing. */
	get active(): boolean {
		return this.#session !== undefined || this.#settling !== undefined;
	}

	/** Start live mode, or stop the currently active session. */
	async handleCommand(): Promise<void> {
		if (this.#session) {
			await this.stop();
			return;
		}
		if (this.#settling) await this.#settling;
		await this.#start();
	}

	/** Stop the active live session and restore the editor. */
	async stop(): Promise<void> {
		const session = this.#session;
		if (!session) {
			if (this.#settling) await this.#settling;
			return;
		}
		try {
			await session.stop();
		} catch (cause) {
			this.#finish(session, errorFrom(cause));
		} finally {
			this.#finish(session);
		}
	}

	/** Release UI resources during synchronous InteractiveMode teardown. */
	dispose(): void {
		const session = this.#session;
		if (session) {
			this.#finish(session);
			void session.stop().catch(cause => {
				logger.debug("Live session teardown failed", { error: errorFrom(cause).message });
			});
		} else {
			this.#restoreEditor();
		}
	}

	async #start(): Promise<void> {
		this.#assistantTranscriptTurn = 0;
		this.#assistantTranscriptStartedAt = 0;
		const visualizer = new LiveVisualizer({
			onStop: () => {
				void this.stop().catch(cause => this.#ctx.showError(errorFrom(cause).message));
			},
			onToggleMute: () => this.#session?.toggleMute(),
			stopKeys: this.#ctx.keybindings.getKeys("app.live.toggle"),
		});
		this.#mountVisualizer(visualizer);

		const options: LiveSessionControllerOptions = {
			session: this.#ctx.session,
			extractAssistantText: message => this.#ctx.extractAssistantText(message),
			voice: this.#ctx.settings.get("live.voice"),
			callbacks: {
				onPhase: phase => {
					if (this.#visualizer !== visualizer) return;
					visualizer.setPhase(phase);
					this.#ctx.ui.requestComponentRender(visualizer);
				},
				onLevels: input => {
					if (this.#visualizer !== visualizer) return;
					visualizer.setInputLevel(input);
					this.#ctx.ui.requestComponentRender(visualizer);
				},
				onTranscript: transcript => {
					if (this.#visualizer !== visualizer) return;
					if (!transcript) {
						visualizer.clearTranscript();
						this.#ctx.ui.requestComponentRender(visualizer);
					} else if (transcript.role === "user") {
						visualizer.setTranscript(transcript.text);
						this.#ctx.ui.requestComponentRender(visualizer);
					} else {
						this.#presentAssistantTranscript(transcript);
					}
				},
				onTerminal: error => this.#finish(session, error),
			},
		};
		const session = this.#createSession ? this.#createSession(options) : new LiveSessionController(options);
		this.#session = session;

		try {
			await session.start();
		} catch (cause) {
			if (this.#session === session) {
				await session.stop();
				this.#finish(session, errorFrom(cause));
			}
		}
	}

	#presentAssistantTranscript(transcript: LiveTranscript): void {
		if (
			transcript.turn < this.#assistantTranscriptTurn ||
			(transcript.turn === this.#assistantTranscriptTurn && !this.#assistantTranscriptComponent)
		) {
			return;
		}
		if (transcript.turn > this.#assistantTranscriptTurn) {
			this.#finalizeAssistantTranscript();
			this.#assistantTranscriptTurn = transcript.turn;
		}

		let component = this.#assistantTranscriptComponent;
		if (!component) {
			component = createAssistantMessageComponent(this.#ctx);
			component.setTextColorTransform(text => theme.fg("borderAccent", text));
			this.#assistantTranscriptComponent = component;
			this.#assistantTranscriptStartedAt = Date.now();
		}
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: transcript.text }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: LIVE_MODEL,
			usage: { ...LIVE_MESSAGE_USAGE },
			stopReason: "stop",
			timestamp: this.#assistantTranscriptStartedAt,
		};
		component.updateContent(message, { transient: !transcript.final });
		if (transcript.final) {
			component.markTranscriptBlockFinalized();
			this.#assistantTranscriptComponent = undefined;
			this.#assistantTranscriptStartedAt = 0;
		}
		if (!this.#ctx.chatContainer.children.includes(component)) {
			this.#ctx.present(component);
		} else {
			this.#ctx.ui.requestComponentRender(component);
		}
	}

	#finalizeAssistantTranscript(): void {
		const component = this.#assistantTranscriptComponent;
		if (!component) return;
		component.markTranscriptBlockFinalized();
		this.#assistantTranscriptComponent = undefined;
		this.#assistantTranscriptStartedAt = 0;
		this.#ctx.ui.requestComponentRender(component);
	}

	#mountVisualizer(visualizer: LiveVisualizer): void {
		this.#visualizer = visualizer;
		this.#detachedEditor = this.#ctx.editor;
		this.#previousShowHardwareCursor = this.#ctx.ui.getShowHardwareCursor();
		this.#previousUseTerminalCursor = this.#ctx.editor.getUseTerminalCursor();
		this.#ctx.ui.setShowHardwareCursor(false);
		this.#ctx.editor.setUseTerminalCursor(false);
		this.#ctx.editorContainer.clear();
		this.#ctx.editorContainer.addChild(visualizer);
		this.#ctx.ui.setFocus(visualizer);
		this.#resumeVocalizer = vocalizer.suspend();
		let frame = 0;
		this.#animationInterval = setInterval(() => {
			if (this.#visualizer !== visualizer) return;
			frame += 1;
			visualizer.setFrame(frame);
			this.#ctx.ui.requestComponentRender(visualizer);
		}, ANIMATION_INTERVAL_MS);
		this.#ctx.ui.requestRender();
	}

	#finish(session: LiveSessionController, error?: Error): void {
		if (this.#session !== session) return;
		this.#session = undefined;
		this.#restoreEditor();
		if (error) this.#ctx.showError(error.message);
		const settling = session.stop().catch(cause => {
			logger.debug("Live session cleanup failed", { error: errorFrom(cause).message });
		});
		this.#settling = settling;
		void settling.finally(() => {
			if (this.#settling === settling) this.#settling = undefined;
		});
	}

	#restoreEditor(): void {
		this.#finalizeAssistantTranscript();
		if (this.#animationInterval) {
			clearInterval(this.#animationInterval);
			this.#animationInterval = undefined;
		}
		this.#resumeVocalizer?.();
		this.#resumeVocalizer = undefined;
		const editor = this.#detachedEditor;
		this.#detachedEditor = undefined;
		this.#visualizer = undefined;
		if (!editor) return;
		this.#ctx.editorContainer.clear();
		this.#ctx.editorContainer.addChild(editor);
		if (this.#previousShowHardwareCursor !== undefined) {
			this.#ctx.ui.setShowHardwareCursor(this.#previousShowHardwareCursor);
		}
		if (this.#previousUseTerminalCursor !== undefined) {
			editor.setUseTerminalCursor(this.#previousUseTerminalCursor);
		}
		this.#previousShowHardwareCursor = undefined;
		this.#previousUseTerminalCursor = undefined;
		this.#ctx.ui.setFocus(editor);
		this.#ctx.ui.requestRender();
	}
}
