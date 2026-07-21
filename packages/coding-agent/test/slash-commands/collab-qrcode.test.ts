import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CollabHost } from "@pk-nerdsaver-ai/pi-coding-agent/collab/host";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";
import { CollabQrCodeComponent } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/helpers/collab-qrcode";
import { Spacer } from "@pk-nerdsaver-ai/pi-tui";

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
}): NonNullable<InteractiveModeContext["collabHost"]> {
	return {
		link: "relay.example.com/r/full-control",
		viewLink: "relay.example.com/r/read-only",
		webLink: options?.webLink ?? "https://oh-my-pk.pkking.computer/collab/#full-control",
		webViewLink: options?.webViewLink ?? "https://oh-my-pk.pkking.computer/collab/#read-only",
		participants: [{ name: "host", role: "host" }],
	} as unknown as NonNullable<InteractiveModeContext["collabHost"]>;
}

function createRuntimeHarness(options?: { collabHost?: NonNullable<InteractiveModeContext["collabHost"]> }) {
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
		collabHost: options?.collabHost,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		setText,
		showStatus,
		showError,
		present,
		runtime: { ctx } as BuiltinSlashCommandRuntime,
	};
}

function mockStartedHostLinks() {
	return vi.spyOn(CollabHost.prototype, "start").mockImplementation(function (this: CollabHost): Promise<void> {
		Object.defineProperties(this, {
			link: { value: "relay.example.com/r/full-control", configurable: true },
			viewLink: { value: "relay.example.com/r/read-only", configurable: true },
			webLink: { value: "https://oh-my-pk.pkking.computer/collab/#started-full", configurable: true },
			webViewLink: { value: "https://oh-my-pk.pkking.computer/collab/#started-view", configurable: true },
			participants: { value: [{ name: "host", role: "host" as const }], configurable: true },
		});
		return Promise.resolve();
	});
}

describe("/collab slash command QR code rendering", () => {
	it("starts hosting and prints a one-shot full-control QR", async () => {
		const startSpy = mockStartedHostLinks();
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(startSpy).toHaveBeenCalledWith("wss://relay.example.com", "");
		expect(harness.ctx.collabHost).toBeInstanceOf(CollabHost);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("oh-my-pk.pkking.computer/collab/#started-full");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.url).toBe("https://oh-my-pk.pkking.computer/collab/#started-full");
		expect(component.render(120).join("\n")).toMatch(/\x1b\[(?:47|40)m/);
	});

	it("starts hosting and prints a one-shot read-only QR", async () => {
		const startSpy = mockStartedHostLinks();
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/collab view", harness.runtime);

		expect(handled).toBe(true);
		expect(startSpy).toHaveBeenCalledWith("wss://relay.example.com", "");
		expect(harness.ctx.collabHost).toBeInstanceOf(CollabHost);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("oh-my-pk.pkking.computer/collab/#started-view");
		expect(statusText).not.toContain("oh-my-pk.pkking.computer/collab/#started-full");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.url).toBe("https://oh-my-pk.pkking.computer/collab/#started-view");
	});

	it("prints the active full-control browser QR when hosting", async () => {
		const harness = createRuntimeHarness({ collabHost: fakeHost() });

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain("oh-my-pk.pkking.computer/collab/#full-control");
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.render(120).join("\n")).toMatch(/\x1b\[(?:47|40)m/);
	});

	it("prints a one-shot read-only browser QR when hosting", async () => {
		const webLink = "https://oh-my-pk.pkking.computer/collab/#full-control";
		const webViewLink = "https://oh-my-pk.pkking.computer/collab/#read-only";
		const harness = createRuntimeHarness({ collabHost: fakeHost({ webLink, webViewLink }) });

		const handled = await executeBuiltinSlashCommand("/collab view", harness.runtime);

		expect(handled).toBe(true);
		const statusText = harness.showStatus.mock.calls[0]?.[0] as string;
		expect(statusText).toContain(webViewLink);
		expect(statusText).not.toContain(webLink);
		const presented = harness.present.mock.calls[0]?.[0] as readonly unknown[];
		expect(presented[0]).toBeInstanceOf(Spacer);
		expect(presented[1]).toBeInstanceOf(CollabQrCodeComponent);
		const component = presented[1] as CollabQrCodeComponent;
		expect(component.url).toBe(webViewLink);
		expect(component.render(10).join("\n")).toContain("QR code hidden");
	});
});
