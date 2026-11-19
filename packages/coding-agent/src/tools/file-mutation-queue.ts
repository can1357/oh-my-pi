import * as fs from "node:fs";
import * as path from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();

function getMutationQueueKey(filePath: string): string {
	const resolvedPath = path.resolve(filePath);
	try {
		return fs.realpathSync.native(resolvedPath);
	} catch {
		let current = resolvedPath;
		const segments: string[] = [];
		while (true) {
			const parent = path.dirname(current);
			if (parent === current) {
				break;
			}
			segments.unshift(path.basename(current));
			try {
				const realParent = fs.realpathSync.native(parent);
				return path.join(realParent, ...segments);
			} catch {
				current = parent;
			}
		}
		return resolvedPath;
	}
}

/**
 * Serialize file mutation operations targeting the same file across extensions.
 * Operations for different files still run in parallel.
 *
 * Note: Built-in `edit` and `write` tools in oh-my-pi do not take this queue;
 * this serializes custom tools and extensions against each other.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = getMutationQueueKey(filePath);
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
	const { promise: nextQueue, resolve: releaseNext } = Promise.withResolvers<void>();
	const chainedQueue = currentQueue.then(
		() => nextQueue,
		() => nextQueue,
	);
	fileMutationQueues.set(key, chainedQueue);
	try {
		await currentQueue;
	} catch {
		// Ignore previous queue failure so subsequent mutations can still run.
	}
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
