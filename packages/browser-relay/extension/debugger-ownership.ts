/**
 * `chrome.debugger.getTargets()` reports `attached: true` for any debugger
 * client (DevTools, another extension), not only this one. A command sent
 * through `chrome.debugger.sendCommand` succeeds only on our own attachment,
 * so the probe keeps exactly the tabs this extension can drive. The browser
 * process answers it, so a blocked or crashed page doesn't delay the probe.
 */
export async function ownedDebuggerTabs(
	targets: ReadonlyArray<{ attached: boolean; tabId?: number }>,
	probe: (tabId: number) => Promise<unknown>,
): Promise<number[]> {
	const owned = await Promise.all(
		targets.map(async target => {
			if (!target.attached || target.tabId === undefined) return undefined;
			try {
				await probe(target.tabId);
				return target.tabId;
			} catch {
				return undefined;
			}
		}),
	);
	return owned.filter((tabId): tabId is number => tabId !== undefined);
}
