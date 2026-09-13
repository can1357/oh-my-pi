import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CollabController } from "@oh-my-pi/pi-coding-agent/collab/controller";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CollabQrCodeComponent } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/collab-qrcode";
import { Text, visibleWidth } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
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
	const settingsGet = vi.fn((key: string) => {
		if (key === "collab.relayUrl") return "wss://relay.example.com";
		if (key === "collab.webUrl") return "";
		return "";
	});
	const ctx = {
		editor: { setText },
		showStatus,
		showError,
		present,
		settings: { get: settingsGet },
		session: { registerSessionChangeCallback: () => () => {} },
		sessionManager: { getSessionId: () => "sess-qrcode" },
		statusLine: { setCollabStatus: () => {}, invalidate: () => {} },
		ui: { requestRender: () => {} },
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
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];

		const component = presented[1] as CollabQrCodeComponent;

		expect(component.render(120).join("\n")).toMatch(/\x1b\[(?:47|40)m/);
	});

	it("starts hosting and prints a one-shot read-only QR", async () => {
		mockStartedHostLinks();
		const harness = await createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/collab view", harness.runtime);

		expect(handled).toBe(true);

		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#started-view");
		expect(statusText).not.toContain("my.omp.sh/#started-full");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];

		const component = presented[1] as CollabQrCodeComponent;
		const fallback = component.render(10).join("\n");
		expect(fallback).toContain("https://my.omp.sh/#started-view");
		expect(fallback).not.toContain("https://my.omp.sh/#started-full");
	});

	it("prints the active full-control browser QR when hosting", async () => {
		const harness = await createRuntimeHarness({ collabHost: fakeHost() });

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("my.omp.sh/#full-control");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];

		const component = presented[1] as CollabQrCodeComponent;
		expect(component.render(120).join("\n")).toMatch(/\x1b\[(?:47|40)m/);
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
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];

		const component = presented[1] as CollabQrCodeComponent;

		const clipped = component.render(10).join("\n");
		expect(visibleWidth(clipped)).toBeLessThanOrEqual(10);
		expect(clipped).toContain(webViewLink);
	});

	it("keeps the browser URL on the first status row so transcript clipping cannot hide it", async () => {
		const webLink = `https://my.omp.sh/#${"long-collab-token".repeat(8)}`;
		const harness = await createRuntimeHarness({ collabHost: fakeHost({ webLink }) });

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		const firstRow = new Text(statusText, 1, 0).render(80)[0] ?? "";

		expect(firstRow).toContain(webLink);
	});
});

describe("CollabQrCodeComponent transcript height clipping", () => {
	it("renders the full half-block symbol when the viewport allocates enough rows", () => {
		const component = new CollabQrCodeComponent("https://my.omp.sh/#clip-test");
		const full = component.render(120);

		expect(full.join("\n")).toMatch(/\x1b\[(?:47|40)m/);

		component.setTranscriptAllocation(full.length);
		expect(component.render(120)).toEqual(full);
	});

	it("does not render a quiet-zone white line when the transcript clips to one row", () => {
		const component = new CollabQrCodeComponent("https://my.omp.sh/#clip-test");
		const full = component.render(120);
		const first = full[0] ?? "";
		expect(first).toMatch(/\x1b\[(?:47|40)m/);

		component.setTranscriptAllocation(1);
		const clipped = component.render(120);
		expect(clipped).toHaveLength(1);

		expect(clipped[0]).toContain("my.omp.sh/#clip-test");

		expect(clipped[0]).not.toMatch(/\x1b\[(?:47|40)m/);
	});

	it("keeps the browser URL as the emergency one-row transcript representation", () => {
		const component = new CollabQrCodeComponent("https://my.omp.sh/#clip-test");
		component.setTranscriptAllocation(1);
		const row = component.renderTranscriptBlockEmergencyRow(10);
		expect(visibleWidth(row)).toBeLessThanOrEqual(10);
		expect(row).toContain("https://my.omp.sh/#clip-test");
	});
});
