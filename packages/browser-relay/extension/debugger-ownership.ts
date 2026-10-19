/**
 * Keeps the attached tabs whose `probe` succeeds: a command reaches only this extension's own attachment.
 * The browser process answers the probe, so a blocked or crashed page doesn't delay it.
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
