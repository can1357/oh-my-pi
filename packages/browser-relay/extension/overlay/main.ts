/**
 * Entry of `overlay.js`, the content script the worker injects into a tab's top frame on demand
 * (`chrome.scripting.executeScript`). Injecting it again into the same document is a no-op: the first copy keeps
 * its state and its one message listener.
 */
import type { OverlayCommand } from "../messages";
import { Overlay } from "./overlay";

/** How often a running overlay checks that its extension is still there. */
const LIVENESS_MS = 2000;

declare global {
	/** The overlay running in this document's isolated world; `alive` turns false once its extension context dies. */
	var ompOverlay: { alive(): boolean; dispose(): void } | undefined;
}

function isOverlayCommand(message: unknown): message is OverlayCommand {
	return typeof message === "object" && message !== null && "omp" in message && message.omp === "overlay";
}

/** Whether this script's extension context still exists (it doesn't after the extension reloads or is removed). */
function alive(): boolean {
	try {
		return chrome.runtime.id !== undefined;
	} catch {
		return false;
	}
}

function install(): void {
	const overlay = new Overlay();
	const onMessage = (
		message: unknown,
		_sender: chrome.runtime.MessageSender,
		sendResponse: (answer: unknown) => void,
	): boolean => {
		if (!isOverlayCommand(message)) return false;
		// A command that fails still answers, so the worker's `sendMessage` never hangs on it.
		overlay.handle(message).then(sendResponse, () => sendResponse(null));
		return true;
	};
	const dispose = (): void => {
		clearInterval(watch);
		globalThis.ompOverlay = undefined;
		overlay.dispose();
		try {
			chrome.runtime.onMessage.removeListener(onMessage);
		} catch {
			// An invalidated extension context has no listeners left to remove.
		}
	};
	// Nothing tells a content script its extension went away; without this its art would outlive the controller.
	const watch = setInterval(() => {
		if (!alive()) dispose();
	}, LIVENESS_MS);
	chrome.runtime.onMessage.addListener(onMessage);
	globalThis.ompOverlay = { alive, dispose };
}

// Only the top frame draws, and only one copy per document. A copy orphaned by an extension reload is replaced.
if (window.top === window && !globalThis.ompOverlay?.alive()) {
	globalThis.ompOverlay?.dispose();
	install();
}
