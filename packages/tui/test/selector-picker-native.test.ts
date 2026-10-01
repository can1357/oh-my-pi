import { beforeAll, describe, expect, it } from "bun:test";
import type { TspKind, TspPickerProps } from "@oh-my-pi/pi-wire";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { HookSelectorComponent } from "../src/overlays/hook-selector";
import { OAuthSelectorComponent, type OAuthSelectorAuthSource } from "../src/overlays/oauth-selector";
import { PluginSelectorComponent } from "../src/overlays/plugin-selector";
import { ThemeSelectorComponent } from "../src/overlays/theme-selector";
import { ThinkingSelectorComponent } from "../src/overlays/thinking-selector";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const genericCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: (kind: TspKind) => kind !== "picker",
	feature: () => true,
};

/** The hoisted picker child of a docked selector's root. */
function sheet(root: NativeNode | null): { props: TspPickerProps } {
	const child = root?.c?.[0] as NativeNode | undefined;
	expect(child?.k).toBe("picker");
	return { props: child!.p as TspPickerProps };
}

const at = (type: "select" | "activate", item: string) => ({ type, key: "^picker", item }) as const;
const act = (id: string) => ({ type: "action", key: "^picker", act: id, mods: [] }) as const;

describe("theme selector picker", () => {
	function make() {
		const log: string[] = [];
		const selector = new ThemeSelectorComponent(
			"dark",
			["dark", "light", "nord"],
			name => log.push(`select:${name}`),
			() => log.push("cancel"),
			name => log.push(`preview:${name}`),
		);
		return { selector, log };
	}

	it("describes a picker with swatch marks and the current theme, else the card", () => {
		const { selector } = make();
		const p = sheet(selector.describe(pickerCx)).props;
		expect(p.items?.map(item => item.id)).toEqual(["dark", "light", "nord"]);
		expect(p.items?.[2]?.mark?.seed).toBe("nord");
		expect(p.current).toEqual(["dark"]);
		expect(p.selected).toBe("dark");
		expect(p.actions?.map(a => a.label)).toEqual(["Apply", "Close"]);
		expect(selector.describe(genericCx)?.c?.[0]).not.toMatchObject({ k: "picker" });
	});

	it("row click previews, second click applies, close reverts via cancel", () => {
		const { selector, log } = make();
		selector.handleNativeEvent(at("select", "nord"));
		expect(sheet(selector.describe(pickerCx)).props.selected).toBe("nord");
		selector.handleNativeEvent(at("activate", "nord"));
		selector.handleNativeEvent(act("close"));
		expect(log).toEqual(["preview:nord", "select:nord", "cancel"]);
	});
});

describe("thinking selector picker", () => {
	it("carries a thinking-level colour chip per level", () => {
		const selector = new ThinkingSelectorComponent(
			"high" as never,
			["low", "high"] as never,
			() => {},
			() => {},
		);
		const p = sheet(selector.describe(pickerCx)).props;
		expect(p.items?.find(item => item.id === "high")?.chips?.[0]?.dot).toBe("thinkingHigh");
		expect(p.current).toEqual(["high"]);
	});
});

describe("hook selector picker", () => {
	it("pointer select moves the selection without confirming; confirm picks it", () => {
		const picked: string[] = [];
		const selector = new HookSelectorComponent(
			"Pick",
			["one", "two"],
			o => picked.push(o),
			() => {},
		);
		selector.handleNativeEvent(at("select", "1"));
		expect(sheet(selector.describe(pickerCx)).props.selected).toBe("1");
		expect(picked).toEqual([]);
		selector.handleNativeEvent(act("confirm"));
		expect(picked).toEqual(["two"]);
	});
});

describe("plugin selector picker", () => {
	it("keeps project and user installs pending until native confirmation, and Cancel returns to the scope list", () => {
		const installed: string[] = [];
		const selector = new PluginSelectorComponent(
			1,
			[
				{
					plugin: { name: "alpha" },
					marketplace: "shop",
					scope: "project",
					confirmation: "Install alpha into the project registry?",
				},
				{
					plugin: { name: "alpha" },
					marketplace: "shop",
					scope: "user",
					confirmation: "Install alpha into the user registry?",
				},
			],
			new Set<string>(),
			{
				onSelect: (name, marketplace, scope) => installed.push(`${name}@${marketplace}#${scope}`),
				onCancel: () => {},
			},
		);
		expect(sheet(selector.describe(pickerCx)).props.items?.map(item => item.id)).toEqual([
			"alpha@shop#project",
			"alpha@shop#user",
		]);

		selector.handleNativeEvent(at("activate", "alpha@shop#project"));
		const confirmation = sheet(selector.describe(pickerCx)).props;
		expect(confirmation.subtitle).toContain("project registry");
		expect(confirmation.items?.map(item => item.id)).toEqual(["confirm", "cancel"]);
		expect(installed).toEqual([]);

		selector.handleNativeEvent(at("activate", "cancel"));
		expect(sheet(selector.describe(pickerCx)).props.items?.map(item => item.id)).toEqual([
			"alpha@shop#project",
			"alpha@shop#user",
		]);
		expect(installed).toEqual([]);

		selector.handleNativeEvent(at("activate", "alpha@shop#user"));
		expect(sheet(selector.describe(pickerCx)).props.subtitle).toContain("user registry");
		selector.handleNativeEvent(at("activate", "confirm"));
		expect(installed).toEqual(["alpha@shop#user"]);
	});
});

describe("oauth selector picker", () => {
	const providers = getOAuthProviders();
	const signedIn = providers[0]!.id;
	const auth: OAuthSelectorAuthSource = {
		credentials: { has: (id: string) => id === signedIn },
		keys: { source: (id: string) => (id === signedIn ? { kind: "oauth" } : undefined) } as never,
	};

	it("cards with auth-state dots and origin detail; typing keeps the catalogue", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			auth,
			() => {},
			() => {},
		);
		const first = sheet(selector.describe(pickerCx)).props;
		expect(first.layout).toBe("cards");
		const row = first.items?.find(item => item.id === signedIn);
		expect(row?.dot).toBe("success");
		expect(row?.detail).toBe("Signed in · login");
		expect(first.items?.find(item => item.id !== signedIn)?.dot).toBe("muted");
		expect(first.query).toBe("");
		selector.handleInput(providers[1]!.name.slice(0, 3));
		const typed = sheet(selector.describe(pickerCx)).props;
		expect(typed.items).toBe(first.items);
		expect(typed.order?.length).toBeLessThan(providers.length);
	});

	it("activate signs in with the clicked provider; close cancels", () => {
		const log: string[] = [];
		const selector = new OAuthSelectorComponent(
			"login",
			auth,
			id => log.push(id),
			() => log.push("cancel"),
		);
		const target = providers.find(p => p.available)!.id;
		selector.handleNativeEvent(at("activate", target));
		selector.handleNativeEvent(act("close"));
		expect(log).toEqual([target, "cancel"]);
	});
});
