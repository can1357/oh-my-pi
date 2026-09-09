/**
 * Regression guard for PR review feedback on #2190.
 *
 * Subagents inherit the parent's extension source *paths* (a cheap FS scan
 * the parent already paid for), but each session MUST rebuild its own
 * `Extension` instances so factories see the subagent's `ExtensionAPI`
 * (cwd, eventBus, runtime). Forwarding the parent's loaded Extension
 * instances would have tools/handlers/commands close over the parent's
 * `cwd` and event bus — wrong for isolated tasks.
 *
 * Pins down `loadExtensions()` so the SDK can rely on it returning fresh
 * Extension instances per call.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("loadExtensions per-session binding (#2190 review fix)", () => {
	let tmp: string;
	let extPath: string;

	beforeAll(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ext-binding-"));
		extPath = path.join(tmp, "record-cwd.ts");
		// Factory tags the extension with the cwd + events it was bound to so
		// the test can inspect what closures captured.
		await fs.writeFile(
			extPath,
			[
				"export default function (api) {",
				"  api.registerTool({",
				"    name: 'tag',",
				"    description: 'binding probe',",
				"    parameters: api.typebox.Type.Object({}),",
				"    async execute() { return { content: [{ type: 'text', text: '' }] }; },",
				"  });",
				"  Object.defineProperty(globalThis, '__lastExtBinding', {",
				"    value: { cwd: api.exec.toString().includes('cwd') ? api : api, events: api.events },",
				"    writable: true,",
				"    configurable: true,",
				"  });",
				"  globalThis.__bindings = globalThis.__bindings || [];",
				"  globalThis.__bindings.push({ events: api.events });",
				"}",
			].join("\n"),
		);
	});

	afterAll(async () => {
		await removeWithRetries(tmp);
		delete (globalThis as { __bindings?: unknown }).__bindings;
		delete (globalThis as { __lastExtBinding?: unknown }).__lastExtBinding;
	});

	it("creates a distinct Extension and ExtensionAPI per call (fresh eventBus + runtime)", async () => {
		(globalThis as { __bindings?: { events: EventBus }[] }).__bindings = [];

		const parentEventBus = new EventBus();
		const subagentEventBus = new EventBus();
		expect(parentEventBus).not.toBe(subagentEventBus);

		const parent = await loadExtensions([extPath], "/tmp/parent-cwd", parentEventBus);
		const subagent = await loadExtensions([extPath], "/tmp/subagent-cwd", subagentEventBus);

		expect(parent.errors).toEqual([]);
		expect(subagent.errors).toEqual([]);
		expect(parent.extensions).toHaveLength(1);
		expect(subagent.extensions).toHaveLength(1);

		// Distinct Extension instances — the subagent must never share with parent.
		expect(subagent.extensions[0]).not.toBe(parent.extensions[0]);
		// Distinct ExtensionRuntime instances — flagValues and pendingProviderRegistrations
		// MUST NOT be shared, or per-session flags/registrations bleed across.
		expect(subagent.runtime).not.toBe(parent.runtime);

		// Each factory saw the eventBus passed to its own loadExtensions call.
		const bindings = (globalThis as { __bindings?: { events: EventBus }[] }).__bindings ?? [];
		expect(bindings).toHaveLength(2);
		expect(bindings[0]?.events).toBe(parentEventBus);
		expect(bindings[1]?.events).toBe(subagentEventBus);
	});
});
