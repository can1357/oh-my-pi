import { afterEach, describe, expect, it } from "bun:test";
import { holdSharedLsp, isSharedLspEnabled, onSharedLspChange } from "../../src/lsp/client";
import { lspThreadService } from "../../src/thread/services/lsp";
import type { LspModeProbe } from "../fixtures/lsp-mode-worker";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

const FIXTURE = new URL("../fixtures/lsp-mode-worker.ts", import.meta.url);

describe("lsp thread service", () => {
	const releases: Array<() => void> = [];
	let fixture: ServiceWorker<LspModeProbe> | undefined;

	afterEach(async () => {
		await fixture?.stop();
		fixture = undefined;
		for (const release of releases.splice(0).reverse()) release();
	});

	function hold(enabled: boolean): { set(enabled: boolean): void } {
		const held = holdSharedLsp(enabled);
		releases.push(held.release);
		return held;
	}

	it("starts the worker in main's shared-LSP mode and follows every change", async () => {
		const setting = hold(true);
		fixture = await startServiceWorker<LspModeProbe>(FIXTURE, [lspThreadService]);
		expect(await fixture.probe.mode()).toBe(true);

		setting.set(false);
		expect(await fixture.probe.mode()).toBe(false);

		const newer = holdSharedLsp(true);
		expect(await fixture.probe.mode()).toBe(true);
		newer.release();
		expect(await fixture.probe.mode()).toBe(false);
		expect(isSharedLspEnabled()).toBe(false);
	});

	it("follows main from off when no session holds the mode", async () => {
		fixture = await startServiceWorker<LspModeProbe>(FIXTURE, [lspThreadService]);
		expect(await fixture.probe.mode()).toBe(false);
		hold(true);
		expect(await fixture.probe.mode()).toBe(true);
	});

	it("notifies change listeners only when the effective mode flips", () => {
		const seen: boolean[] = [];
		const off = onSharedLspChange(enabled => seen.push(enabled));
		try {
			const outer = hold(false);
			const inner = holdSharedLsp(true);
			outer.set(true); // shadowed by the newer hold
			inner.set(true); // unchanged
			inner.release(); // outer is now true: unchanged
			outer.set(false);
			expect(seen).toEqual([true, false]);
		} finally {
			off();
		}
	});
});
