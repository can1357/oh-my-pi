/**
 * Command surface: parsing (including the `/cmd@botname` form Telegram sends in
 * groups), the registered menu, and the help texts the bot prints.
 */
import { describe, expect, it } from "bun:test";
import {
	ADOPT_HELP,
	AUTO_SESSION_NAME,
	BOT_COMMANDS,
	parseCommand,
	TOPIC_HELP,
	TOPIC_NAME_LIMIT,
	WORKSPACE_HELP,
} from "@oh-my-pi/pi-coding-agent/telegram/commands";

describe("parseCommand", () => {
	it("parses a bare command, its argument and the bot-suffixed group form", () => {
		expect(parseCommand("/new")).toEqual({ name: "new", rest: "", addressee: null });
		expect(parseCommand("  /new Fox  ")).toEqual({ name: "new", rest: "Fox", addressee: null });
		expect(parseCommand("/resume abc123 Fox")).toEqual({ name: "resume", rest: "abc123 Fox", addressee: null });
		expect(parseCommand("/status@omp_bridge")).toEqual({ name: "status", rest: "", addressee: "omp_bridge" });
		expect(parseCommand("/new@omp_bridge Fox /work")).toEqual({
			name: "new",
			rest: "Fox /work",
			addressee: "omp_bridge",
		});
		expect(parseCommand("/steer multi\nline text")).toEqual({
			name: "steer",
			rest: "multi\nline text",
			addressee: null,
		});
	});

	it("matches the command name whatever the case (mobile keyboards capitalize it)", () => {
		expect(parseCommand("/Stop")).toEqual({ name: "stop", rest: "", addressee: null });
		expect(parseCommand("/New Fox")).toEqual({ name: "new", rest: "Fox", addressee: null });
		expect(parseCommand("/CLOSE@OtherBot")).toEqual({ name: "close", rest: "", addressee: "OtherBot" });
	});

	it("returns null for anything that is not a command", () => {
		expect(parseCommand("hello")).toBeNull();
		expect(parseCommand("/")).toBeNull();
		expect(parseCommand("/foo-bar")).toBeNull();
		expect(parseCommand(" / spaced")).toBeNull();
		expect(parseCommand("")).toBeNull();
	});
});

describe("bot command menu", () => {
	it("registers every command the help texts promise", () => {
		const names = BOT_COMMANDS.map(command => command.command);
		expect(names).toEqual([
			"new",
			"sessions",
			"resume",
			"status",
			"steer",
			"stop",
			"rename",
			"model",
			"thinking",
			"compact",
			"close",
			"help",
		]);
		for (const command of BOT_COMMANDS) {
			expect(command.description.length).toBeGreaterThan(0);
		}
		expect(TOPIC_NAME_LIMIT).toBe(128);
		expect(AUTO_SESSION_NAME).toBe("session");
	});

	it("lists the in-topic commands in the topic help and the workspace ones outside", () => {
		for (const command of ["steer", "stop", "status", "rename", "model", "thinking", "compact", "close", "help"]) {
			expect(TOPIC_HELP).toContain(`\`/${command}\``);
		}
		for (const command of ["new", "resume", "sessions", "help"]) {
			expect(WORKSPACE_HELP).toContain(`\`/${command}\``);
			expect(ADOPT_HELP).toContain(`\`/${command}\``);
		}
		expect(TOPIC_HELP).toContain("follow-up");
		expect(WORKSPACE_HELP).toContain("outside a session topic");
	});
});
