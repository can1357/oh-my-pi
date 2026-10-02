import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BankManager, bankDbPath, ValueError } from "@oh-my-pi/pi-mnemopi/core/banks";

describe("BankManager", () => {
	it("creates, lists, renames, stats, and deletes isolated bank directories", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-banks-"));
		try {
			const manager = new BankManager(root);
			const dbPath = manager.createBank("work");
			expect(existsSync(dbPath)).toBe(true);
			expect(manager.listBanks()).toEqual(["default", "work"]);
			expect(manager.bankExists("work")).toBe(true);
			expect(manager.getBankDbPath("default")).toBe(join(root, "mnemopi.db"));
			expect(manager.getBankDbPath("work")).toBe(join(root, "banks", "work", "mnemopi.db"));
			expect(manager.getBankStats("work").db_size_bytes).toBeGreaterThanOrEqual(0);
			const renamed = manager.renameBank("work", "project_a");
			expect(renamed).toBe(join(root, "banks", "project_a", "mnemopi.db"));
			expect(manager.bankExists("work")).toBe(false);
			expect(manager.bankExists("project_a")).toBe(true);
			expect(manager.deleteBank("project_a")).toBe(true);
			expect(manager.deleteBank("missing")).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates names and protects default deletion", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-banks-"));
		try {
			const manager = new BankManager(root);
			expect(() => manager.createBank("bank with spaces")).toThrow();
			expect(() => manager.createBank("bank/with/slashes")).toThrow();
			expect(() => manager.createBank("bank.with.dots")).toThrow();
			expect(() => manager.getBankDbPath("../escape")).toThrow(ValueError);
			expect(() => manager.deleteBank("../escape", true)).toThrow(ValueError);
			expect(() => bankDbPath("../escape", root)).toThrow(ValueError);
			expect(manager.getBankDbPath("")).toBe(join(root, "mnemopi.db"));
			expect(() => manager.deleteBank("default")).toThrow();
			expect(manager.deleteBank("default", true)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
