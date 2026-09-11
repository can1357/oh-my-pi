import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component, RenderScheduler } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

class ImmediateScheduler implements RenderScheduler {
	now(): number {
		return 0;
	}

	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel() {} };
	}

	scheduleRender(callback: () => void, _delayMs: number) {
		callback();
		return { cancel() {} };
	}
}

class SingleRow implements Component {
	constructor(private readonly line: string) {}

	invalidate(): void {}

	render(): readonly string[] {
		return [this.line];
	}
}

function rowOf(rows: readonly string[], needle: string): number {
	return rows.findIndex(row => row.includes(needle));
}

const STATUS_ROW = "NATIVE-STATUS-ROW";
const TRAILER_ROW = "TRAILER-WIDGET-ROW";

function startComposer(shape: "band" | "box") {
	const terminal = new VirtualTerminal(80, 24);
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: new ImmediateScheduler() },
		preferences: { ...COMPOSER_DEFAULTS, quiet: false, composerShape: shape },
		welcome: { version: "test", modelName: "test-model", providerName: "test-provider" },
	});
	composer.setRuntimeChildren([new SingleRow("TAIL-MARKER")]);
	composer.setStatusComponent(new SingleRow(STATUS_ROW));
	composer.setStatusTrailer([new SingleRow(TRAILER_ROW)]);
	composer.start({ playWelcomeIntro: false });
	const viewport = composer.renderFrame({ columns: 80, rows: 30 }).viewport.map(row => Bun.stripANSI(row));
	return { composer, viewport };
}

beforeAll(async () => {
	await initTheme();
});

describe("composer status trailer order (issue #11100)", () => {
	it("renders the belowStatusline trailer immediately after the native status row", () => {
		const { viewport } = startComposer("box");
		expect(rowOf(viewport, STATUS_ROW)).toBeGreaterThanOrEqual(0);
		expect(rowOf(viewport, TRAILER_ROW)).toBe(rowOf(viewport, STATUS_ROW) + 1);
	});

	it("keeps status-before-trailer order under the top-attached band shape", () => {
		// Order is a Composer roots invariant, independent of composer.shape:
		// with top-attached shapes the status chrome also docks onto the
		// editor top border, but the trailer still follows the status host.
		const { viewport } = startComposer("band");
		expect(rowOf(viewport, STATUS_ROW)).toBeGreaterThanOrEqual(0);
		expect(rowOf(viewport, TRAILER_ROW)).toBe(rowOf(viewport, STATUS_ROW) + 1);
	});

	it("renders no trailer row when no status trailer is mounted", () => {
		const terminal = new VirtualTerminal(80, 24);
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: new ImmediateScheduler() },
			preferences: { ...COMPOSER_DEFAULTS, quiet: false },
			welcome: { version: "test", modelName: "test-model", providerName: "test-provider" },
		});
		composer.setRuntimeChildren([new SingleRow("TAIL-MARKER")]);
		composer.setStatusComponent(new SingleRow(STATUS_ROW));
		composer.start({ playWelcomeIntro: false });
		const viewport = composer.renderFrame({ columns: 80, rows: 30 }).viewport.map(row => Bun.stripANSI(row));
		expect(rowOf(viewport, STATUS_ROW)).toBeGreaterThanOrEqual(0);
		expect(rowOf(viewport, TRAILER_ROW)).toBe(-1);
	});
});
