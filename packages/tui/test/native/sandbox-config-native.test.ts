import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { SandboxConfigModel } from "@oh-my-pi/pi-tui/overlays/sandbox-config";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { TSP_KINDS, type TspEvent, type TspNode, type TspPrefsProps, type TspPrefsRow } from "@oh-my-pi/pi-wire";
import { type HostCall, type SandboxHost, sandboxHost } from "../sandbox-config-host";
import { TspHarness } from "./tsp-harness";

const MODEL: Partial<SandboxConfigModel> = {
	allowWrite: ["~/cache"],
	denyRead: ["~/.ssh"],
	allowedHosts: ["github.com"],
	ignored: [{ id: "sandbox.enabled", reason: "project config sets false, looser than true" }],
	effective: { readwritePaths: ["/work"], readonlyPaths: ["/usr"], deniedPaths: ["/home/u/.ssh"] },
	blockedHosts: ["evil.example"],
};

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

beforeAll(async () => {
	await initTheme(false);
});

async function open(
	model: Partial<SandboxConfigModel> = MODEL,
	kinds?: readonly string[],
): Promise<{ h: TspHarness; calls: HostCall[]; host: SandboxHost }> {
	const host = sandboxHost(model, () => harness?.tui.requestRender());
	harness = await TspHarness.start(
		tui => {
			tui.showOverlay(host.overlay, { width: "100%", maxHeight: "100%", fullscreen: true });
			tui.setFocus(host.overlay);
		},
		{ features: ["blobs", "settle", "adopt", "dock", "aside"], kinds },
	);
	return { h: harness, calls: host.calls, host };
}

function prefs(h: TspHarness): { node: TspNode; props: TspPrefsProps } {
	const found = h.find(node => node.k === "prefs");
	if (found?.k !== "prefs" || !found.p) throw new Error("no prefs page");
	return { node: found, props: found.p };
}

function rowOf(props: TspPrefsProps, id: string): TspPrefsRow | undefined {
	for (const section of props.sections) for (const r of section.rows) if (r.id === id) return r;
	return undefined;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Send a prefs event addressed to the page and settle. */
function send(h: TspHarness, event: DistributiveOmit<TspEvent, "sf" | "id">): void {
	h.event({ ...event, sf: h.terminal.surface!, id: prefs(h).node.id } as TspEvent);
}

describe("/sandbox overlay as a native prefs page", () => {
	it("draws the four pages with the status as the lead and the settings as typed controls", async () => {
		const { h } = await open();
		const { props } = prefs(h);
		expect(props.pages.map(page => page.id)).toEqual(["overview", "filesystem", "network", "effective"]);
		expect(props.lead).toBe("Active · seatbelt · network allowlist");
		expect(rowOf(props, "enabled")?.control).toEqual({ k: "switch", on: false });
		expect(rowOf(props, "scope")?.control).toMatchObject({ k: "multi", values: ["bash", "eval", "exec"] });
		// A loosening the project tried is shown once, read-only, as a warning.
		expect(rowOf(props, "ignored:0")).toMatchObject({
			label: "enabled",
			warning: "project config sets false, looser than true",
			control: { k: "text", value: "" },
		});
		expect(rowOf(props, "ignored:0")?.disabled).toBeDefined();
		expect(h.errors).toEqual([]);
	});

	it("explains a degraded runtime with its warnings on the overview", async () => {
		const warning = "Network allowlist needs loopback proxy confinement; network is denied instead.";
		const { h } = await open({
			status: { state: "active", backend: "bubblewrap", network: "deny", warnings: [warning] },
		});
		const { props } = prefs(h);
		expect(props.sections.find(section => section.id === "warnings")?.rows).toEqual([
			expect.objectContaining({ id: "warning:0", warning }),
		]);
	});

	it("applies switch, choice and multi changes as typed setting writes, and null as a reset", async () => {
		const { h, calls } = await open();
		send(h, { ev: "change", item: "enabled", value: true });
		send(h, { ev: "change", item: "mode", value: "read-only" });
		send(h, { ev: "change", item: "mode", value: "bogus" });
		send(h, { ev: "change", item: "scope", value: ["exec", "bash", "nope"] });
		send(h, { ev: "change", item: "fallback", value: null });
		expect(calls).toEqual([
			["set", { id: "enabled", value: true }],
			["set", { id: "mode", value: "read-only" }],
			["set", { id: "scope", value: ["bash", "exec"] }],
			["reset", "fallback"],
		]);
		// The host's refreshed model reaches the page.
		const { props } = prefs(h);
		expect(rowOf(props, "enabled")?.control).toEqual({ k: "switch", on: true });
		expect(rowOf(props, "mode")?.control).toMatchObject({ value: "read-only" });
	});

	it("disables a locked setting with its reason and ignores changes to it", async () => {
		const { h, calls } = await open({ locked: { enabled: "Set by $PI_SANDBOX" } });
		expect(rowOf(prefs(h).props, "enabled")?.disabled).toBe("Set by $PI_SANDBOX");
		send(h, { ev: "change", item: "enabled", value: true });
		expect(calls).toEqual([]);
	});

	it("shows a rejected edit's notice in the lead until cleared", async () => {
		const { h, host } = await open();
		host.overlay.setNotice("unknown path token $HOME");
		await h.render();
		expect(prefs(h).props.lead).toBe("Active · seatbelt · network allowlist — unknown path token $HOME");
		host.overlay.setNotice(undefined);
		await h.render();
		expect(prefs(h).props.lead).toBe("Active · seatbelt · network allowlist");
	});

	it("adds a path through the add action and a draft row, edits an entry and removes a cleared one", async () => {
		const { h, calls } = await open();
		send(h, { ev: "action", act: "page", value: "filesystem" });
		expect(prefs(h).props.page).toBe("filesystem");
		expect(rowOf(prefs(h).props, "allowWrite:0")?.control).toEqual({ k: "text", value: "~/cache", mono: true });

		send(h, { ev: "action", act: "add", value: "allowWrite:add" });
		expect(prefs(h).props.editing).toMatchObject({ row: "allowWrite:new", draft: "" });
		send(h, { ev: "change", item: "allowWrite:new", value: "  /opt/tools  " });
		expect(calls.at(-1)).toEqual(["add", "allowWrite", "/opt/tools"]);
		expect(rowOf(prefs(h).props, "allowWrite:new")).toBeUndefined();
		expect(rowOf(prefs(h).props, "allowWrite:1")?.control).toMatchObject({ value: "/opt/tools" });

		send(h, { ev: "change", item: "allowWrite:0", value: "~/cache2" });
		expect(calls.at(-1)).toEqual(["replace", "allowWrite", "~/cache", "~/cache2"]);

		send(h, { ev: "change", item: "denyRead:0", value: "   " });
		expect(calls.at(-1)).toEqual(["remove", "denyRead", "~/.ssh"]);
		expect(rowOf(prefs(h).props, "denyRead:0")).toBeUndefined();
		// The emptied list's Add row takes the selection.
		expect(prefs(h).props.focus).toBe("denyRead:add");
		expect(h.errors).toEqual([]);
	});

	it("cancels a draft on close or on picking another row, adding nothing, and leaves the selection on Add", async () => {
		const { h, calls } = await open();
		send(h, { ev: "action", act: "page", value: "network" });
		send(h, { ev: "action", act: "add", value: "allowedHosts:add" });
		send(h, { ev: "action", act: "close", value: "allowedHosts:new" });
		expect(prefs(h).props.editing ?? null).toBeNull();
		expect(rowOf(prefs(h).props, "allowedHosts:new")).toBeUndefined();
		expect(prefs(h).props.focus).toBe("allowedHosts:add");

		send(h, { ev: "action", act: "add", value: "allowedHosts:add" });
		send(h, { ev: "select", item: "networkMode" });
		expect(rowOf(prefs(h).props, "allowedHosts:new")).toBeUndefined();
		expect(prefs(h).props.editing ?? null).toBeNull();

		send(h, { ev: "action", act: "add", value: "allowedHosts:add" });
		send(h, { ev: "change", item: "allowedHosts:new", value: "" });
		expect(calls).toEqual([]);
		send(h, { ev: "action", act: "close" });
		expect(calls).toEqual([["close"]]);
	});

	it("allows the host a blocked row names, even after the list was refreshed", async () => {
		const { h, calls, host } = await open({ blockedHosts: ["evil.example", "cdn.example"] });
		send(h, { ev: "action", act: "page", value: "network" });
		expect(rowOf(prefs(h).props, "blocked:cdn.example")).toMatchObject({
			label: "cdn.example",
			control: { k: "action", act: "allow" },
		});
		// A refresh lands between drawing the row and the click: the click still names cdn.example.
		host.push({ blockedHosts: ["new.example", "cdn.example"] });
		send(h, { ev: "action", act: "allow", value: "blocked:cdn.example" });
		send(h, { ev: "action", act: "allow", value: "blocked:evil.example" });
		expect(calls).toEqual([["allow", "cdn.example"]]);
	});

	it("lists session grants on the Filesystem page and removes one through its action", async () => {
		const { h, calls } = await open({ sessionPaths: { write: ["/work/out"], read: [] } });
		send(h, { ev: "action", act: "page", value: "filesystem" });
		const section = prefs(h).props.sections.find(s => s.id === "session");
		expect(section?.rows).toEqual([
			expect.objectContaining({ control: { k: "action", label: "Remove", act: "remove" } }),
		]);
		send(h, { ev: "action", act: "remove", value: section!.rows[0]!.id });
		expect(calls).toEqual([["revoke", "write", "/work/out"]]);
		expect(prefs(h).props.sections.some(s => s.id === "session")).toBe(false);
	});

	it("shows the resolved policy read-only: its rows ignore changes", async () => {
		const { h, calls } = await open();
		send(h, { ev: "action", act: "page", value: "effective" });
		const { props } = prefs(h);
		expect(props.sections.map(section => section.title)).toEqual(["Writable", "Readable", "Denied"]);
		expect(rowOf(props, "rw:0")).toMatchObject({ control: { value: "/work" } });
		expect(rowOf(props, "rw:0")?.disabled).toBeDefined();
		send(h, { ev: "change", item: "rw:0", value: "/elsewhere" });
		expect(calls).toEqual([]);
	});

	it("falls back to the overlay card, not a prefs page, where the terminal lacks prefs", async () => {
		const { h, calls } = await open(
			MODEL,
			TSP_KINDS.filter(kind => kind !== "prefs"),
		);
		expect(h.find(node => node.k === "prefs")).toBeUndefined();
		expect(h.find(node => node.k === "card" && node.p?.role === "omp.overlay.sandbox")).toBeDefined();
		// The card's rows activate like Enter: the switch toggles.
		const rows = h.find(node => node.k === "list" && node.id.endsWith(".rows"));
		const enabled = h.find(node => node.k === "item" && node.id.endsWith("/enabled"));
		h.event({ ev: "activate", sf: h.terminal.surface!, id: rows!.id, item: enabled!.id });
		expect(calls).toEqual([["set", { id: "enabled", value: true }]]);
		// The tab strip is the TabBar's: a tab click switches the page.
		const tabs = h.find(node => node.k === "tabs");
		h.event({ ev: "select", sf: h.terminal.surface!, id: tabs!.id, item: "network" });
		expect(h.find(node => node.k === "item" && node.id.endsWith("/networkMode"))).toBeDefined();
		expect(h.errors).toEqual([]);
	});
});
