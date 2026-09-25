import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function createHost() {
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
	return (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-snapshot-plus-${crypto.randomUUID()}` });
}

function valueFrom<T>(result: { details?: unknown }): T {
	if (!result.details || typeof result.details !== "object" || !("value" in result.details)) {
		throw new Error("Browser result did not include a value");
	}
	return result.details.value as T;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser snapshot and readable parity", () => {
	test("filters snapshots, scopes observations, diffs revisions, and extracts selected sections", async () => {
		const invoke = createHost();
		const name = `snapshot-plus-${crypto.randomUUID()}`;
		const filler = Array.from({ length: 24 }, (_, index) => `<p>Reference line ${index}</p>`).join("");
		const html = `<!doctype html><html><head><title>Snapshot fixture</title></head><body>
			<button id="outside">Outside control</button>
			<main id="scope">
				<h1>Product Guide</h1><p id="intro">Static introduction.</p>
				<section><h2>Install macOS</h2><p>Use brew.</p><button id="save">Save settings</button></section>
				<section><h2>Install Linux</h2><p>Use apt.</p></section>
				<a href="/help">Help center</a>${filler}
			</main>
		</body></html>`;
		await invoke({ action: "open", name, url: `data:text/html,${encodeURIComponent(html)}` });
		try {
			const interactive = valueFrom<string>(
				await invoke({
					action: "run",
					name,
					code: 'return await tab.ariaSnapshot("#scope", { interactive: true, urls: true });',
				}),
			);
			expect(interactive).toContain("Save settings");
			expect(interactive).toContain("Help center");
			expect(interactive).toContain("[href=");
			expect(interactive).not.toContain("Static introduction");

			const observed = valueFrom<{ elements: Array<{ name?: string }> }>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "observe", args: [{ selector: "#scope", includeAll: true, compact: true }] }],
				}),
			);
			expect(observed.elements.some(element => element.name === "Save settings")).toBeTrue();
			expect(observed.elements.some(element => element.name === "Outside control")).toBeFalse();

			const first = valueFrom<{ status: string; revision: number; snapshot?: string }>(
				await invoke({ action: "run", name, code: "return await tab.ariaSnapshot(undefined, { diff: true });" }),
			);
			expect(first).toMatchObject({ status: "full", revision: 1 });
			expect(first.snapshot).toContain("Static introduction");
			const unchanged = valueFrom<{ status: string; revision: number }>(
				await invoke({ action: "run", name, code: "return await tab.ariaSnapshot(undefined, { diff: true });" }),
			);
			expect(unchanged).toEqual({ status: "unchanged", revision: 1 });

			await invoke({
				action: "call",
				name,
				chain: [
					{ method: "evaluate", args: ['document.querySelector("#intro").textContent = "Changed introduction."'] },
				],
			});
			const changed = valueFrom<{ status: string; revision: number; baseRevision?: number; delta?: string }>(
				await invoke({ action: "run", name, code: "return await tab.ariaSnapshot(undefined, { diff: true });" }),
			);
			expect(changed).toMatchObject({ status: "delta", revision: 2, baseRevision: 1 });
			expect(changed.delta).toContain("-    - paragraph [ref=e5]: Static introduction.");
			expect(changed.delta).toContain("+    - paragraph [ref=e5]: Changed introduction.");

			await invoke({
				action: "call",
				name,
				chain: [{ method: "goto", args: [`data:text/html,${encodeURIComponent("<h1>Another page</h1>")}`] }],
			});
			const navigated = valueFrom<{ status: string; revision: number; snapshot?: string }>(
				await invoke({ action: "run", name, code: "return await tab.ariaSnapshot(undefined, { diff: true });" }),
			);
			expect(navigated).toMatchObject({ status: "full", revision: 3 });

			await invoke({
				action: "call",
				name,
				chain: [{ method: "goto", args: [`data:text/html,${encodeURIComponent(html)}`] }],
			});
			const outline = valueFrom<string>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "extract", args: ["markdown", { selector: "#scope", outline: true }] }],
				}),
			);
			expect(outline).toBe("# Product Guide\n## Install macOS\n## Install Linux");
			const filtered = valueFrom<string>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "extract", args: ["markdown", { selector: "#scope", filter: "macOS" }] }],
				}),
			);
			expect(filtered).toContain("Use brew.");
			expect(filtered).not.toContain("Use apt.");
		} finally {
			await invoke({ action: "close", name, kill: true }).catch(() => undefined);
		}
	}, 60_000);
});
