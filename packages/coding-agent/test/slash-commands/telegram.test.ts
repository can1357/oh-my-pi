/**
 * `/telegram` dispatch: subcommands reach the controller, bare `/telegram`
 * renders status plus the next step, and an unknown verb is refused instead of
 * guessed at. Modelled on `collab-list.test.ts`.
 */
import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TelegramControllerStatus } from "@oh-my-pi/pi-coding-agent/telegram/controller";

function status(over: Partial<TelegramControllerStatus> = {}): TelegramControllerStatus {
	return {
		state: "off",
		botUsername: null,
		topics: 0,
		liveSessions: 0,
		mirrors: 0,
		attachedThreadId: null,
		error: null,
		configured: true,
		paired: true,
		autoStart: false,
		pairing: false,
		pairingCode: null,
		...over,
	};
}

function harness(current = status()) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const start = vi.fn(async () => current);
	const stop = vi.fn(async (_reason: string) => {});
	const pair = vi.fn(async () => current);
	const unpair = vi.fn(async () => {});
	const ctx = {
		editor: { setText },
		showStatus,
		showError,
		telegramController: { status: () => current, start, stop, pair, unpair },
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		setText,
		showStatus,
		showError,
		start,
		stop,
		pair,
		unpair,
		runtime: { ctx } as BuiltinSlashCommandRuntime,
	};
}

describe("/telegram slash command", () => {
	it("bare /telegram reports status and the next step, and clears the composer", async () => {
		const h = harness(status({ state: "off", paired: true, configured: true }));
		await executeBuiltinSlashCommand("/telegram", h.runtime);
		expect(h.setText).toHaveBeenCalledWith("");
		const text = Bun.stripANSI(String(h.showStatus.mock.calls.at(-1)?.[0] ?? ""));
		expect(text).toContain("Telegram: off");
		expect(text).toContain("/telegram start");
	});

	it("points an unconfigured user at the token setting", async () => {
		const h = harness(status({ configured: false }));
		await executeBuiltinSlashCommand("/telegram", h.runtime);
		expect(Bun.stripANSI(String(h.showStatus.mock.calls.at(-1)?.[0] ?? ""))).toContain("telegram.botToken");
	});

	it("routes start, stop, pair, and unpair to the controller", async () => {
		const h = harness();
		await executeBuiltinSlashCommand("/telegram start", h.runtime);
		expect(h.start).toHaveBeenCalledTimes(1);

		await executeBuiltinSlashCommand("/telegram stop", h.runtime);
		expect(h.stop).toHaveBeenCalledWith("host stopped");
		expect(Bun.stripANSI(String(h.showStatus.mock.calls.at(-1)?.[0] ?? ""))).toBe("Telegram stopped");

		await executeBuiltinSlashCommand("/telegram pair", h.runtime);
		expect(h.pair).toHaveBeenCalledTimes(1);

		await executeBuiltinSlashCommand("/telegram unpair", h.runtime);
		expect(h.unpair).toHaveBeenCalledTimes(1);
	});

	it("renders the running state and counts", async () => {
		const h = harness(status({ state: "running", botUsername: "omp_bot", topics: 3, liveSessions: 1, mirrors: 2 }));
		await executeBuiltinSlashCommand("/telegram status", h.runtime);
		const text = Bun.stripANSI(String(h.showStatus.mock.calls.at(-1)?.[0] ?? ""));
		expect(text).toContain("running as @omp_bot");
		expect(text).toContain("3 topic(s)");
		expect(text).toContain("1 live session(s)");
		expect(text).toContain("2 mirror(s)");
	});

	it("refuses an unknown subcommand with the usage line", async () => {
		const h = harness();
		await executeBuiltinSlashCommand("/telegram frobnicate", h.runtime);
		expect(h.showError).toHaveBeenCalledTimes(1);
		const error = Bun.stripANSI(String(h.showError.mock.calls.at(-1)?.[0] ?? ""));
		expect(error).toContain("Unknown /telegram subcommand: frobnicate");
		expect(error).toContain("/telegram [start|stop|status|pair|unpair]");
		expect(h.start).not.toHaveBeenCalled();
	});
});
