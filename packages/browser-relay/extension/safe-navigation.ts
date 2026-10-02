/**
 * Safe navigation handling for fragmented `about:blank#<hash>` URLs.
 *
 * In Chrome 154+ (and historical Chromium builds), navigating to an `about:` URL
 * with a fragment (e.g. `about:blank#proof-name`) via `Page.navigate` or
 * `chrome.tabs.update` invokes `NavigationRequest::BeginNavigationImpl`.
 * The non-WebUI security validation checks `url::IsAboutBlank(gurl)`, which
 * asserts `parsed_.ref.len <= 0`. Because the fragment makes `ref.len > 0`,
 * `IsAboutBlank` returns false, triggering a fatal CHECK / SIGTRAP (`brk #0x0`)
 * that terminates the entire browser process.
 *
 * Safe path:
 * 1. Never send `about:blank#...` to native `Page.navigate` or `chrome.tabs.update`.
 * 2. For same-document navigations (frame already at `about:blank`), set `location.hash`
 *    directly inside the renderer via `Runtime.evaluate` (using an isolated world),
 *    returning `{ frameId }` without `loaderId` so Chrome emits `Page.navigatedWithinDocument`
 *    and Puppeteer's same-document lifecycle watcher succeeds.
 * 3. For cross-document navigations (frame currently on a web/data URL), navigate
 *    first to clean `"about:blank"` natively (which returns `{ frameId, loaderId }`),
 *    wait for the frame to commit `about:blank`, and then evaluate `location.hash`
 *    in the target frame.
 * 4. Normal web/data and clean `about:blank` URLs pass through to native `Page.navigate`
 *    unmodified.
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

interface RuntimeEvaluateResult {
	result?: { type: string; value?: unknown };
	exceptionDetails?: {
		text?: string;
		exception?: { description?: string };
	};
}

/**
 * Checks whether `rawUrl` is a fragmented `about:blank#<hash>` URL and extracts the hash.
 */
export function parseFragmentedAboutBlank(rawUrl: unknown): { isFragmented: boolean; hash: string } {
	if (typeof rawUrl !== "string") {
		return { isFragmented: false, hash: "" };
	}
	const trimmed = rawUrl.trim();
	if (/^about:blank#/i.test(trimmed)) {
		const hashIndex = trimmed.indexOf("#");
		const hash = hashIndex !== -1 ? trimmed.slice(hashIndex) : "";
		return { isFragmented: true, hash };
	}
	return { isFragmented: false, hash: "" };
}

/**
 * Checks whether a frame's current URL is already an `about:blank` document.
 * Blank or undefined URLs represent initial unnavigated documents.
 */
export function isAlreadyAboutBlank(url?: string): boolean {
	if (!url) return true;
	const trimmed = url.trim().toLowerCase();
	return (
		trimmed === "" ||
		trimmed === "about:blank" ||
		trimmed.startsWith("about:blank#") ||
		trimmed.startsWith("about:blank?")
	);
}

/**
 * Finds a frame by ID recursively in a frame tree.
 */
export function findFrameInTree(node: FrameTreeNode, targetId?: string): FrameInfo | undefined {
	if (!targetId || node.frame.id === targetId) return node.frame;
	if (node.childFrames) {
		for (const child of node.childFrames) {
			const found = findFrameInTree(child, targetId);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Waits for a frame to commit navigation to `about:blank`.
 */
export async function waitForFrameCommit(
	sendCommand: SendCommandFn,
	frameId: string,
	expectedLoaderId?: string,
	maxWaitMs = 1000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		try {
			const treeRes = (await sendCommand("Page.getFrameTree", {})) as FrameTreeResponse | undefined;
			if (treeRes?.frameTree) {
				const frame = findFrameInTree(treeRes.frameTree, frameId);
				if (frame) {
					if (expectedLoaderId && frame.loaderId === expectedLoaderId) {
						return;
					}
					if (frame.url === "about:blank" || frame.url.startsWith("about:blank#")) {
						return;
					}
				}
			}
		} catch {
			// Ignore transient errors during navigation transition
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 15);
		await promise;
	}
}

/**
 * Evaluates `location.hash = hash` in the target frame, preferring an isolated world.
 */
export async function evaluateLocationHash(
	sendCommand: SendCommandFn,
	frameId: string,
	hash: string,
): Promise<{ success: boolean; errorText?: string }> {
	let contextId: number | undefined;
	try {
		const worldRes = (await sendCommand("Page.createIsolatedWorld", {
			frameId,
			worldName: "omp-relay-navigation",
			grantUniversalAccess: true,
			grantUniveralAccess: true,
		})) as { executionContextId?: number } | undefined;
		if (typeof worldRes?.executionContextId === "number") {
			contextId = worldRes.executionContextId;
		}
	} catch {
		// Fallback to default execution context if isolated world creation fails
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

	const evalParams: Record<string, unknown> = {
		expression,
		returnByValue: true,
	};
	if (contextId !== undefined) {
		evalParams.contextId = contextId;
	}

	let evalRes: RuntimeEvaluateResult | undefined;
	try {
		evalRes = (await sendCommand("Runtime.evaluate", evalParams)) as RuntimeEvaluateResult | undefined;
	} catch {
		if (contextId !== undefined) {
			delete evalParams.contextId;
			try {
				evalRes = (await sendCommand("Runtime.evaluate", evalParams)) as RuntimeEvaluateResult | undefined;
			} catch (err) {
				return { success: false, errorText: err instanceof Error ? err.message : String(err) };
			}
		}
	}

	if (evalRes?.exceptionDetails) {
		const err =
			evalRes.exceptionDetails.exception?.description ??
			evalRes.exceptionDetails.text ??
			"Failed to evaluate location.hash";
		return { success: false, errorText: err };
	}

	return { success: true };
}

/**
 * Safe handler for `Page.navigate` CDP commands.
 */
export async function handleSafePageNavigate(
	sendCommand: SendCommandFn,
	params: Record<string, unknown>,
): Promise<SafePageNavigateResult> {
	const rawUrl = typeof params.url === "string" ? params.url : "";
	const { isFragmented, hash } = parseFragmentedAboutBlank(rawUrl);

	// Normal web/data/clean about:blank URLs pass directly to native Page.navigate
	if (!isFragmented) {
		const res = await sendCommand("Page.navigate", params);
		return (res as unknown as SafePageNavigateResult) ?? { frameId: "" };
	}

	const requestedFrameId =
		typeof params.frameId === "string" && params.frameId.length > 0 ? params.frameId : undefined;

	// Resolve frame tree to determine target frame and current URL
	const treeRes = (await sendCommand("Page.getFrameTree", {})) as FrameTreeResponse | undefined;
	const rootFrame = treeRes?.frameTree?.frame;
	const targetFrame = treeRes?.frameTree ? findFrameInTree(treeRes.frameTree, requestedFrameId) : undefined;

	const targetFrameId = requestedFrameId ?? targetFrame?.id ?? rootFrame?.id;
	if (!targetFrameId) {
		throw new Error("Cannot determine target frameId for Page.navigate");
	}

	const currentUrl = targetFrame?.url ?? (targetFrameId === rootFrame?.id ? rootFrame?.url : undefined);

	// Distinguish same-document (already at about:blank) from cross-document
	if (isAlreadyAboutBlank(currentUrl)) {
		const evalRes = await evaluateLocationHash(sendCommand, targetFrameId, hash);
		if (!evalRes.success && evalRes.errorText) {
			return { frameId: targetFrameId, errorText: evalRes.errorText };
		}
		// Same-document navigation: return frameId without loaderId
		return { frameId: targetFrameId };
	}

	// Cross-document navigation: navigate to clean "about:blank" first
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

	// Wait for about:blank navigation to commit in target frame
	await waitForFrameCommit(sendCommand, targetFrameId, loaderId);

	// Evaluate location.hash in target frame
	const evalRes = await evaluateLocationHash(sendCommand, targetFrameId, hash);
	if (!evalRes.success && evalRes.errorText) {
		return { frameId, loaderId, errorText: evalRes.errorText };
	}

	return { frameId, loaderId };
}
