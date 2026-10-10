/**
 * Safe navigation handling for fragmented `about:blank#<hash>` URLs.
 * Avoids native Chromium BeginNavigationImpl crash on non-empty about: fragments.
 */

export type SendCommandFn = (
	method: string,
	params?: Record<string, unknown>,
) => Promise<Record<string, unknown> | undefined>;

export interface FrameInfo {
	id: string;
	url: string;
	loaderId?: string;
}

export interface FrameTreeNode {
	frame: FrameInfo;
	childFrames?: FrameTreeNode[];
}

export interface FrameTreeResponse {
	frameTree?: FrameTreeNode;
}

export interface SafePageNavigateResult {
	frameId: string;
	loaderId?: string;
	errorText?: string;
}

export function parseFragmentedAboutBlank(rawUrl: unknown): { isFragmented: boolean; hash: string } {
	if (typeof rawUrl !== "string") return { isFragmented: false, hash: "" };
	const trimmed = rawUrl.trim();
	if (/^about:blank#/i.test(trimmed)) {
		const hashIndex = trimmed.indexOf("#");
		return { isFragmented: true, hash: hashIndex !== -1 ? trimmed.slice(hashIndex) : "" };
	}
	return { isFragmented: false, hash: "" };
}

export function isAlreadyAboutBlank(url?: string): boolean {
	if (url === undefined || url === "") return true;
	const lower = url.trim().toLowerCase();
	return lower === "about:blank" || lower.startsWith("about:blank#") || lower.startsWith("about:blank?");
}

export function findFrameInTree(node: FrameTreeNode, targetId: string): FrameInfo | undefined {
	if (node.frame.id === targetId) return node.frame;
	if (node.childFrames) {
		for (const child of node.childFrames) {
			const found = findFrameInTree(child, targetId);
			if (found) return found;
		}
	}
	return undefined;
}

export async function waitForFrameCommit(
	sendCommand: SendCommandFn,
	frameId: string,
	expectedLoaderId?: string,
	maxWaitMs = 2000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		const treeRes = (await sendCommand("Page.getFrameTree", {})) as FrameTreeResponse | undefined;
		if (treeRes?.frameTree) {
			const frame = findFrameInTree(treeRes.frameTree, frameId);
			if (frame) {
				const hasBlankUrl = frame.url === "about:blank" || frame.url.startsWith("about:blank#");
				const hasLoaderId = expectedLoaderId ? frame.loaderId === expectedLoaderId : true;
				if (hasBlankUrl && hasLoaderId) return;
			}
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 15);
		await promise;
	}
	throw new Error(`Timed out waiting for frame ${frameId} to commit navigation to about:blank`);
}

export async function evaluateLocationHash(
	sendCommand: SendCommandFn,
	frameId: string,
	hash: string,
	expectedUrl?: string,
): Promise<string> {
	const worldRes = (await sendCommand("Page.createIsolatedWorld", {
		frameId,
		worldName: "omp-relay-navigation",
	})) as { executionContextId?: number } | undefined;

	const contextId = worldRes?.executionContextId;
	if (typeof contextId !== "number") {
		throw new Error("Page.createIsolatedWorld failed to return executionContextId");
	}

	const expression = `(() => {
		const targetHash = ${JSON.stringify(hash)};
		if (location.hash !== targetHash) {
			location.hash = targetHash;
		} else {
			history.replaceState(null, "", location.href);
		}
		return location.href;
	})()`;

	const evalRes = (await sendCommand("Runtime.evaluate", {
		expression,
		contextId,
		returnByValue: true,
	})) as
		| {
				result?: { value?: unknown };
				exceptionDetails?: { text?: string; exception?: { description?: string } };
		  }
		| undefined;

	if (!evalRes) {
		throw new Error("Runtime.evaluate returned undefined response");
	}

	if (evalRes.exceptionDetails) {
		const err =
			evalRes.exceptionDetails.exception?.description ??
			evalRes.exceptionDetails.text ??
			"Runtime.evaluate failed with exception";
		throw new Error(err);
	}

	const resultingUrl = evalRes.result?.value;
	if (typeof resultingUrl !== "string") {
		throw new Error("Runtime.evaluate did not return resulting URL string");
	}

	if (expectedUrl && resultingUrl !== expectedUrl) {
		throw new Error(`Navigation resulted in URL ${resultingUrl}, expected ${expectedUrl}`);
	}

	return resultingUrl;
}

export async function handleSafePageNavigate(
	sendCommand: SendCommandFn,
	params: Record<string, unknown>,
): Promise<SafePageNavigateResult> {
	const rawUrl = typeof params.url === "string" ? params.url : "";
	const { isFragmented, hash } = parseFragmentedAboutBlank(rawUrl);

	if (!isFragmented) {
		return (await sendCommand("Page.navigate", params)) as unknown as SafePageNavigateResult;
	}

	const requestedFrameId =
		typeof params.frameId === "string" && params.frameId.length > 0 ? params.frameId : undefined;

	const treeRes = (await sendCommand("Page.getFrameTree", {})) as FrameTreeResponse | undefined;
	if (!treeRes?.frameTree) {
		throw new Error("Page.getFrameTree did not return frameTree");
	}

	let targetFrame: FrameInfo;
	if (requestedFrameId) {
		const found = findFrameInTree(treeRes.frameTree, requestedFrameId);
		if (!found) {
			throw new Error(`Frame with id ${requestedFrameId} not found`);
		}
		targetFrame = found;
	} else {
		targetFrame = treeRes.frameTree.frame;
	}

	const targetFrameId = targetFrame.id;
	const currentUrl = targetFrame.url;

	if (isAlreadyAboutBlank(currentUrl)) {
		await evaluateLocationHash(sendCommand, targetFrameId, hash, rawUrl);
		return { frameId: targetFrameId };
	}

	const cleanParams: Record<string, unknown> = {
		...params,
		url: "about:blank",
	};

	const navRes = (await sendCommand("Page.navigate", cleanParams)) as SafePageNavigateResult | undefined;
	const frameId = navRes?.frameId ?? targetFrameId;
	const loaderId = navRes?.loaderId;

	if (navRes?.errorText) {
		return { frameId, loaderId, errorText: navRes.errorText };
	}

	await waitForFrameCommit(sendCommand, targetFrameId, loaderId);
	await evaluateLocationHash(sendCommand, targetFrameId, hash, rawUrl);

	return { frameId, loaderId };
}
