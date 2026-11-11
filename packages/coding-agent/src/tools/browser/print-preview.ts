/**
 * Telling a browser call that stalls on Chrome's print preview from one that is merely slow.
 *
 * A page's `window.print()` opens the preview and holds the page's script until someone closes it: input,
 * navigation and anything waiting on the page's event loop stall for the call's whole timeout, and the recovery
 * that follows a timeout stalls too, so the tab is killed. The profiles omp seeds turn printing off
 * (`seedOwnedProfilePreferences`); a profile it does not seed (`app.path`, `app.cdp_url`) and the relay's Chrome
 * can still open the preview, and nothing outside Chrome can close it without navigating the page away.
 */
import { withTimeout } from "@oh-my-pi/pi-utils";
import type { CDPSession, Page } from "puppeteer-core";

/** How long a run goes before omp checks whether a print preview holds its page, and the gap between checks. */
export const PRINT_PREVIEW_CHECK_MS = 1_000;

/** How long the browser and the page get to answer one check; a loaded machine can take this long. */
const ANSWER_MS = 1_000;

/** How long after its plain answer a page the preview does not hold settles an already resolved promise. */
const PROMISE_SETTLE_MS = 300;

export const PRINT_PREVIEW_OPEN_MESSAGE =
	"The page called window.print() and Chrome's print preview is holding it, so this call stalled: clicks, typing " +
	"and most evaluations wait until the preview closes. Ask the user to switch to this tab in Chrome and press Cancel " +
	"in its print preview, or navigate this tab to another URL, which closes the preview and loses the page's state. " +
	"Input this call sent may land once the preview closes.";

/** `promise`'s value, or `fallback` once `ms` pass first; a rejection counts as `fallback` too. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return withTimeout(promise, ms, "Print preview check timed out").catch(() => fallback);
}

/**
 * Whether a print preview is open and holds one of `page`'s frames. Never rejects: a browser or page that cannot
 * answer in time gives no verdict (`false`), and the caller asks again later.
 *
 * Chrome lists an open preview as a `chrome://print/` page target that names no opener, which says only that one is
 * open somewhere in the browser; through the omp relay the extension answers from `chrome.debugger.getTargets()`,
 * since the relay's target list holds tabs only. The held check ties it to this page.
 */
export async function printPreviewHolds(page: Page, relay: boolean): Promise<boolean> {
	if (!(await within(printPreviewOpen(page, relay), ANSWER_MS, false))) return false;
	const sessions = new Set<CDPSession>(page.frames().map(frame => frame.client));
	const held = await Promise.all([...sessions].map(sessionHeld));
	return held.includes(true);
}

async function printPreviewOpen(page: Page, relay: boolean): Promise<boolean> {
	const client = page.mainFrame().client;
	if (relay) {
		// Puppeteer's protocol map cannot express the relay-private method; the send signature is otherwise identical.
		const raw = client as unknown as { send(method: string): Promise<unknown> };
		const reply = await raw.send("OMP.printPreviewOpen");
		return typeof reply === "object" && reply !== null && "open" in reply && reply.open === true;
	}
	const connection = client.connection();
	if (!connection) return false;
	const { targetInfos } = await connection.send("Target.getTargets");
	return targetInfos.some(info => info.type === "page" && info.url.startsWith("chrome://print"));
}

/**
 * While the preview is open, Chrome still runs a plain evaluation in the held renderer but never settles a promise,
 * which no busy script and no slow load does: a script loop answers neither, a slow load answers both. Each
 * cross-site frame runs in its own renderer and is checked on its session.
 */
async function sessionHeld(session: CDPSession): Promise<boolean> {
	let settled = false;
	// Stays pending in Chrome until the preview closes; its late answer only sets `settled`.
	// Async functions return an intrinsic promise even when the page replaces the global Promise.
	const promise = session.send("Runtime.evaluate", { expression: "(async () => {})()", awaitPromise: true }).then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	const answered = await within(
		session.send("Runtime.evaluate", { expression: "0" }).then(() => true),
		ANSWER_MS,
		false,
	);
	if (!answered) return false;
	await within(promise, PROMISE_SETTLE_MS, undefined);
	return !settled;
}
