import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter, type LocalProtocolOptions, resolveLocalRoot } from "../internal-urls";
import { normalizeLocalScheme } from "../internal-urls/parse";
import { resolveToCwd } from "../tools/path-utils";

/**
 * Resolves a plan path to its on-disk file: internal URLs through the scheme's
 * sync locate, anything else against `cwd`. Throws for internal URLs no local file backs.
 */
export function resolvePlanFilePath(
	planFilePath: string,
	options: { localProtocolOptions: LocalProtocolOptions; cwd: string },
): string {
	const url = normalizeLocalScheme(planFilePath);
	const router = InternalUrlRouter.instance();
	if (!router.canHandle(url)) return resolveToCwd(planFilePath, options.cwd);
	const located = router.locateSync(url, { cwd: options.cwd, localProtocolOptions: options.localProtocolOptions });
	if (located === undefined) throw new Error(`No local file backs plan path ${planFilePath}`);
	return located;
}

/** Reads a plan from an internal URL or cwd-relative filesystem path. */
export async function readPlanFile(
	planFilePath: string,
	options: { localProtocolOptions: LocalProtocolOptions; cwd: string },
): Promise<string | null> {
	const resolvedPath = resolvePlanFilePath(planFilePath, options);
	try {
		return await Bun.file(resolvedPath).text();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/** Lists session-local plan files from newest to oldest. */
export async function listPlanFiles(options: { localProtocolOptions: LocalProtocolOptions }): Promise<string[]> {
	const localRoot = path.resolve(resolveLocalRoot(options.localProtocolOptions));
	try {
		const entries = await fs.promises.readdir(localRoot, { withFileTypes: true });
		const plans = await Promise.all(
			entries
				.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
				.map(async entry => {
					const stat = await fs.promises.stat(path.join(localRoot, entry.name)).catch(() => null);
					return { url: `local://${entry.name}`, mtime: stat?.mtimeMs ?? 0 };
				}),
		);
		return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
	} catch {
		return [];
	}
}
