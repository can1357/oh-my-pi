import type { Target } from "puppeteer-core";

/** Standing settings/environment are never attachment permission. */
export function requestedAttachment(app?: { cdp_url?: string; path?: string; relay?: boolean }): "connected" | "relay" | undefined {
	if (app?.cdp_url) return "connected";
	if (app?.path) return undefined;
	return app?.relay === true ? "relay" : undefined;
}

/** Resolve only the approved ID, without attaching/probing any other target. */
export function selectedAttachmentTarget(targets: readonly Target[], targetId: string): Target {
	const target = targets.find(candidate =>
		(candidate as Target & { _targetId?: string })._targetId === targetId);
	if (!target) throw new Error("Selected browser tab is no longer available; select it again.");
	return target;
}

/** Discovery is metadata only: do not create a page/CDP session before selection. */
export interface AttachmentTarget {
	id: string;
	type: string;
	title: string;
	url: string;
	discarded?: string;
}

export interface AttachmentSelectionContext {
	ownerSessionId?: string;
	hasUI?: boolean;
	select?: (title: string, options: string[], signal?: AbortSignal) => Promise<string | undefined>;
}

/** Authorize exactly one browser-instance/tab pair for this task, never a title identity. */
export async function selectAttachmentTarget(
	endpoint: string,
	readTargets: () => Promise<AttachmentTarget[]>,
	context: AttachmentSelectionContext,
	matcher?: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	if (!context.ownerSessionId || context.hasUI === false || !context.select) {
		throw new Error("Attaching a user browser requires an interactive host-user tab selection and a task session identity. Use managed Chromium instead.");
	}
	const entries = await readTargets();
	signal?.throwIfAborted();
	const needle = matcher?.toLowerCase();
	const pages = entries.filter(entry => entry.type === "page" && entry.discarded !== "true" &&
		(!needle || entry.url.toLowerCase().includes(needle) || entry.title.toLowerCase().includes(needle)));
	if (!pages.length) throw new Error("No eligible browser tabs match the requested attachment. No tab was attached.");
	const rows = pages.map(entry => `[${entry.id}] ${entry.title || "(untitled)"} — ${entry.url}`);
	const choice = await context.select(
		`Allow task ${context.ownerSessionId} to control one tab at ${endpoint}? IDs identify browser instances; titles do not identify signed-in profiles.`,
		rows,
		signal,
	);
	signal?.throwIfAborted();
	const index = choice === undefined ? -1 : rows.indexOf(choice);
	if (index < 0) throw new Error("Browser attachment cancelled. No tab was attached.");
	const selected = pages[index]!;
	// Revalidate metadata after the human responds. A disappeared/replaced tab
	// must fail closed, not fall back to whichever tab is now active.
	const current = (await readTargets()).find(entry => entry.id === selected.id && entry.type === "page");
	signal?.throwIfAborted();
	if (!current || current.discarded === "true" || current.url !== selected.url) {
		throw new Error("Selected browser tab changed or disappeared during approval. Select it again.");
	}
	return selected.id;
}

/** Exclude every unselected page/tab, including the relay's paired TAB target. */
export function attachmentTargetFilter(targetId: string): (target: Target) => boolean {
	const tabId = targetId.startsWith("PAGE") ? `TAB${targetId.slice(4)}` : targetId;
	return target => {
		const type = String(target.type());
		if (type !== "page" && type !== "tab") return true;
		const id = (target as Target & { _targetId?: string })._targetId;
		return id === targetId || id === tabId;
	};
}

/** Named attachments are permissions of their approving task, not process globals. */
export function assertAttachmentOwner(kind: string, owner: string | undefined, caller: string | undefined): void {
	if ((kind === "relay" || kind === "connected") && (!caller || owner !== caller)) {
		throw new Error("This attached browser tab belongs to another task. Open a separately named tab with host-user selection.");
	}
}
