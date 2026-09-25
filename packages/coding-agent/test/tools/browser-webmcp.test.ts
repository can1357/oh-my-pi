import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type {
	WebMcpEventsResult,
	WebMcpInvokeResult,
	WebMcpListResult,
} from "@oh-my-pi/pi-coding-agent/tools/browser/webmcp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function createBrowserHost() {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) => prelude.invoke(parameters, { session, toolCallId: "browser-webmcp-test" });
}

function call(name: string, method: string, args: unknown[] = []) {
	return name.length > 0
		? { action: "call", name, chain: [{ method, args }] }
		: { action: "call", chain: [{ method, args }] };
}

function valueFrom<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object" || !("value" in details)) {
		throw new Error("Browser call returned no value");
	}
	return details.value as T;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser WebMCP helpers", () => {
	it("discovers, invokes, bounds trust, and reports page-side registrations", async () => {
		const invoke = createBrowserHost();
		const html = `<!doctype html>
<html><head><title>loading</title></head><body><script>
(async () => {
  window.webmcpSurface = navigator.modelContext?.constructor?.name === "ModelContext" ? "native" : "hook-polyfill";
  await navigator.modelContext.registerTool({
    name: "sum_values",
    description: "Adds two values from the page.",
    inputSchema: {
      type: "object",
      properties: { left: { type: "number" }, right: { type: "number" } },
      required: ["left", "right"]
    },
    annotations: { readOnlyHint: true },
    execute({ left, right }) { return { total: left + right }; }
  });
  await navigator.modelContext.registerTool({
    name: "large_result",
    description: "Returns an oversized page result.",
    inputSchema: { type: "object" },
    execute() { return "x".repeat(70 * 1024); }
  });
  await navigator.modelContext.registerTool({
    name: "throw_page_error",
    description: "Throws page-provided text.",
    inputSchema: { type: "object" },
    execute() { throw new Error("PAGE_SENTINEL_FAILURE"); }
  });
  document.title = "registered";
})();
</script></body></html>`;
		const url = `data:text/html,${encodeURIComponent(html)}`;
		await invoke({ action: "open", name: "webmcp", url });

		const surface = valueFrom<string>(await invoke(call("webmcp", "evaluate", ["window.webmcpSurface"])));
		// Chrome 150 with WebMCP flags does not expose its secure-context API to data: pages; the preload polyfill runs.
		expect(surface).toBe("hook-polyfill");

		const summary = valueFrom<WebMcpListResult>(await invoke(call("webmcp", "webmcpList")));
		expect(summary).toMatchObject({
			status: "ready",
			truncated: false,
			untrusted: true,
		});
		expect(summary.tools.map(tool => tool.name)).toEqual(["large_result", "sum_values", "throw_page_error"]);
		expect(summary.tools.every(tool => tool.inputSchema === undefined)).toBe(true);

		const detail = valueFrom<WebMcpListResult>(await invoke(call("webmcp", "webmcpList", [{ name: "sum_values" }])));
		expect(detail.tools).toEqual([
			expect.objectContaining({
				name: "sum_values",
				inputSchema: expect.objectContaining({ type: "object", required: ["left", "right"] }),
				annotations: { readOnlyHint: true },
				untrusted: true,
			}),
		]);

		const result = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp", "webmcpInvoke", ["sum_values", { left: 20, right: 22 }])),
		);
		expect(result).toEqual({ ok: true, result: { total: 42 }, untrusted: true });

		const largeResult = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp", "webmcpInvoke", ["large_result", {}])),
		);
		expect(largeResult).toMatchObject({ ok: true, truncated: true, untrusted: true });
		expect(Buffer.byteLength(JSON.stringify(largeResult), "utf8")).toBeLessThanOrEqual(64 * 1024);

		const failure = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp", "webmcpInvoke", ["throw_page_error", {}])),
		);
		expect(failure).toMatchObject({ ok: false, untrusted: true });
		if (failure.ok) throw new Error("Expected page tool failure");
		expect(failure.error).toContain("BEGIN UNTRUSTED WEBMCP CONTENT");
		expect(failure.error).toContain("PAGE_SENTINEL_FAILURE");
		expect(failure.error).toContain("END UNTRUSTED WEBMCP CONTENT");

		const events = valueFrom<WebMcpEventsResult>(await invoke(call("webmcp", "webmcpEvents")));
		expect(events).toMatchObject({ untrusted: true, truncated: false });
		expect(events.events.map(event => [event.type, event.name])).toEqual([
			["registered", "large_result"],
			["registered", "sum_values"],
			["registered", "throw_page_error"],
		]);
		await invoke({ action: "close", name: "webmcp", kill: true });
	}, 30_000);
});
