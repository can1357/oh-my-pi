import * as fs from "node:fs/promises";
import * as path from "node:path";
import { replaceFileAtomically } from "../../utils/atomic-file";
import type { PluginRuntimeConfig } from "./types";

/** Normalizes persisted plugin runtime config across legacy lockfile shapes. */
export function normalizePluginRuntimeConfig(config: Partial<PluginRuntimeConfig>): PluginRuntimeConfig {
	return {
		plugins: config.plugins ?? {},
		settings: config.settings ?? {},
	};
}

/**
 * Write a plugin runtime lockfile readable only by its owner.
 *
 * The lockfile holds plugin settings, and a setting a plugin marks `secret` is
 * a credential the user asked to be masked. The config is staged in a fresh
 * 0600 sibling and renamed over the lockfile, so the credential never lands in
 * an older, wider-mode inode another account may already hold open.
 */
export async function writePluginRuntimeConfig(lockPath: string, config: PluginRuntimeConfig): Promise<void> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const tmpPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
		await replaceFileAtomically(tmpPath, lockPath);
	} finally {
		await fs.rm(tmpPath, { force: true }).catch(() => {});
	}
}
