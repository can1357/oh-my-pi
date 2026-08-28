import { afterEach, describe, expect, test, vi } from "bun:test";
import * as core from "@tauri-apps/api/core";
import type { RpcBridge } from "../src/rpc/bridge";
import { registerBridge, sessionProcess } from "../src/shell/bridges";

/**
 * The registry answers for MOUNTED views only, and leaving the session route
 * unmounts every one of them while the Rust pool keeps the sidecars. So a tab
 * with no bridge is not a tab with no process — reading it as one is what sent a
 * rename from Settings into a throwaway child and put two agents on one jsonl.
 */
const POOL = { live: 1, maxLive: 3, prewarmReady: false, tabs: ["tab-1"] };

/** `isTauri()` reads `window`, and `bun test` has none. */
function enterTauri(): void {
	(globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const undo of cleanups.splice(0)) undo();
	delete (globalThis as { window?: unknown }).window;
	vi.restoreAllMocks();
});

function mountView(tabId: string): RpcBridge {
	const bridge = {} as unknown as RpcBridge;
	cleanups.push(registerBridge(tabId, bridge));
	return bridge;
}

describe("sessionProcess", () => {
	test("a live tab whose view is mounted answers with that view's bridge", async () => {
		enterTauri();
		vi.spyOn(core, "invoke").mockResolvedValue(POOL);
		const bridge = mountView("tab-1");

		expect(await sessionProcess("tab-1")).toEqual({ kind: "mounted", bridge });
	});

	test("a live tab with no mounted view is detached, never free", async () => {
		enterTauri();
		vi.spyOn(core, "invoke").mockResolvedValue(POOL);

		// No `registerBridge`: you are on Settings, so no session view is mounted
		// and the pool still owns the sidecar. Answering `none` here is the defect.
		expect(await sessionProcess("tab-1")).toEqual({ kind: "detached" });
	});

	test("a tab the pool does not list is free for a throwaway", async () => {
		enterTauri();
		vi.spyOn(core, "invoke").mockResolvedValue({ ...POOL, live: 0, tabs: [] });
		mountView("tab-1");

		expect(await sessionProcess("tab-1")).toEqual({ kind: "none" });
	});

	test("a pool that cannot answer refuses rather than guessing", async () => {
		enterTauri();
		vi.spyOn(core, "invoke").mockRejectedValue(new Error("sessions mutex poisoned"));

		expect(await sessionProcess("tab-1")).toEqual({ kind: "detached" });
	});

	test("a session with no open tab never consults the pool", async () => {
		enterTauri();
		const invoke = vi.spyOn(core, "invoke").mockResolvedValue(POOL);

		expect(await sessionProcess(undefined)).toEqual({ kind: "none" });
		expect(invoke).not.toHaveBeenCalled();
	});
});
