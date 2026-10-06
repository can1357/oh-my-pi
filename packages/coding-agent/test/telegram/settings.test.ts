/**
 * `telegram.*` settings → host configuration: environment precedence, defaults,
 * and the named refusals that keep a half-configured host from starting. Ported
 * from lifeos `telegram-config.test.mjs`; the file-path/0600 cases are gone
 * because the token is a credential setting now, not a file next to a machine
 * layer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgTelegramAllowedUserIds,
	cfgTelegramAutoStart,
	cfgTelegramBotToken,
	cfgTelegramChatId,
	isTelegramPaired,
	readTelegramBridgeConfig,
	readTelegramTokenConfig,
} from "@oh-my-pi/pi-coding-agent/telegram/settings";

const TOKEN = "123456:SECRET";
const ENV_TOKEN = "999999:ENV";

const dirs: string[] = [];

function cwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-settings-"));
	dirs.push(dir);
	return dir;
}

/**
 * `cfgTelegramBotToken` reads `Bun.env` on every access, so a token exported by
 * the developer's or CI shell would decide what these cases observe. Clear it
 * for each test and put the shell's value back afterwards instead of deleting
 * it for the rest of the run.
 */
let savedToken: string | undefined;
let exportedToken: string | undefined;

beforeAll(() => {
	exportedToken = Bun.env.PI_TELEGRAM_BOT_TOKEN;
	// Simulate an exported token: the fixture below has to clear it.
	Bun.env.PI_TELEGRAM_BOT_TOKEN = ENV_TOKEN;
});

beforeEach(() => {
	savedToken = Bun.env.PI_TELEGRAM_BOT_TOKEN;
	delete Bun.env.PI_TELEGRAM_BOT_TOKEN;
});

afterEach(() => {
	if (savedToken === undefined) delete Bun.env.PI_TELEGRAM_BOT_TOKEN;
	else Bun.env.PI_TELEGRAM_BOT_TOKEN = savedToken;
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
	if (exportedToken === undefined) delete Bun.env.PI_TELEGRAM_BOT_TOKEN;
	else Bun.env.PI_TELEGRAM_BOT_TOKEN = exportedToken;
});

describe("telegram settings", () => {
	it("declares empty defaults and a false auto-start", () => {
		const settings = Settings.isolated();
		expect(cfgTelegramBotToken.get(settings)).toBe("");
		expect(cfgTelegramChatId.get(settings)).toBe("");
		expect(cfgTelegramAllowedUserIds.get(settings)).toEqual([]);
		expect(cfgTelegramAutoStart.get(settings)).toBe(false);
	});

	it("lets the environment token win over a configured one, and an empty variable yield to it", () => {
		const settings = Settings.isolated({ "telegram.botToken": TOKEN });
		Bun.env.PI_TELEGRAM_BOT_TOKEN = ENV_TOKEN;
		expect(cfgTelegramBotToken.get(settings)).toBe(ENV_TOKEN);
		Bun.env.PI_TELEGRAM_BOT_TOKEN = "";
		expect(cfgTelegramBotToken.get(settings)).toBe(TOKEN);
	});

	it("rejects malformed chat and user ids at write time", () => {
		const settings = Settings.isolated();
		expect(() => cfgTelegramChatId.set(settings, "not-a-number")).toThrow(/telegram\.chatId/);
		expect(() => cfgTelegramChatId.set(settings, "0")).toThrow(/telegram\.chatId/);
		expect(() => cfgTelegramChatId.set(settings, "-100500")).not.toThrow();
		expect(() => cfgTelegramAllowedUserIds.set(settings, ["12x"])).toThrow(/allowedUserIds/);
		expect(() => cfgTelegramAllowedUserIds.set(settings, [7, "8"])).not.toThrow();
	});

	it("refuses a missing token and says where the token comes from", () => {
		const result = readTelegramTokenConfig(Settings.isolated(), cwd());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("no_token");
		expect(result.message).toContain("PI_TELEGRAM_BOT_TOKEN");
	});

	it("refuses a token that is not a BotFather token", () => {
		const result = readTelegramTokenConfig(Settings.isolated({ "telegram.botToken": "not-a-token" }), cwd());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("malformed_token");
		expect(result.message).toContain("@BotFather");
	});

	it("refuses a default directory that does not exist", () => {
		const base = cwd();
		const missing = path.join(base, "does-not-exist");
		const result = readTelegramTokenConfig(
			Settings.isolated({ "telegram.botToken": TOKEN, "telegram.defaultCwd": missing }),
			base,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("cwd_missing");
		expect(result.message).toContain(missing);
	});

	it("resolves a relative default directory against the host cwd and defaults the model to null", () => {
		const base = cwd();
		fs.mkdirSync(path.join(base, "work"));
		const result = readTelegramTokenConfig(
			Settings.isolated({ "telegram.botToken": TOKEN, "telegram.defaultCwd": "work" }),
			base,
		);
		expect(result).toEqual({
			ok: true,
			config: { token: TOKEN, botId: "123456", defaultCwd: path.join(base, "work"), model: null },
		});
	});

	it("never echoes the token in a refusal", () => {
		const result = readTelegramBridgeConfig(
			Settings.isolated({ "telegram.botToken": TOKEN, "telegram.defaultCwd": "/definitely/missing" }),
			cwd(),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).not.toContain(TOKEN);
		expect(result.message).not.toContain("SECRET");
	});

	it("refuses an unpaired bot and an empty allow-list by name", () => {
		const unpaired = readTelegramBridgeConfig(Settings.isolated({ "telegram.botToken": TOKEN }), cwd());
		expect(unpaired.ok).toBe(false);
		if (unpaired.ok) return;
		expect(unpaired.reason).toBe("not_paired");
		expect(unpaired.message).toContain("/telegram pair");

		const noUsers = readTelegramBridgeConfig(
			Settings.isolated({ "telegram.botToken": TOKEN, "telegram.chatId": "-100500" }),
			cwd(),
		);
		expect(noUsers.ok).toBe(false);
		if (noUsers.ok) return;
		expect(noUsers.reason).toBe("no_allowed_users");
	});

	it("builds a host config from a complete, numeric pairing", () => {
		const base = cwd();
		const settings = Settings.isolated({
			"telegram.botToken": TOKEN,
			"telegram.chatId": "-100500",
			"telegram.allowedUserIds": [7, "8"],
			"telegram.model": "anthropic/claude-sonnet-4-5",
		});
		expect(isTelegramPaired(settings)).toBe(true);
		expect(readTelegramBridgeConfig(settings, base)).toEqual({
			ok: true,
			config: {
				token: TOKEN,
				botId: "123456",
				chatId: -100500,
				allowedUserIds: [7, 8],
				defaultCwd: base,
				model: "anthropic/claude-sonnet-4-5",
			},
		});
	});
});
