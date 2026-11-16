import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { cleanupAbandonedLoginDirectories } from "../src/registry/oauth/antigravity-cli";

async function exists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

describe("cleanupAbandonedLoginDirectories", () => {
	it("removes old tokenless directories and keeps recoverable or recent ones", async () => {
		using temp = TempDir.createSync("@omp-agy-login-cleanup-");
		const root = temp.join("logins");
		const now = Date.parse("2026-11-16T12:00:00Z");
		const old = new Date(now - 25 * 60 * 60 * 1000);
		const recent = new Date(now - 60 * 60 * 1000);

		const oldEmpty = path.join(root, "login-old-empty");
		const oldToken = path.join(root, "login-old-token");
		const recentEmpty = path.join(root, "login-recent-empty");
		const other = path.join(root, "other");
		await fs.mkdir(oldEmpty, { recursive: true });
		await fs.mkdir(oldToken, { recursive: true });
		await fs.mkdir(recentEmpty, { recursive: true });
		await fs.mkdir(other, { recursive: true });
		await Bun.write(path.join(oldToken, "antigravity-cli", "antigravity-oauth-token"), "{}");
		await fs.utimes(oldEmpty, old, old);
		await fs.utimes(oldToken, old, old);
		await fs.utimes(recentEmpty, recent, recent);
		await fs.utimes(other, old, old);

		expect(await cleanupAbandonedLoginDirectories(root, now)).toBe(1);
		expect(await exists(oldEmpty)).toBe(false);
		expect(await exists(oldToken)).toBe(true);
		expect(await exists(recentEmpty)).toBe(true);
		expect(await exists(other)).toBe(true);
	});

	it("restores a directory when a credential appears after the claim", async () => {
		using temp = TempDir.createSync("@omp-agy-login-cleanup-race-");
		const root = temp.join("logins");
		const directory = path.join(root, "login-race");
		const now = Date.parse("2026-11-16T12:00:00Z");
		const old = new Date(now - 25 * 60 * 60 * 1000);
		await fs.mkdir(directory, { recursive: true });
		await fs.utimes(directory, old, old);

		const removed = await cleanupAbandonedLoginDirectories(root, now, {
			afterClaim: async claimed => {
				await Bun.write(path.join(claimed, "antigravity-cli", "antigravity-oauth-token"), "{}");
			},
		});

		expect(removed).toBe(0);
		expect(await exists(directory)).toBe(true);
		expect(await Bun.file(path.join(directory, "antigravity-cli", "antigravity-oauth-token")).exists()).toBe(true);
	});

	it("returns zero for a missing root", async () => {
		using temp = TempDir.createSync("@omp-agy-login-cleanup-");
		expect(await cleanupAbandonedLoginDirectories(temp.join("missing"))).toBe(0);
	});
});
