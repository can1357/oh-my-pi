import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../rpc/transport";
import { WEBVIEW_READY } from "./webview-marker";

/**
 * A way for the webview to say something the host can read.
 *
 * A packaged build has no console anyone will ever open, so everything the page
 * knows about its own failures dies inside it. That is not a theoretical loss:
 * a content security policy tightened without any way to observe the result, a
 * capability whose scope refused every path, and a plugin whose Rust half was
 * never registered all shipped in this app, and every one of them announced
 * itself in a console nobody could see.
 *
 * The host prints these to stderr, which is where `scripts/smoke.ts` reads them.
 * That is also what makes the smoke test able to tell a live window from a dead
 * one: Rust pre-warms a sidecar during `setup`, before a webview exists, so the
 * presence of a sidecar proves nothing about the page. A line that only the page
 * can emit does.
 */
export function installDiagnostics(): void {
	if (!isTauri()) return;

	// Fire-and-forget by design: a diagnostic that can fail loudly is a new
	// failure mode, and one that throws inside an error handler is a loop.
	const say = (level: "info" | "error", message: string): void => {
		void invoke("webview_log", { level, message }).catch(() => {});
	};

	window.addEventListener("securitypolicyviolation", event => {
		say("error", `Content Security Policy blocked ${event.violatedDirective}: ${event.blockedURI || "(inline)"}`);
	});

	window.addEventListener("error", event => {
		// `event.error` is absent for resource load failures, which are exactly the
		// ones a bad CSP or a missing asset produces.
		const detail = event.error instanceof Error ? event.error.message : event.message;
		say("error", `Uncaught: ${detail}`);
	});

	window.addEventListener("unhandledrejection", event => {
		const reason = event.reason;
		say("error", `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
	});

	// The marker. Emitted last, so it means the handlers above are installed too.
	say("info", WEBVIEW_READY);
}
