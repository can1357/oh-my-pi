import { afterEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import type { ToolSession } from "../../src/tools";

afterEach(async () => {
	await disposeAllVmContexts();
});

function toolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: () => undefined,
	};
}

describe("a JavaScript cell whose child reads the inherited stdin", () => {
	// The evaluator's stdin must never be the host's message channel: a child inheriting it would
	// block on it and swallow the messages meant for the evaluator, hanging the cell and the session.
	it("sees end of input, and the session keeps serving cells", async () => {
		using dir = TempDir.createSync("@omp-js-child-stdin-");
		const options = {
			session: toolSession(dir.path()),
			sessionId: `js-child-stdin:${crypto.randomUUID()}`,
			timeoutMs: 20_000,
		};
		const reader = "const text = await Bun.stdin.text(); console.log(`read ${text.length} bytes`);";
		const first = await executeJs(
			[
				`const child = Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(reader)}], { stdin: "inherit" });`,
				"print(child.stdout.toString().trim());",
			].join("\n"),
			options,
		);
		expect(first.cancelled).toBe(false);
		expect(first.output.trim()).toBe("read 0 bytes");

		const second = await executeJs('print("still serving");', options);
		expect(second.output.trim()).toBe("still serving");
	}, 60_000);
});
