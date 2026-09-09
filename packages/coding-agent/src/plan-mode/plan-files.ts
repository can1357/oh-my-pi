import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";

/** Reads a plan from a local URL or cwd-relative filesystem path. */
export async function readPlanFile(
	planFilePath: string,
	options: { localProtocolOptions: LocalProtocolOptions; cwd: string },
): Promise<string | null> {
	const resolvedPath = planFilePath.startsWith("local:")
		? resolveLocalUrlToPath(normalizeLocalScheme(planFilePath), options.localProtocolOptions)
		: resolveToCwd(planFilePath, options.cwd);
	try {
		return await Bun.file(resolvedPath).text();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/** Lists session-local plan files from newest to oldest. */
export async function listPlanFiles(options: { localProtocolOptions: LocalProtocolOptions }): Promise<string[]> {
	const localRoot = resolveLocalUrlToPath("local://", options.localProtocolOptions);
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
