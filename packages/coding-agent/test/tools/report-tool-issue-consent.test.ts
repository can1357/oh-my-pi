/**
 * Consent gate around `report_tool_issue`. Asserts:
 *
 * 1. With no handler registered, consent defaults to `false` and the tool's
 *    `execute` returns the canonical "Noted, thanks!" without touching the DB.
 * 2. The handler fires exactly once per process even across concurrent calls
 *    (single-flight), and the decision is persisted to both the local and
 *    registered persistent `Settings` instances.
 * 3. A persisted `"granted"` short-circuits the handler.
 * 4. A persisted `"denied"` short-circuits the handler AND no-ops the tool.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	__resetAutoQaConsentForTests,
	resolveAutoQaConsent,
	setAutoQaConsentHandler,
} from "@oh-my-pi/pi-coding-agent/tools/report-tool-issue";

afterEach(() => {
	__resetAutoQaConsentForTests();
});

describe("resolveAutoQaConsent", () => {
	it("defaults to false when no handler is registered", async () => {
		const settings = Settings.isolated();
		expect(await resolveAutoQaConsent(settings)).toBe(false);
		// Default-deny must NOT persist anything — the next process invocation
		// gets to re-prompt instead of being silently stuck on "no".
		expect(settings.get("dev.autoqaConsent")).toBe("unset");
	});

	it("returns persisted `granted` without invoking the handler", async () => {
		const settings = Settings.isolated({ "dev.autoqaConsent": "granted" });
		let calls = 0;
		setAutoQaConsentHandler(async () => {
			calls += 1;
			return false;
		});
		expect(await resolveAutoQaConsent(settings)).toBe(true);
		expect(calls).toBe(0);
	});

	it("returns persisted `denied` without invoking the handler", async () => {
		const settings = Settings.isolated({ "dev.autoqaConsent": "denied" });
		let calls = 0;
		setAutoQaConsentHandler(async () => {
			calls += 1;
			return true;
		});
		expect(await resolveAutoQaConsent(settings)).toBe(false);
		expect(calls).toBe(0);
	});

	it("invokes the handler exactly once for concurrent callers and persists the answer", async () => {
		const local = Settings.isolated();
		const persistent = Settings.isolated();
		let calls = 0;
		let release: (v: boolean) => void = () => undefined;
		setAutoQaConsentHandler(async () => {
			calls += 1;
			return new Promise<boolean>(resolve => {
				release = resolve;
			});
		}, persistent);

		const a = resolveAutoQaConsent(local);
		const b = resolveAutoQaConsent(local);
		const c = resolveAutoQaConsent(local);
		// Wait a tick to ensure all three reached the in-flight branch.
		await Promise.resolve();
		release(true);

		expect(await a).toBe(true);
		expect(await b).toBe(true);
		expect(await c).toBe(true);
		expect(calls).toBe(1);
		expect(local.get("dev.autoqaConsent")).toBe("granted");
		expect(persistent.get("dev.autoqaConsent")).toBe("granted");
	});

	it("persists a `denied` decision so the next call short-circuits", async () => {
		const local = Settings.isolated();
		const persistent = Settings.isolated();
		let calls = 0;
		setAutoQaConsentHandler(async () => {
			calls += 1;
			return false;
		}, persistent);

		expect(await resolveAutoQaConsent(local)).toBe(false);
		expect(await resolveAutoQaConsent(local)).toBe(false);
		expect(calls).toBe(1);
		expect(local.get("dev.autoqaConsent")).toBe("denied");
		expect(persistent.get("dev.autoqaConsent")).toBe("denied");
	});

	it("does not cache or persist when the handler throws (allows re-prompt)", async () => {
		const settings = Settings.isolated();
		let calls = 0;
		setAutoQaConsentHandler(async () => {
			calls += 1;
			throw new Error("dialog crashed");
		});

		expect(await resolveAutoQaConsent(settings)).toBe(false);
		// A second call must invoke the handler again — the throw path is
		// transient, not a stuck "no".
		expect(await resolveAutoQaConsent(settings)).toBe(false);
		expect(calls).toBe(2);
		expect(settings.get("dev.autoqaConsent")).toBe("unset");
	});

	it("does not cache or persist when the handler returns null (dismiss/ESC)", async () => {
		const local = Settings.isolated();
		const persistent = Settings.isolated();
		let calls = 0;
		setAutoQaConsentHandler(async () => {
			calls += 1;
			// Mirrors the `showHookSelector` ESC path (returns `undefined`,
			// which `#promptAutoQaConsent` maps to `null`).
			return null;
		}, persistent);

		expect(await resolveAutoQaConsent(local)).toBe(false);
		// Second call must re-prompt — a stray ESC isn't a permanent opt-out.
		expect(await resolveAutoQaConsent(local)).toBe(false);
		expect(calls).toBe(2);
		expect(local.get("dev.autoqaConsent")).toBe("unset");
		expect(persistent.get("dev.autoqaConsent")).toBe("unset");
	});

	it("falls back to the registered persistent settings when the local snapshot is unset", async () => {
		// Mirrors the subagent flow: subagent passes its in-memory snapshot
		// (which lost the consent edit made on the parent), but the host's
		// persistent Settings carries the real decision.
		const subagentLocal = Settings.isolated();
		const hostPersistent = Settings.isolated({ "dev.autoqaConsent": "granted" });
		let calls = 0;
		setAutoQaConsentHandler(async () => {
			calls += 1;
			return false;
		}, hostPersistent);

		expect(await resolveAutoQaConsent(subagentLocal)).toBe(true);
		expect(calls).toBe(0);
	});
});
