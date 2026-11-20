/**
 * Opening and closing the side panel: the toolbar icon opens it (Chrome handles that), the `toggle-side-panel`
 * command (Cmd/Ctrl+E) toggles it in the current window.
 */

/** Name of the manifest command that toggles the panel. */
const TOGGLE_COMMAND = "toggle-side-panel";

/** Toggle the panel in `windowId`: close it when a panel is open there and Chrome can close it, else open it. */
function toggle(windowId: number, isOpen: (windowId: number) => boolean): void {
	// Chrome 141 added `close`; older browsers can only open, which the command still does.
	if (isOpen(windowId) && typeof chrome.sidePanel.close === "function") {
		chrome.sidePanel.close({ windowId }).catch(() => {});
		return;
	}
	// Called synchronously from the command listener: `open` needs the key press as its user gesture.
	chrome.sidePanel.open({ windowId }).catch(() => {});
}

/** Make the toolbar icon open the panel and serve the toggle command; `isOpen` tells whether a panel shows in a window. */
export function installSidePanel(isOpen: (windowId: number) => boolean): void {
	chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
	chrome.commands.onCommand.addListener((command, tab) => {
		if (command !== TOGGLE_COMMAND) return;
		if (tab) {
			toggle(tab.windowId, isOpen);
			return;
		}
		// No tab came with the command (a devtools window); the gesture may not survive this lookup.
		void chrome.windows.getLastFocused().then(window => {
			if (window.id !== undefined) toggle(window.id, isOpen);
		});
	});
}
