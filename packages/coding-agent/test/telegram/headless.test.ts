/**
 * `omp telegram status`: config sanity, the topics-disabled refusal, and the
 * lock holder — never the token. Ported from lifeos `telegram.test.mjs`
 * (`check` + `status`), merged into the one status surface omp exposes; the
 * detached-daemon and file-lock cases are gone with the daemon and TTL lock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { telegramStatusReport } from "@oh-my-pi/pi-coding-agent/telegram/headless";
import type { TelegramApi, TelegramChat, TelegramUser } from "@oh-my-pi/pi-coding-agent/telegram/types";
import { acquireTelegramHostLock } from "@oh-my-pi/pi-coding-agent/telegram/lock";

const TOKEN = "123456:SECRET";
const BOT_ID = "123456";

let base = "";
let cwd = "";
/**
 * `PI_TELEGRAM_BOT_TOKEN` is read from `Bun.env` on every access, so an
 * exported token turns `omp telegram status` into a real `api.telegram.org`
 * call. Every test must run without it, and the value the shell exported must
 * come back afterwards for later files.
 */
let savedToken: string | undefined;
let exportedToken: string | undefined;

beforeAll(() => {
	exportedToken = Bun.env.PI_TELEGRAM_BOT_TOKEN;
	// Simulate a dev/CI shell that exports a bot token: the fixture below has to
	// clear it, or the cases that expect "no token" would use this one.
	Bun.env.PI_TELEGRAM_BOT_TOKEN = TOKEN;
});

beforeEach(() => {
	savedToken = Bun.env.PI_TELEGRAM_BOT_TOKEN;
	delete Bun.env.PI_TELEGRAM_BOT_TOKEN;
	base = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-status-"));
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-cwd-"));
});

afterEach(() => {
	if (savedToken === undefined) delete Bun.env.PI_TELEGRAM_BOT_TOKEN;
	else Bun.env.PI_TELEGRAM_BOT_TOKEN = savedToken;
	fs.rmSync(base, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

afterAll(() => {
	if (exportedToken === undefined) delete Bun.env.PI_TELEGRAM_BOT_TOKEN;
	else Bun.env.PI_TELEGRAM_BOT_TOKEN = exportedToken;
});

function paired() {
	return Settings.isolated({
		"telegram.botToken": TOKEN,
		"telegram.chatId": "-100500",
		"telegram.allowedUserIds": [7],
	});
}

function api(options: { me?: TelegramUser; chat?: TelegramChat; fail?: string } = {}): TelegramApi {
	return {
		getMe: async () => {
			if (options.fail) throw new Error(options.fail);
			return options.me ?? { id: 1, first_name: "Bridge", username: "my_bot", has_topics_enabled: true };
		},
		getChat: async () => options.chat ?? { id: -100500, type: "supergroup", title: "Team", is_forum: true },
	} as unknown as TelegramApi;
}

describe("omp telegram status", () => {
	it("names what is missing without a token and prints no secret", async () => {
		// The stub must never be reached: without a token the report has no bot to
		// ask, so an exported `PI_TELEGRAM_BOT_TOKEN` would show up as a code-2
		// "Telegram did not answer" instead.
		const report = await telegramStatusReport({
			settings: Settings.isolated(),
			cwd,
			baseDir: base,
			api: api({ fail: "no bot token is configured" }),
		});
		expect(report.code).toBe(1);
		expect(report.lines.join("\n")).toContain("PI_TELEGRAM_BOT_TOKEN");
		expect(report.lines.join("\n")).not.toContain(TOKEN);
	});

	it("passes on a usable configuration and never prints the token", async () => {
		const report = await telegramStatusReport({ settings: paired(), cwd, baseDir: base, api: api() });
		const text = report.lines.join("\n");
		expect(report.code).toBe(0);
		expect(text).toContain("@my_bot");
		expect(text).toContain("topics enabled: yes");
		expect(text).toContain("chat: Team (supergroup)");
		expect(text).toContain("allowed users: 7");
		expect(text).toContain("bridge: not running");
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain("SECRET");
	});

	it("refuses a private chat whose bot has topics disabled", async () => {
		const report = await telegramStatusReport({
			settings: paired(),
			cwd,
			baseDir: base,
			api: api({
				me: { id: 1, first_name: "Bridge", username: "my_bot", has_topics_enabled: false },
				chat: { id: 7, type: "private", first_name: "Dev" },
			}),
		});
		const text = report.lines.join("\n");
		expect(report.code).toBe(1);
		expect(text).toContain("topics enabled: no");
		expect(text).toContain("@BotFather");
		expect(text).toContain("Threaded Mode");
	});

	it("refuses a non-forum group", async () => {
		const report = await telegramStatusReport({
			settings: paired(),
			cwd,
			baseDir: base,
			api: api({ chat: { id: -100500, type: "supergroup", title: "Team", is_forum: false } }),
		});
		const text = report.lines.join("\n");
		expect(report.code).toBe(1);
		expect(text).toContain("Topics");
	});

	it("reports bridge: not running for a bot whose state directory does not exist", async () => {
		// A newer bot was never hosted, so `<baseDir>/<botId>` is absent and there
		// is no lock to probe. Platforms whose lock is a flock sidecar would raise
		// ENOENT here instead of printing the status line.
		const absent = path.join(base, "never-hosted");
		expect(fs.existsSync(absent)).toBe(false);

		const report = await telegramStatusReport({ settings: paired(), cwd, baseDir: absent, api: api() });

		expect(report.code).toBe(0);
		expect(report.lines.join("\n")).toContain("bridge: not running");
		expect(fs.existsSync(absent)).toBe(false);
	});

	it("names the process holding the bot lock", async () => {
		const held = await acquireTelegramHostLock(BOT_ID, base);
		if (!held.ok) throw new Error("lock should be free");
		try {
			const report = await telegramStatusReport({ settings: paired(), cwd, baseDir: base, api: api() });
			expect(report.lines.join("\n")).toContain(`bridge: running (pid ${process.pid})`);
		} finally {
			await held.lease.release();
		}
	});

	it("reports a Telegram failure with the token redacted", async () => {
		const report = await telegramStatusReport({
			settings: paired(),
			cwd,
			baseDir: base,
			api: api({ fail: `401 Unauthorized for bot ${TOKEN}` }),
		});
		const text = report.lines.join("\n");
		expect(report.code).toBe(2);
		expect(text).toContain("401");
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain("SECRET");
	});

	it("says the bot is not paired when only the token is set", async () => {
		const report = await telegramStatusReport({
			settings: Settings.isolated({ "telegram.botToken": TOKEN }),
			cwd,
			baseDir: base,
			api: api(),
		});
		expect(report.code).toBe(1);
		expect(report.lines.join("\n")).toContain("not paired");
	});
});
