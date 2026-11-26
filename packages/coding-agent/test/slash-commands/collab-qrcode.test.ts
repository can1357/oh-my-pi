import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CollabController } from "@oh-my-pi/pi-coding-agent/collab/controller";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import "../../src/ui/styles/figures";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/** QR modules: black on white. */
const QR_MODULES = /\x1b\[47m/;

/** The terminal rows (with escapes) of the block `/collab` presented, at `columns`. */
function presentedRows(present: ReturnType<typeof vi.fn>, columns: number): string[] {
	const factory = present.mock.calls[0]?.[0] as (() => JSXNode) | undefined;
	if (!factory) throw new Error("/collab presented nothing");
	const term = createTestTerminal(() => ({ main: factory() }), {
		columns,
		rows: 80,
		capabilities: { hyperlinks: true },
	});
	try {
		return [...term.rows()];
	} finally {
		term.dispose();
	}
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	resetSettingsForTest();
});

function fakeHost(options?: {
	webLink?: string;
	webViewLink?: string;
	access?: "view" | "control";
}): NonNullable<InteractiveModeContext["collabHost"]> {
	return {
		link: "relay.example.com/r/full-control",
		viewLink: "relay.example.com/r/read-only",
		webLink: options?.webLink ?? "https://my.omp.sh/#full-control",
		webViewLink: options?.webViewLink ?? "https://my.omp.sh/#read-only",
		participants: [{ name: "host", role: "host" }],
		access: options?.access ?? "control",
	} as unknown as NonNullable<InteractiveModeContext["collabHost"]>;
}

async function createRuntimeHarness(options?: { collabHost?: NonNullable<InteractiveModeContext["collabHost"]> }) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const present = vi.fn();
	const ctx = {
		composer: { setText },
		showStatus,
		showError,
		present,
		settings: Settings.isolated({ "collab.relayUrl": "wss://relay.example.com" }),
		session: { registerSessionChangeCallback: () => () => {} },
		sessionManager: { getSessionId: () => "sess-qrcode", onPersistenceNotice: () => () => {} },
		statusLine: { setCollabStatus: () => {}, invalidate: () => {} },
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	// `/collab` starts rooms through the controller, which builds a real CollabHost.
	ctx.collabController = new CollabController(ctx);
	if (options?.collabHost) {
		mockStartedHostLinks(options.collabHost);
		await ctx.collabController.start({ access: options.collabHost.access });
	}
	return {
		ctx,
		setText,
		showStatus,
		showError,
		present,
		runtime: { ctx } as BuiltinSlashCommandRuntime,
	};
}

function mockStartedHostLinks(
	host = fakeHost({ webLink: "https://my.omp.sh/#started-full", webViewLink: "https://my.omp.sh/#started-view" }),
) {
	return vi.spyOn(CollabHost.prototype, "start").mockImplementation(function (this: CollabHost): Promise<void> {
		Object.defineProperties(this, {
			link: { value: host.link, configurable: true },
			viewLink: { value: host.viewLink, configurable: true },
			webLink: { value: host.webLink, configurable: true },
			webViewLink: { value: host.webViewLink, configurable: true },
			participants: { value: host.participants, configurable: true },
		});
		return Promise.resolve();
	});
}

describe("/collab slash command QR code rendering", () => {
	it("status preserves a view-only room's published access", async () => {
		const harness = await createRuntimeHarness({ collabHost: fakeHost({ access: "view" }) });
		await executeBuiltinSlashCommand("/collab status", harness.runtime);
		const text = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(text).toContain("my.omp.sh/#read-only");
		expect(text).not.toContain("my.omp.sh/#full-control");
	});

	it("starts hosting and prints a one-shot full-control QR", async () => {
		mockStartedHostLinks();
		const harness = await createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);

		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#started-full");
		expect(presentedRows(harness.present, 120).join("\n")).toMatch(QR_MODULES);
	});

	it("starts hosting and prints a one-shot read-only QR", async () => {
		mockStartedHostLinks();
		const harness = await createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/collab view", harness.runtime);

		expect(handled).toBe(true);

		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#started-view");
		expect(statusText).not.toContain("my.omp.sh/#started-full");
		const fallback = presentedRows(harness.present, 10).join("\n");
		expect(fallback).toContain("https://my.omp.sh/#started-view");
		expect(fallback).not.toContain("https://my.omp.sh/#started-full");
	});

	it("prints the active full-control browser QR when hosting", async () => {
		const harness = await createRuntimeHarness({ collabHost: fakeHost() });

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#full-control");
		expect(presentedRows(harness.present, 120).join("\n")).toMatch(QR_MODULES);
	});

	it("replaces a view-only room with a control room when /collab asks for control", async () => {
		const harness = await createRuntimeHarness({ collabHost: fakeHost({ access: "view" }) });
		const previous = harness.ctx.collabController.host;
		mockStartedHostLinks();

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		expect(previous?.stopped).toBe(true);

		expect(harness.ctx.collabHost?.access).toBe("control");
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;

		expect(statusText).toContain("my.omp.sh/#started-full");
	});

	it("re-prints the view link of a view-only room for /collab view without restarting", async () => {
		const harness = await createRuntimeHarness({ collabHost: fakeHost({ access: "view" }) });
		const previous = harness.ctx.collabController.host;
		mockStartedHostLinks();

		await executeBuiltinSlashCommand("/collab view", harness.runtime);
		expect(previous?.stopped).toBe(false);

		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#read-only");
	});

	it("prints a one-shot read-only browser QR when hosting", async () => {
		const webLink = "https://my.omp.sh/#full-control";
		const webViewLink = "https://my.omp.sh/#read-only";
		const harness = await createRuntimeHarness({ collabHost: fakeHost({ webLink, webViewLink }) });

		const handled = await executeBuiltinSlashCommand("/collab view", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain(webViewLink);
		expect(statusText).not.toContain(webLink);
		const clipped = presentedRows(harness.present, 10);
		expect(clipped).toHaveLength(1);
		expect(visibleWidth(clipped[0]!)).toBeLessThanOrEqual(10);
		expect(clipped[0]).toContain(webViewLink);
		expect(clipped[0]).not.toContain(webLink);
	});

	it("keeps the browser URL on the first status row so transcript clipping cannot hide it", async () => {
		const webLink = `https://my.omp.sh/#${"long-collab-token".repeat(8)}`;
		const harness = await createRuntimeHarness({ collabHost: fakeHost({ webLink }) });

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText.split("\n")[0]).toContain(webLink);
	});
});
