import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, onAction, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/**
 * Native notifications for the two moments worth interrupting someone.
 *
 * omp's own `desktop-notify.ts` is not reusable here: it is D-Bus plumbing for
 * Linux terminal emulators. Tauri's plugin is native and cross-platform.
 *
 * Nothing fires while the window has focus — a notification for something the
 * user is already looking at is pure noise.
 */

let permission: "granted" | "denied" | "unknown" = "unknown";

async function ensurePermission(): Promise<boolean> {
	if (permission === "granted") return true;
	if (permission === "denied") return false;

	const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
	permission = granted ? "granted" : "denied";
	return granted;
}

async function windowFocused(): Promise<boolean> {
	try {
		return await getCurrentWindow().isFocused();
	} catch {
		return true; // no window: assume focused and stay quiet
	}
}

/**
 * Who to bring forward when a notification is clicked.
 *
 * Registered by the shell, because only it owns which tab is active. Kept at
 * module scope so the listener is installed once for the app rather than once
 * per session view — every open tab renders, so a per-view listener would mean N
 * of them racing to answer the same click.
 */
let activateTab: ((tabId: string) => void) | undefined;
let listening = false;

export function onNotificationActivate(handler: (tabId: string) => void): void {
	activateTab = handler;
	if (listening) return;
	listening = true;
	/*
	 * The notification carries the tab it came from in `extra`, and the plugin
	 * hands the whole payload back on a click. Without it a click could only
	 * raise the window — you were told a background session wanted you and then
	 * dropped wherever you already were.
	 */
	void onAction(notification => {
		const tabId = (notification.extra as { tabId?: unknown } | undefined)?.tabId;
		if (typeof tabId === "string") activateTab?.(tabId);
	}).catch(() => {
		// An unavailable listener costs the routing, not the notification.
	});
}

async function notify(title: string, body: string, tabId: string | undefined): Promise<void> {
	try {
		if (await windowFocused()) return;
		if (!(await ensurePermission())) return;
		sendNotification({ title, body, ...(tabId ? { extra: { tabId } } : {}) });
	} catch {
		// A missing notification is never worth surfacing as an error.
	}
}

export function notifyTurnComplete(model: string | undefined, tabId?: string): void {
	void notify("Turn complete", model ? `${model} finished working.` : "The agent finished working.", tabId);
}

export function notifyApprovalPending(what: string, tabId?: string): void {
	void notify("Waiting for you", what, tabId);
}
