import * as fs from "node:fs/promises";
import type { CDPSession, Page } from "puppeteer-core";
import { resolveToCwd } from "../path-utils";

/**
 * The file an `init_scripts` entry names, resolved against `cwd`, or `undefined` for source spanning
 * lines, which is JavaScript and never a path.
 */
export function initScriptPath(entry: string, cwd: string): string | undefined {
	return entry.includes("\n") ? undefined : resolveToCwd(entry, cwd);
}

/** Resolve init-script file paths against the session cwd, preserving non-files as inline JavaScript. */
export async function resolveInitScriptSources(entries: readonly string[] | undefined, cwd: string): Promise<string[]> {
	if (!entries?.length) return [];
	return await Promise.all(
		entries.map(async entry => {
			const candidate = initScriptPath(entry, cwd);
			if (candidate === undefined) return entry;
			try {
				const stat = await fs.stat(candidate);
				if (stat.isFile()) return await fs.readFile(candidate, "utf8");
			} catch {
				// A non-file entry is JavaScript source, not a path error.
			}
			return entry;
		}),
	);
}

/**
 * Enable invalid-certificate navigation for the page through CDP.
 *
 * Chromium drops the override when the session that set it detaches, so the
 * returned session must stay attached for as long as the tab honors
 * `insecure`; the tab worker detaches it on close.
 */
export async function applyInsecure(page: Page): Promise<CDPSession> {
	const session = await page.createCDPSession();
	try {
		await session.send("Security.setIgnoreCertificateErrors", { ignore: true });
		return session;
	} catch (error) {
		await session.detach().catch(() => undefined);
		throw error;
	}
}
