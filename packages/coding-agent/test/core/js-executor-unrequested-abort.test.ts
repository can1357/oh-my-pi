/**
 * Contract: a JavaScript cell reports as cancelled only when a cancellation
 * was requested (the caller's signal or the cell timeout). An error that
 * merely carries a cancellation-like name, thrown by the cell's own code, is
 * a failure: exit code 1, with its text in the output.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

// A JS cell cold-starts a Bun worker; give it room above the worker-init floor.
setDefaultTimeout(20_000);

describe("executeJs reports a failure nobody cancelled as a failure", () => {
	let tempDir: TempDir;
	let sessionFile: string;

	beforeAll(() => {
		tempDir = TempDir.createSync("@js-unrequested-abort-");
		sessionFile = path.join(tempDir.path(), "session.jsonl");
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		tempDir.removeSync();
	});

	const session = (): ToolSession =>
		({
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionFile,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		}) as ToolSession;

	it("a TimeoutError the cell's own code throws is a failure with its text", async () => {
		const result = await executeJs('throw new DOMException("upstream request timed out", "TimeoutError");', {
			sessionId: `js-unrequested-timeout:${tempDir.path()}`,
			session: session(),
			sessionFile,
		});
		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("upstream request timed out");
	});

	it("a cell the caller cancels still reports as cancelled", async () => {
		const controller = new AbortController();
		const pending = executeJs("await new Promise(() => {});", {
			sessionId: `js-caller-cancel:${tempDir.path()}`,
			session: session(),
			sessionFile,
			signal: controller.signal,
		});
		await Bun.sleep(200);
		controller.abort();
		const result = await pending;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
	});
});
