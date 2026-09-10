// Issue #11475: a successful settings write leaves no record — only failure
// lines exist. Success must emit one debug-level log line with the path;
// failure paths must stay silent on success logging.
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

// Exception to no-real-timers: the debounced background save and the durable
// write run on the real platform clock and real filesystem — fake timers
// cannot advance fsync or file visibility. Poll for the real outcome instead.
async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await Bun.file(file).exists()) return;
		await Bun.sleep(50);
	}
	throw new Error(`timed out waiting for ${file}`);
}

async function waitForWarn(spy: { mock: { calls: unknown[][] } }, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (spy.mock.calls.length > 0) return;
		await Bun.sleep(50);
	}
	throw new Error("timed out waiting for warn call");
}

describe("settings persist logging", () => {
	let agentDir!: string;

	beforeEach(async () => {
		agentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-settings-save-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentStorage.close();
		await removeWithRetries(agentDir).catch(() => {});
	});

	test("a successful save emits one debug line with the config path", async () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		settings.set("fetch.enabled", false);
		await waitForFile(path.join(agentDir, "config.yml"));
		expect(debugSpy).toHaveBeenCalledWith(
			"Settings: saved",
			expect.objectContaining({ path: path.join(agentDir, "config.yml") }),
		);
	});

	test("a failed save emits no success line", async () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		// Fail the atomic write's temp-file creation deterministically: every
		// open under the agent dir throws, so the queued save cannot persist.
		const realOpen = fs.promises.open.bind(fs.promises);
		vi.spyOn(fs.promises, "open").mockImplementation(async (target, flags, mode) => {
			if (typeof target === "string" && target.startsWith(agentDir)) {
				throw Object.assign(new Error("injected write failure"), { code: "ENOSPC" });
			}
			return realOpen(target, flags, mode);
		});
		settings.set("fetch.enabled", false);
		await waitForWarn(warnSpy);
		expect(debugSpy).not.toHaveBeenCalledWith("Settings: saved", expect.anything());
	});
});
