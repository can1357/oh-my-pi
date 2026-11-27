/**
 * The fullscreen transcript's reading keys (`app.transcript.*`): paging, line steps, the
 * transcript's ends, the previous or next prompt, copying the selection, and finding text. They act through
 * the host's `scroller` while the composer holds focus with no overlay or completion popup open,
 * ahead of the composer, which would take PageUp/PageDown for its own caret.
 */
import type { Accessor, TranscriptScroller, UiNode } from "@oh-my-pi/pi-tui";
import type { TermPresentation } from "@oh-my-pi/pi-tui/term/backend";
import type { Keybinding } from "../../config/keybindings/app-keybindings";
import type { KeybindingsManager } from "../../config/keybindings/keybindings";
import type { Shell } from "../../ui/shell";

/** What {@link routeTranscriptKeys} reads from the app. */
export interface TranscriptKeysHost {
	readonly shell: Pick<Shell, "interceptInput" | "focused" | "overlays" | "host">;
	/** The frame's presentation: the keys act only in fullscreen. */
	readonly presentation: Accessor<TermPresentation | null>;
	/** The composer's text field: the keys act only while it holds focus. */
	field(): UiNode | undefined;
	/** Whether the composer's completion popup is open (it pages with the same keys). */
	completing(): boolean;
	/** The session keymap. */
	keybindings(): KeybindingsManager;
	/** Open the find field in the dock, leaving the fullscreen transcript visible. */
	openFind(scroller: TranscriptScroller): void;
}

/** Each reading action and its move. */
const MOVES: readonly (readonly [Keybinding, (scroller: TranscriptScroller) => boolean])[] = [
	["app.transcript.pageUp", scroller => scroller.page(-1)],
	["app.transcript.pageDown", scroller => scroller.page(1)],
	["app.transcript.lineUp", scroller => scroller.scrollBy(-1)],
	["app.transcript.lineDown", scroller => scroller.scrollBy(1)],
	["app.transcript.previousUser", scroller => scroller.seekMark(-1)],
	["app.transcript.nextUser", scroller => scroller.seekMark(1)],
	["app.transcript.top", scroller => scroller.toTop()],
	["app.transcript.bottom", scroller => scroller.toBottom()],
];

/**
 * Route the reading keys to the fullscreen transcript (see the module docs); returns the removal.
 * Ctrl+C and Escape drop a selection and keep their prompt meanings; the copy key copies a
 * selection, and passes through when there is none.
 */
export function routeTranscriptKeys(host: TranscriptKeysHost): () => void {
	return host.shell.interceptInput(event => {
		if (event.type !== "key" || event.key.kind === "release") return false;
		const scroller = host.shell.host?.scroller;
		if (!scroller || host.presentation() !== "fullscreen" || host.shell.overlays.open()) return false;
		if (host.shell.focused() !== host.field()) return false;
		const { key } = event;
		if (key.id === "ctrl+c" || key.id === "escape") {
			scroller.dropHighlight();
			return false;
		}
		const keybindings = host.keybindings();
		if (keybindings.matches(key, "app.transcript.copyHighlight") && scroller.copyHighlight()) return true;
		if (host.completing()) return false;
		if (keybindings.matches(key, "app.transcript.find")) {
			host.openFind(scroller);
			return true;
		}
		const move = MOVES.find(([action]) => keybindings.matches(key, action));
		if (!move) return false;
		// Taken even when the view cannot move (at an end): the key never reaches the draft.
		move[1](scroller);
		return true;
	});
}
