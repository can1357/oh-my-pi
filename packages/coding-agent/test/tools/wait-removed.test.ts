/**
 * The built-in `wait` tool is removed: the capability MCP server's wait (one
 * wait in every harness, design 2026-10-24) replaces it, so omp must stop
 * offering its own. Nothing may register, force-grant, or treat `wait` as a
 * read-only builtin anymore.
 */
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { READ_ONLY_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/task/read-only-policy";
import { BUILTIN_TOOLS, createTools } from "@oh-my-pi/pi-coding-agent/tools";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { beforeEach, describe, expect, test } from "bun:test";

function session(settings?: Settings): ToolSession {
	return {
		cwd: process.cwd(),
		settings: settings ?? Settings.isolated({}),
	} as unknown as ToolSession;
}

describe("built-in wait removal", () => {
	beforeEach(() => {
		Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	test("no builtin wait tool is registered or created", async () => {
		expect("wait" in BUILTIN_TOOLS).toBe(false);
		const defaultTools = await createTools(session());
		expect(defaultTools.some(tool => tool.name === "wait")).toBe(false);
		// Agents that can start background work used to be force-granted
		// `wait`; the capability wait arrives through MCP instead.
		const widened = await createTools(session(), ["read", "task", "bash"]);
		expect(widened.some(tool => tool.name === "wait")).toBe(false);
	});

	test("wait is no longer a read-only tool name", () => {
		expect(READ_ONLY_TOOL_NAMES.has("wait")).toBe(false);
		// A read-only agent stays read-only without it.
		expect([...READ_ONLY_TOOL_NAMES].length).toBeGreaterThan(0);
	});
});
