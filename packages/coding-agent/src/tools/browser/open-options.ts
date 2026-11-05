import * as fs from "node:fs/promises";
import type { CDPSession, Page } from "puppeteer-core";
import { resolveToCwd } from "../path-utils";

/** Resolve init-script file paths against the session cwd, preserving non-files as inline JavaScript. */
export async function resolveInitScriptSources(entries: readonly string[] | undefined, cwd: string): Promise<string[]> {
	if (!entries?.length) return [];
	return await Promise.all(
		entries.map(async entry => {
			const candidate = resolveToCwd(entry, cwd);
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
 * `ignore_https_errors`; the tab worker detaches it on close.
 */
export async function applyIgnoreHttpsErrors(page: Page): Promise<CDPSession> {
	const session = await page.createCDPSession();
	try {
		await session.send("Security.setIgnoreCertificateErrors", { ignore: true });
		return session;
	} catch (error) {
		await session.detach().catch(() => undefined);
		throw error;
	}
}
