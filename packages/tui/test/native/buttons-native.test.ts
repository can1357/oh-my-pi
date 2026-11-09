import { afterEach, describe, expect, it } from "bun:test";
import { col } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, iconButton, quietButton, segmentedTabs } from "@oh-my-pi/pi-tui/native/overlay";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { TSP_KINDS, type TspNode } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

/** Every omp button shape and a segmented control, described afresh each frame. */
class Toolbar implements Component {
	render(): readonly string[] {
		return ["toolbar"];
	}
	describe(): NativeNode {
		return col([
			segmentedTabs(
				{
					items: [
						{ id: "path", label: "Path" },
						{ id: "tree", label: "Tree" },
					],
					active: "path",
					role: "omp.app.seg",
				},
				"style",
			),
			iconButton("x", "close", "Close  esc", { key: "x", aria: "Close", on: true }),
			quietButton("Stage all", "stage-all", "Stage every change"),
			actionBar([
				actionButton("Kill", "kill", { keys: "ctrl+k", tone: "error" }),
				actionButton("Commit", "commit", { disabled: "Nothing to commit" }),
				null,
				actionButton("Info", "info", { keys: "enter", tone: "accent" }),
			]),
		]);
	}
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

/** The node described with sibling key `key`. */
function keyed(h: TspHarness, key: string): TspNode {
	const found = h.find(node => node.id.endsWith(`.${key}`) || node.id.endsWith(`/${key}`));
	if (!found) throw new Error(`no node keyed ${key}`);
	return found;
}

/** The kinds of a node's children. */
function childKinds(node: TspNode): string[] {
	return (node.c ?? []).map(child => child.k);
}

describe("omp buttons on the wire", () => {
	it("a Tern that lists `button` gets button nodes and segmented tabs, keeping roles and tones", async () => {
		harness = await TspHarness.start(tui => tui.addChild(new Toolbar()));
		const h = harness;
		expect(keyed(h, "info")).toMatchObject({
			k: "button",
			p: { role: "omp.btn", text: "Info", keys: ["enter"], variant: "primary", tone: "accent" },
		});
		expect(keyed(h, "kill")).toMatchObject({
			k: "button",
			p: { keys: ["ctrl", "k"], variant: "danger", tone: "error", actions: { click: "kill" } },
		});
		const commit = keyed(h, "commit");
		expect(commit).toMatchObject({ k: "button", p: { disabled: "Nothing to commit", tone: "muted" } });
		expect(commit.p).not.toHaveProperty("variant");
		expect(keyed(h, "x")).toMatchObject({
			k: "button",
			p: { role: "omp.app.ibtn.set", variant: "quiet", icon: "x", aria: "Close", on: true },
		});
		expect(keyed(h, "stage-all")).toMatchObject({
			k: "button",
			p: { role: "omp.app.qbtn", variant: "quiet", size: "sm", text: "Stage all" },
		});
		expect(keyed(h, "style").p).toMatchObject({ role: "omp.app.seg", variant: "segmented" });
		expect(h.errors).toEqual([]);
	});

	it("a Tern without `button` gets the role-styled rows, icons and plain tabs", async () => {
		harness = await TspHarness.start(tui => tui.addChild(new Toolbar()), {
			kinds: TSP_KINDS.filter(kind => kind !== "button"),
		});
		const h = harness;
		const info = keyed(h, "info");
		expect(info).toMatchObject({ k: "row", p: { role: "omp.btn", tone: "accent", actions: { click: "info" } } });
		expect(childKinds(info)).toEqual(["text", "kbd"]);
		// Unavailable: muted and no click action.
		const commit = keyed(h, "commit");
		expect(commit).toMatchObject({ k: "row", p: { role: "omp.btn", tone: "muted" } });
		expect(commit.p).not.toHaveProperty("actions");
		expect(keyed(h, "x")).toMatchObject({ k: "icon", p: { name: "x", role: "omp.app.ibtn.set" } });
		expect(keyed(h, "stage-all")).toMatchObject({ k: "row", p: { role: "omp.app.qbtn" } });
		expect(keyed(h, "style").p).not.toHaveProperty("variant");
		expect(h.errors).toEqual([]);
	});

	it("an optimistic start sends rows until the hello reply lists `button`", async () => {
		harness = await TspHarness.start(tui => tui.addChild(new Toolbar()), { expected: true, manualProbe: true });
		const h = harness;
		expect(keyed(h, "info").k).toBe("row");
		h.terminal.answerProbe();
		h.flush();
		expect(keyed(h, "info").k).toBe("button");
		expect(h.errors).toEqual([]);
	});
});
