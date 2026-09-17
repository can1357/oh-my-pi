/**
 * Focus-safe e2e tests for eval `computer.decide()`.
 *
 * Uses gui-e2e-display.sh Tier-1 Xvfb by default (GTK never touches Hyprland).
 * Opt-in: PI_COMPUTER_E2E=1 bun test test/computer-decide-e2e.test.ts
 * Grim capture (Tier 2): PI_HYPRLAND_GRIM_E2E=1 GUI_E2E_TIER=hypr-headless
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { candidatesFromElements } from "../src/computer/decide";
import { runEvalComputerDecide } from "../src/computer/decide-bridge";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import {
	GuiE2eHarness,
	SHOULD_RUN_COMPUTER_E2E,
	SHOULD_RUN_HYPRLAND_GRIM_E2E,
} from "./helpers/hyprland-headless-harness";

function toolSession(overrides: Record<string, unknown> = {}): ToolSession {
	const settings = Settings.isolated({ "computer.jev": "off", ...overrides });
	return {
		settings,
		modelRegistry: { authStorage: { hasAuth: () => false } },
		getSessionId: () => "computer-decide-e2e",
	} as unknown as ToolSession;
}

describe.skipIf(!SHOULD_RUN_COMPUTER_E2E)("computer.decide() gui e2e", () => {
	const harnesses: GuiE2eHarness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.stop();
		}
	});

	it("maps GTK buttons on an isolated display and reranks Save", async () => {
		const harness = new GuiE2eHarness();
		harnesses.push(harness);
		harness.start();
		harness.launchGtkFixture("Save,Cancel");
		await harness.waitForGtkWindow();

		harness.assertClientOnHeadlessOutput();
		harness.assertIsolationHeld();

		const buttons = await harness.queryButtons();
		expect(buttons.map(b => b.title)).toEqual(["Save", "Cancel"]);

		const candidates = candidatesFromElements(buttons.map(b => ({ ref: b.ref, role: b.role, title: b.title })));
		const result = await runEvalComputerDecide(
			{ state: { goal: "click Save", candidates } },
			{ session: toolSession() },
		);

		expect(result.data?.action).toBe("click");
		expect(result.data?.target).toBe(buttons.find(b => b.title === "Save")?.ref);
		expect(result.data?.backend === "rules" || result.data?.backend === "rerank").toBe(true);
		expect(result.details.jev).toBe(false);
	}, 30_000);

	it("fail-opens when AX candidates do not match the goal (jev off)", async () => {
		const harness = new GuiE2eHarness();
		harnesses.push(harness);
		harness.start();
		harness.launchGtkFixture("Save,Cancel");
		await harness.waitForGtkWindow();

		const buttons = await harness.queryButtons();
		const candidates = candidatesFromElements(buttons.map(b => ({ ref: b.ref, role: b.role, title: b.title })));
		const result = await runEvalComputerDecide(
			{ state: { goal: "click Delete permanently", candidates } },
			{ session: toolSession() },
		);

		expect(result.data).toBeNull();
		harness.assertIsolationHeld();
	}, 30_000);

	it("returns null for ambiguous labels below confidence when jev is off", async () => {
		const harness = new GuiE2eHarness();
		harnesses.push(harness);
		harness.start();
		harness.launchGtkFixture("Submit form,Submit request,Submit now");
		await harness.waitForGtkWindow();

		const buttons = await harness.queryButtons();
		expect(buttons).toHaveLength(3);
		const candidates = candidatesFromElements(buttons.map(b => ({ ref: b.ref, role: b.role, title: b.title })));
		const result = await runEvalComputerDecide(
			{ state: { goal: "click Submit", candidates }, minConfidence: 0.95 },
			{ session: toolSession() },
		);

		expect(result.data).toBeNull();
		expect((result.details as { backend?: string }).backend).toBe("none");
		harness.assertIsolationHeld();
	}, 30_000);
});

describe.skipIf(!SHOULD_RUN_HYPRLAND_GRIM_E2E)("computer.decide() hyprland grim e2e", () => {
	const harnesses: GuiE2eHarness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.stop();
		}
	});

	it("captures the headless output with grim without changing user focus", async () => {
		const harness = new GuiE2eHarness(undefined, "hypr-headless");
		harnesses.push(harness);
		harness.start();
		harness.launchGtkFixture("Save,Cancel");
		await harness.waitForGtkWindow();

		harness.assertClientOnHeadlessOutput();

		const png = path.join(os.tmpdir(), `omp-computer-decide-e2e-${harness.runId}.png`);
		try {
			harness.captureHeadlessPng(png);
			const stat = fs.statSync(png);
			expect(stat.size).toBeGreaterThan(10_000);
		} finally {
			fs.rmSync(png, { force: true });
		}

		harness.assertIsolationHeld();
	});
});
