import { getFactoryDroidRegionBlocklistPath, isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";

/**
 * Reactive region blocklist for the factory-droid provider. Factory's proxy
 * answers `400 Provider not available in this region` when the request's
 * serving edge cannot reach a model's upstreams; the edge-PoP table in
 * discovery hides the known cases proactively, and this list records the
 * ones it missed (unmapped PoPs, rotation-level enforcement) so the model
 * disappears from the picker after the first rejection instead of failing
 * every attempt.
 *
 * Stored as `{ [modelId]: blockedAtMs }` JSON under the agent state dir.
 * Users who change networks can clear it by deleting the file.
 */

type FactoryDroidRegionBlocks = Record<string, number>;

async function readBlocks(agentDir?: string): Promise<FactoryDroidRegionBlocks> {
	try {
		const raw: unknown = JSON.parse(await Bun.file(getFactoryDroidRegionBlocklistPath(agentDir)).text());
		if (!isRecord(raw)) return {};
		const blocks: FactoryDroidRegionBlocks = {};
		for (const [modelId, blockedAt] of Object.entries(raw)) {
			if (typeof blockedAt === "number") blocks[modelId] = blockedAt;
		}
		return blocks;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("factory-droid region blocklist unreadable, ignoring", { error: String(error) });
		}
		return {};
	}
}

/** Model ids blocked by region rejections, oldest evidence preserved. */
export async function readFactoryDroidRegionBlockedIds(agentDir?: string): Promise<readonly string[]> {
	return Object.keys(await readBlocks(agentDir));
}

/**
 * Record a region rejection for a model. Best-effort: a failed write only
 * means the next attempt re-hits the provider's region error.
 */
export async function recordFactoryDroidRegionBlock(modelId: string, agentDir?: string): Promise<void> {
	try {
		const blocks = await readBlocks(agentDir);
		blocks[modelId] = blocks[modelId] ?? Date.now();
		await Bun.write(getFactoryDroidRegionBlocklistPath(agentDir), `${JSON.stringify(blocks)}\n`);
	} catch (error) {
		logger.debug("factory-droid region blocklist write failed", { error: String(error) });
	}
}
