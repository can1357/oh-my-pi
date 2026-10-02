/**
 * One host per bot token: a second acquire refuses with the holder pid, the
 * `host.json` metadata records the live owner, and release frees the bot.
 * Ported from lifeos `telegram-lock.test.mjs`; the TTL-renewal and detached
 * daemon cases are gone — an OS-held lock has no TTL and there is no daemon.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireTelegramHostLock,
	readTelegramLockHolder,
	telegramHostDir,
} from "@oh-my-pi/pi-coding-agent/telegram/lock";

const BOT = "123456";
let base = "";

beforeEach(() => {
	base = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-lock-"));
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

describe("telegram host lock", () => {
	it("keys the state directory by bot id", () => {
		expect(telegramHostDir(BOT, base)).toBe(path.join(base, BOT));
	});

	it("refuses a second acquire with the holder pid and frees the bot on release", async () => {
		const first = await acquireTelegramHostLock(BOT, base);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(await readTelegramLockHolder(BOT, base)).toBe(process.pid);
		expect(fs.readFileSync(path.join(telegramHostDir(BOT, base), "host.json"), "utf8")).toBe(
			JSON.stringify({ pid: process.pid }),
		);

		const second = await acquireTelegramHostLock(BOT, base);
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.holderPid).toBe(process.pid);

		await first.lease.release();
		expect(await readTelegramLockHolder(BOT, base)).toBeNull();
		expect(fs.existsSync(path.join(telegramHostDir(BOT, base), "host.json"))).toBe(false);

		const third = await acquireTelegramHostLock(BOT, base);
		expect(third.ok).toBe(true);
		if (third.ok) await third.lease.release();
	});

	it("lets different bots hold their own locks", async () => {
		const one = await acquireTelegramHostLock("111", base);
		const two = await acquireTelegramHostLock("222", base);
		expect(one.ok).toBe(true);
		expect(two.ok).toBe(true);
		if (one.ok) await one.lease.release();
		if (two.ok) await two.lease.release();
	});

	it("reports no holder for a bot that was never hosted, without creating its state directory", async () => {
		// No `<stateDir>/<botId>` exists yet, and `<dir>/host` is the lock. The
		// probe must not open it: platforms whose lock is a flock sidecar created
		// with `create(true)` (macOS and other non-Linux Unices) raise ENOENT for
		// the missing parent, which would crash `omp telegram status` for a bot
		// that has never run instead of printing `bridge: not running`.
		const dir = telegramHostDir("nobody", base);
		expect(fs.existsSync(dir)).toBe(false);

		expect(await readTelegramLockHolder("nobody", base)).toBeNull();

		// Probing a free bot must not create state as a side effect.
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("reports no holder once a killed host left only its host.json behind", async () => {
		// A killed process loses the OS lock but never removes its metadata.
		const dir = telegramHostDir(BOT, base);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "host.json"), JSON.stringify({ pid: 999_999 }));
		expect(await readTelegramLockHolder(BOT, base)).toBeNull();
		const next = await acquireTelegramHostLock(BOT, base);
		expect(next.ok).toBe(true);
		if (next.ok) await next.lease.release();
	});
});
