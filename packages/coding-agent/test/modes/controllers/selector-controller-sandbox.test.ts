import { afterEach, describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { createRoot } from "@oh-my-pi/pi-tui";
import * as sandboxPanelModule from "../../../src/modes/sandbox-panel";
import * as sandboxConfigModule from "../../../src/ui/overlays/sandbox/sandbox-config";

afterEach(() => {
	vi.restoreAllMocks();
});

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));

interface Shown {
	readonly factory: () => unknown;
	readonly onClose: () => void;
}

/** `/sandbox` opened against a fake runtime, a fake sheet handle and a fake overlay stack. */
async function setup(options: { aside?: boolean; grantHost?: () => void } = {}) {
	let listener: (() => void) | undefined;
	const unsubscribe = vi.fn();
	const runtime = {
		onChange: vi.fn((fn: () => void) => {
			listener = fn;
			return unsubscribe;
		}),
		grantHost: vi.fn(options.grantHost ?? (() => {})),
		revokeExec: vi.fn(),
	};
	vi.spyOn(SandboxRuntime, "for").mockResolvedValue(runtime as unknown as SandboxRuntime);
	vi.spyOn(sandboxPanelModule, "sandboxPanelModel").mockReturnValue(
		{} as ReturnType<typeof sandboxPanelModule.sandboxPanelModel>,
	);

	const sheet = { setModel: vi.fn(), setNotice: vi.fn() };
	const bare: never[] = [];
	const sheets: sandboxConfigModule.SandboxConfigProps[] = [];
	vi.spyOn(sandboxConfigModule, "SandboxConfigOverlay").mockImplementation(props => {
		sheets.push(props);
		props.ref?.(sheet);
		return bare;
	});

	const shown: Shown[] = [];
	const raise = vi.fn();
	const ctx = {
		sessionManager: { getCwd: () => "/tmp/work" },
		showError: vi.fn(),
		shell: {
			host: { feature: (name: string) => name === "aside" && (options.aside ?? false) },
			focus: vi.fn(),
			overlays: {
				raise,
				show: vi.fn((factory: () => unknown, opts: { onClose: () => void }) => {
					shown.push({ factory, onClose: opts.onClose });
					return { node: {}, closed: false, close: vi.fn() };
				}),
			},
		},
	} as unknown as InteractiveModeContext;
	const controller = new SelectorController(ctx);
	/** Builds the i-th shown overlay's view the way the shell does (in a root of its own). */
	const mount = (index: number): unknown => {
		let view: unknown;
		createRoot(() => {
			view = shown[index]!.factory();
			return [];
		});
		return view;
	};
	const open = async () => {
		controller.showSandboxConfigure();
		await nextTick();
	};
	await open();
	return {
		controller,
		ctx,
		runtime,
		sheet,
		sheets,
		shown,
		unsubscribe,
		bare,
		raise,
		open,
		mount,
		fire: () => listener?.(),
	};
}

describe("SelectorController.showSandboxConfigure", () => {
	it("rebuilds the sheet's model once per tick however many runtime changes arrive", async () => {
		const { sheet, fire, mount } = await setup();
		mount(0);
		expect(sheet.setModel).not.toHaveBeenCalled();

		fire();
		fire();
		expect(sheet.setModel).not.toHaveBeenCalled();
		await nextTick();
		expect(sheet.setModel).toHaveBeenCalledTimes(1);

		fire();
		await nextTick();
		expect(sheet.setModel).toHaveBeenCalledTimes(2);
	});

	it("drops a refresh queued by a runtime change when the overlay closes before it runs", async () => {
		const { sheet, shown, mount, fire } = await setup();
		mount(0);

		fire();
		shown[0]!.onClose();
		await nextTick();

		expect(sheet.setModel).not.toHaveBeenCalled();
	});

	it("shows a failed write's reason, then refreshes; a successful write clears the notice", async () => {
		const { sheet, sheets, mount } = await setup({
			grantHost: () => {
				throw new Error("host is locked by policy");
			},
		});
		mount(0);
		const callbacks = sheets[0]!.callbacks;

		callbacks.allowHost("example.com");
		expect(sheet.setNotice).toHaveBeenCalledWith("host is locked by policy");
		expect(sheet.setModel).toHaveBeenCalledTimes(1);
		expect(sheet.setNotice.mock.invocationCallOrder[0]).toBeLessThan(sheet.setModel.mock.invocationCallOrder[0]!);

		sheet.setNotice.mockClear();
		sheet.setModel.mockClear();
		callbacks.revokeExec("rm");
		expect(sheet.setNotice).toHaveBeenCalledTimes(1);
		expect(sheet.setNotice).toHaveBeenCalledWith(undefined);
		expect(sheet.setModel).toHaveBeenCalledTimes(1);
		expect(sheet.setNotice.mock.invocationCallOrder[0]).toBeLessThan(sheet.setModel.mock.invocationCallOrder[0]!);
	});

	it("unsubscribes from the runtime once when the overlay closes and then opens a fresh sheet", async () => {
		const { shown, sheets, unsubscribe, raise, open, mount, ctx } = await setup();
		mount(0);

		// While open, a repeat request focuses the sheet instead of stacking another.
		await open();
		expect(shown).toHaveLength(1);
		expect(raise).toHaveBeenCalledTimes(1);
		expect(unsubscribe).not.toHaveBeenCalled();

		shown[0]!.onClose();
		expect(unsubscribe).toHaveBeenCalledTimes(1);

		await open();
		expect(shown).toHaveLength(2);
		expect(ctx.shell.overlays.show).toHaveBeenCalledTimes(2);
		mount(1);
		expect(sheets).toHaveLength(2);
		expect(sheets[1]).not.toBe(sheets[0]);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("passes the sheet view unwrapped when the host docks prefs sheets (aside)", async () => {
		const { mount, bare } = await setup({ aside: true });

		expect(mount(0)).toBe(bare);
	});

	it("wraps the sheet view in the fullscreen menu otherwise", async () => {
		const { mount, bare } = await setup({ aside: false });

		const view = mount(0);
		expect(view).toBeDefined();
		expect(view).not.toBe(bare);
	});
});
