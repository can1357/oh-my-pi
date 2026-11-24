/**
 * This browser's identity toward the relay: the per-install instance id, the per-run browser session, and the page
 * target ids the relay derives from both.
 */

const INSTANCE_KEY = "relayInstanceId";
const BROWSER_SESSION_KEY = "relayBrowserSession";

/**
 * Stable per-install browser identity, persisted in `chrome.storage.local` and sent in every hello. The relay
 * namespaces tab registries per instance, so several browsers can share one relay and a service-worker restart keeps
 * the browser's tab registry instead of replacing another browser's connection.
 */
let instanceId: Promise<string> | null = null;

/** The per-install instance id, created on first use. */
export function ensureInstanceId(): Promise<string> {
	instanceId ??= (async () => {
		const stored = await chrome.storage.local.get({ [INSTANCE_KEY]: "" });
		const existing = stored[INSTANCE_KEY];
		if (typeof existing === "string" && existing.length > 0) return existing;
		const created = crypto.randomUUID();
		await chrome.storage.local.set({ [INSTANCE_KEY]: created });
		return created;
	})();
	return instanceId;
}

/**
 * Identity of this browser run, in `chrome.storage.session`. Chrome clears it on restart, when it also reuses tab
 * ids, so the relay retires the previous run's targets instead of resolving an old target id to a new tab. An
 * extension reload clears it too: omp then loses its handles to the tabs it opened, which stay open.
 */
let browserSession: Promise<string> | null = null;

/** The current browser run's session id, created on first use. */
export function ensureBrowserSession(): Promise<string> {
	browserSession ??= (async () => {
		const stored = await chrome.storage.session.get({ [BROWSER_SESSION_KEY]: "" });
		const existing = stored[BROWSER_SESSION_KEY];
		if (typeof existing === "string" && existing.length > 0) return existing;
		const created = crypto.randomUUID();
		await chrome.storage.session.set({ [BROWSER_SESSION_KEY]: created });
		return created;
	})();
	return browserSession;
}

/**
 * The relay's per-instance code in target ids (`bridge.ts instanceCode`): the first 8 base64url characters of
 * SHA-256 over `instanceId/browserSession`, or over `instanceId` alone when the browser session is empty.
 */
export async function instanceCode(instance: string, session: string): Promise<string> {
	const identity = session ? `${instance}/${session}` : instance;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)));
	// 8 base64 characters encode exactly the first 6 bytes, so no padding is involved.
	let binary = "";
	for (const byte of digest.subarray(0, 6)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
}

/** The relay's page target id for `tabId` in this browser run, `PAGE<code>.<tabId>`. */
export async function pageTargetId(tabId: number): Promise<string> {
	const [instance, session] = await Promise.all([ensureInstanceId(), ensureBrowserSession()]);
	return `PAGE${await instanceCode(instance, session)}.${tabId}`;
}
