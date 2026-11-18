import { describe, expect, it } from "bun:test";
import { SHELL_PROCESS_SELECTOR } from "@oh-my-pi/pi-utils";
import { formatCommand } from "../src/apps/ps-data";
import type { DaemonSpec } from "../src/tools/daemon";

const spec = (application: string, args: string[]): DaemonSpec => ({
	name: "web",
	application,
	args,
	env: {},
	cwd: "/work",
	pty: true,
	restart: "no",
	persist: false,
	detached: false,
});

describe("formatCommand", () => {
	it("shows a service by the command its shell process runs, not by the worker's command line", () => {
		const service = spec("/usr/local/bin/omp", [
			SHELL_PROCESS_SELECTOR,
			"--paths",
			'{"local":"/sessions/1/local"}',
			"--",
			"npm run dev -- --port 3000",
		]);

		expect(formatCommand(service)).toBe("npm run dev -- --port 3000");
		expect(formatCommand(spec("/usr/bin/chrome", ["--headless", "--remote-debugging-port=0"]))).toBe(
			"/usr/bin/chrome --headless --remote-debugging-port=0",
		);
		expect(formatCommand(undefined)).toBeUndefined();
	});
});
