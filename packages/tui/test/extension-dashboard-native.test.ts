import { beforeAll, describe, expect, test } from "bun:test";
import { TSP_KINDS, type TspNode, type TspPickerProps } from "@oh-my-pi/pi-wire";
import { ExtensionDashboard, type ExtensionDashboardRuntime } from "../src/overlays/extensions/extension-dashboard";
import type { Extension, ExtensionProvider } from "../src/overlays/extensions/types";
import { initTheme } from "../src/theme";
import { TspHarness } from "./native/tsp-harness";

beforeAll(async () => {
	await initTheme(false);
});

function extension(kind: Extension["kind"], name: string, provider: string): Extension {
	return {
		id: `${kind}:${name}`,
		kind,
		name,
		displayName: name,
		description: `${name} description`,
		path: `/home/u/.omp/${kind}/${name}.md`,
		source: { provider, providerName: provider, level: "user" },
		state: "active",
		raw: { content: `# ${name}` },
	};
}

interface Fixture {
	readonly runtime: ExtensionDashboardRuntime;
	readonly disabled: string[];
}

function fixture(): Fixture {
	const disabled: string[] = [];
	const providers: ExtensionProvider[] = [
		{ id: "native", displayName: "OMP", enabled: true, userSourceEnabled: true, foreignUserSource: false },
		{ id: "claude", displayName: "Claude Code", enabled: true, userSourceEnabled: true, foreignUserSource: false },
	];
	const extensions = [extension("skill", "alpha", "native"), extension("slash-command", "gamma", "claude")];
	const runtime: ExtensionDashboardRuntime = {
		getDisabledExtensions: () => disabled,
		setDisabledExtensions: ids => {
			disabled.splice(0, disabled.length, ...ids);
		},
		getProviders: () => providers,
		loadExtensions: async ids =>
			extensions.map(ext =>
				ids.includes(ext.id) ? { ...ext, state: "disabled", disabledReason: "item-disabled" } : ext,
			),
		toggleProvider: () => true,
		toggleUserSource: () => true,
		persistMcpToggle: async () => {},
		applyMcpToggle: async () => {},
		subscribeMcpChanges: () => [],
	};
	return { runtime, disabled };
}

async function open(fx: Fixture, kinds?: readonly string[]): Promise<TspHarness> {
	const dashboard = await ExtensionDashboard.create({ runtime: fx.runtime, terminalHeight: 30 });
	const harness = await TspHarness.start(
		tui => {
			tui.showOverlay(dashboard, { width: "100%", maxHeight: "100%", fullscreen: true });
			dashboard.onRequestRender = () => tui.requestRender();
		},
		kinds ? { kinds } : {},
	);
	await harness.render();
	return harness;
}

function pickerOf(harness: TspHarness): { node: TspNode; props: TspPickerProps } {
	const found = harness.find(node => node.k === "picker");
	if (found?.k !== "picker" || !found.p) throw new Error("no picker sheet");
	return { node: found, props: found.p };
}

describe("ExtensionDashboard native", () => {
	test("is a picker sheet whose row activation toggles like Space and whose scopes switch provider", async () => {
		const fx = fixture();
		const harness = await open(fx);
		expect(harness.tui.nativeFallbackCount).toBe(0);
		const sf = harness.terminal.surface!;
		const sheet = pickerOf(harness);
		const alpha = sheet.props.items?.find(item => item.label === "alpha");
		expect(alpha).toBeDefined();

		harness.event({ ev: "activate", sf, id: sheet.node.id, item: alpha!.id });
		expect(fx.disabled).toEqual(["skill:alpha"]);

		harness.event({ ev: "action", sf, id: sheet.node.id, act: "scope", value: "claude", mods: [] });
		const scoped = pickerOf(harness).props;
		expect(scoped.scope).toBe("claude");
		expect(scoped.items?.map(item => item.label)).toContain("gamma");
		expect(scoped.items?.map(item => item.label)).not.toContain("alpha");
		expect(harness.tui.nativeFallbackCount).toBe(0);
		harness.stop();
	});

	test("without picker it is a page whose list activation toggles the row", async () => {
		const fx = fixture();
		const harness = await open(
			fx,
			TSP_KINDS.filter(kind => kind !== "picker"),
		);
		expect(harness.tui.nativeFallbackCount).toBe(0);
		const list = harness.find(node => node.k === "list");
		const alpha = list?.c?.find(row => row.k === "item" && JSON.stringify(row.p?.label).includes('"alpha"'));
		expect(alpha).toBeDefined();
		harness.event({ ev: "activate", sf: harness.terminal.surface!, id: list!.id, item: alpha!.id });
		expect(fx.disabled).toEqual(["skill:alpha"]);
		harness.stop();
	});
});
