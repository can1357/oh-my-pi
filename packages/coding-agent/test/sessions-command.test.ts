import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as os from "node:os";
import Sessions from "@oh-my-pi/pi-coding-agent/commands/sessions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionPins from "@oh-my-pi/pi-coding-agent/session/session-pins";

const config = { bin: "omp", version: "0.0.0-test", commands: new Map() };

function command(argv: string[]): Sessions {
	return new Sessions(argv, config);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sessions command flags", () => {
	it("rejects an empty cwd before selecting an action", async () => {
		await expect(command(["roots", "--cwd", ""]).run()).rejects.toThrow("--cwd must not be empty");
	});

	it("rejects --all combined with an explicitly provided cwd", async () => {
		await expect(command(["list", "--all", "--cwd", "/project"]).run()).rejects.toThrow(
			"--all and --cwd are mutually exclusive",
		);
	});

	it("expands a tilde cwd before listing sessions", async () => {
		const output: string[] = [];
		const list = spyOn(SessionManager, "listReadOnly").mockResolvedValue([]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());
		spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(String(chunk));
			return true;
		});

		await command(["list", "--cwd", "~/projects/app", "--json"]).run();

		expect(list).toHaveBeenCalledWith(`${os.homedir()}/projects/app`);
		expect(output).toEqual(["[]\n"]);
	});
});
