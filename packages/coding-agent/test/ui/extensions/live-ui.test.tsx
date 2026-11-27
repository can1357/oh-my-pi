/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, describe, expect, it } from "bun:test";
import { createRoot, createSurface, derivedNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import type { ExtensionLiveUi } from "../../../src/extensibility/extensions/render-types";
import { createExtensionLiveUi } from "../../../src/ui/extensions/live-ui";
import { Shell } from "../../../src/ui/shell";

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0).toReversed()) dispose();
});

function scene() {
	return createRoot(dispose => {
		const shell = new Shell();
		const native = signal(true);
		const completing = signal(false);
		const consumesEscape = signal(false);
		const errors: unknown[] = [];
		const live = createExtensionLiveUi(
			{ native, transcript: shell.transcript, focused: shell.focused, overlays: shell.overlays },
			{ completing, vimConsumesEscape: consumesEscape },
			error => errors.push(error),
		);
		disposers.push(() => {
			dispose();
			shell.overlays.closeAll();
			shell.transcript.clear();
			shell.surface.dispose();
		});
		return { shell, live, native, completing, consumesEscape, errors };
	});
}

const originals = (live: ExtensionLiveUi): readonly UiNode[] => live.blocks().flatMap(block => block.native());

describe("interactive retained transcript", () => {
	it("preserves native identities and disposes only decorations when a widget unmounts", () => {
		const { shell, live } = scene();
		const block = shell.transcript.append(() => <text key="reply" text="hello" />);
		const original = block.native()[0]!;
		let decoration: UiNode | undefined;
		const disposeWidget = createRoot(dispose => {
			live.decorate(blocks => blocks.flatMap(item => item.native().map(node => (decoration = derivedNode(node, p => ({ ...p, role: "selected" }))))));
			return dispose;
		});
		expect(shell.transcript.nativeNodes()).toEqual([decoration!]);
		expect(decoration).not.toBe(original);
		expect(live.blocks()[0]).toBe(live.blocks()[0]);
		expect(live.blocks()[0]?.id).toBe(String(block.node.id));
		disposeWidget();
		expect(decoration?.disposed).toBe(true);
		expect(original.disposed).toBe(false);
		expect(shell.transcript.nativeNodes()).toEqual([original]);
	});

	it("removes registrations idempotently and does not remove a newer decorator", () => {
		const { shell, live } = scene();
		shell.transcript.append(() => <text text="reply" />);
		const removeFirst = live.decorate(blocks => blocks.flatMap(block => block.native()));
		const removeLast = live.decorate(() => []);
		expect(shell.transcript.nativeNodes()).toEqual([]);
		removeFirst();
		removeFirst();
		expect(shell.transcript.nativeNodes()).toEqual([]);
		removeLast();
		expect(shell.transcript.nativeNodes()).toEqual(originals(live));
	});

	it("follows streaming source changes without explicit invalidation and switches only on rebuild commit", () => {
		const { shell, live } = scene();
		const text = signal("hel");
		const block = shell.transcript.append(() => <text text={text} />);
		const handle = live.blocks()[0]!;
		const original = block.native()[0]!;
		const snapshots: string[] = [];
		live.decorate(blocks => blocks.flatMap(item => item.native().map(node => {
			const props = node.props();
			snapshots.push("text" in props ? String(props.text) : "");
			return node;
		})));
		const surface = createSurface(() => ({ main: shell.transcript.nativeNodes }));
		const reconciler = new Reconciler(surface, "s:live", { cols: () => 80, rows: () => 24, hasFeature: () => false }, () => {});
		disposers.push(() => { reconciler.dispose(); surface.dispose(); });
		reconciler.reconcile();
		const id = reconciler.idOf(original);
		text.set("hello");
		reconciler.reconcile();
		expect(snapshots.at(-1)).toBe("hello");
		expect(reconciler.idOf(original)).toBe(id);
		expect(live.blocks()[0]).toBe(handle);
		shell.transcript.stage();
		const next = shell.transcript.append(() => <text text="rebuilt" />);
		expect(live.blocks()[0]).toBe(handle);
		expect(shell.transcript.nativeNodes()).toEqual([original]);
		shell.transcript.commit();
		reconciler.reconcile();
		expect(live.blocks()[0]?.node).toBe(next.node);
		expect(live.blocks()[0]?.id).not.toBe(handle.id);
		expect(handle.native()).toEqual([]);
		expect(handle.dispatchAction("0", "copy")).toBe(false);
	});

	it("invalidates only changed settled roots and restores originals on removal", () => {
		const { shell, live } = scene();
		const blocks = ["reply-1", "reply-2", "reply-3", "reply-4"].map((key, index) => shell.transcript.append(() => <text key={key} text={key} />, { compact: () => index >= 2 }));
		for (const block of blocks) shell.transcript.settle(block);
		const decorated = originals(live).map(node => derivedNode(node, props => ({ ...props, tone: "accent" })));
		let selected = 0;
		const surface = createSurface(() => ({ main: shell.transcript.nativeNodes }));
		const reconciler = new Reconciler(surface, "s:live", { cols: () => 80, rows: () => 24, hasFeature: () => false }, () => {});
		disposers.push(() => { reconciler.dispose(); surface.dispose(); for (const node of decorated) node.dispose(); });
		const normal = shell.transcript.nativeNodes();
		reconciler.reconcile();
		const untouchedId = reconciler.idOf(normal.at(-1)!);
		if (!untouchedId) throw new Error("Expected a native compact run");
		const remove = live.decorate(items => items.flatMap((item, index) => index === selected ? [decorated[index]!] : item.native()));
		reconciler.reconcile();
		live.invalidate();
		expect(reconciler.reconcile().ops).toEqual([]);
		selected = 1;
		live.invalidate();
		const ops = reconciler.reconcile().ops;
		expect(ops.some(op => op.length > 1 && op[1] === "main/reply-1")).toBe(true);
		expect(ops.some(op => op.length > 1 && op[1] === "main/reply-2")).toBe(true);
		expect(ops.some(op => op.length > 1 && op[1] === untouchedId)).toBe(false);
		live.invalidate();
		expect(reconciler.reconcile().ops).toEqual([]);
		remove();
		expect(reconciler.reconcile().ops.some(op => op.length > 1 && op[1] === untouchedId)).toBe(false);
		expect(shell.transcript.nativeNodes()).toEqual(normal);
	});

	it("never decorates a plain terminal and preserves compact grouping for no-op and failed transforms", () => {
		const { shell, live, native, errors } = scene();
		shell.transcript.append(() => <text text="reply" />, { compact: () => true });
		shell.transcript.append(() => <text text="next" />, { compact: () => true });
		const normal = shell.transcript.nativeNodes();
		const removeNoop = live.decorate(blocks => blocks.flatMap(block => block.native()));
		expect(shell.transcript.nativeNodes()).toEqual(normal);
		expect(normal[0]?.props()).toMatchObject({ role: "omp.compact", gap: "none" });
		removeNoop();
		native.set(false);
		let calls = 0;
		const remove = live.decorate(() => { calls++; throw new Error("bad decorator"); });
		expect(shell.transcript.nativeNodes()).toEqual(normal);
		expect(calls).toBe(0);
		native.set(true);
		expect(shell.transcript.nativeNodes()).toEqual(normal);
		expect(errors).toHaveLength(1);
		live.invalidate();
		shell.transcript.nativeNodes();
		expect(errors).toHaveLength(1);
		remove();
	});

	it("renders block rows through the host's terminal painters", () => {
		const { shell, live } = scene();
		shell.transcript.append(() => <text text="reply" />);
		expect(live.blocks()[0]!.render(80).map(row => Bun.stripANSI(row)).join("\n")).toContain("reply");
	});
});

describe("native transcript event routing", () => {
	it("routes tool folds locally and thought folds through the root with their actual event key", () => {
		const { shell, live } = scene();
		const tool = signal(true);
		const thought = signal(true);
		const keys: string[] = [];
		shell.transcript.append(() => (
			<col onToggle={(collapsed, event) => { keys.push(event.key); if (event.key === "k0") thought.set(collapsed); }}>
				<section key="k0" collapsible collapsed={thought}><text text="thought" /></section>
				<card key="tool" collapsible collapsed={tool} onToggle={collapsed => tool.set(collapsed)}><text text="tool output" /></card>
			</col>
		));
		const block = live.blocks()[0]!;
		block.setExpanded(true);
		expect(thought()).toBe(false);
		expect(tool()).toBe(false);
		expect(keys).toEqual(["k0"]);
		block.setExpanded(true);
		expect(keys).toEqual(["k0"]);
		block.setExpanded(false);
		expect(thought()).toBe(true);
		expect(tool()).toBe(true);
	});

	it("resolves escaped paths and duplicate keys, bubbles actions, and propagates handler errors", () => {
		const { shell, live } = scene();
		const seen: string[] = [];
		shell.transcript.append(() => (
			<col key="root/%^~" onAction={act => { if (act === "fail") throw new Error("handler failure"); seen.push(`root:${act}`); }}>
				<text key="a/b" text="first" />
				<text key="a/b" text="second" onAction={act => seen.push(`second:${act}`)} />
				<text key="a/b" text="third" onAction={act => seen.push(`third:${act}`)} />
				<text key="literal~1" text="literal" />
			</col>
		));
		const block = live.blocks()[0]!;
		expect(block.dispatchAction("a%2Fb", "copy")).toBe(true);
		expect(block.dispatchAction("a%2Fb~1", "copy")).toBe(true);
		expect(block.dispatchAction("a%2Fb~2", "copy")).toBe(true);
		expect(block.dispatchAction("literal%7E1", "open")).toBe(true);
		expect(block.dispatchAction("missing", "copy")).toBe(false);
		expect(block.dispatchAction("a/b", "copy")).toBe(false);
		expect(seen).toEqual(["root:copy", "second:copy", "third:copy", "root:open"]);
		expect(() => block.dispatchAction("", "fail")).toThrow("handler failure");
	});

	it("addresses each native face of an inline multi-root block", () => {
		const { shell, live } = scene();
		const seen: string[] = [];
		shell.transcript.append(() => <col><text key="face" text="one" onAction={act => seen.push(act)} /><text text="two" onAction={act => seen.push(act)} /></col>, { inline: true, spacedBelow: true });
		const block = live.blocks()[0]!;
		expect(block.dispatchAction("face", "one")).toBe(true);
		expect(block.dispatchAction("1", "two")).toBe(true);
		expect(seen).toEqual(["one", "two"]);
	});
});

describe("live focus and prompt Escape", () => {
	it("mounts a passive non-modal overlay without stealing or restoring unrelated focus", () => {
		const { shell, live } = scene();
		const home = (<input text="draft" />) as UiNode;
		shell.setHome(home);
		const overlay = live.showOverlay(() => (<overlay modal><text text="hints" /></overlay>) as UiNode, { passive: true });
		expect(live.focused()).toBe(home);
		expect(shell.overlays.top()?.node.props()).toMatchObject({ modal: false });
		overlay.hide();
		overlay.hide();
		expect(live.focused()).toBe(home);
		expect(shell.overlays.open()).toBe(false);
	});

	it("restores focus when an active overlay closes and closes owned overlays on disposal", () => {
		const { shell, live } = scene();
		const home = (<input text="draft" />) as UiNode;
		shell.setHome(home);
		const disposeWidget = createRoot(dispose => { live.showOverlay(() => (<overlay><input text="dialog" /></overlay>) as UiNode); return dispose; });
		expect(live.focused()).toBe(shell.overlays.top()?.node ?? null);
		disposeWidget();
		expect(shell.overlays.open()).toBe(false);
		expect(live.focused()).toBe(home);
	});

	it("leaves Escape to autocomplete and Vim when they consume it", () => {
		const { live, completing, consumesEscape } = scene();
		expect(live.promptConsumesEscape()).toBe(false);
		completing.set(true);
		expect(live.promptConsumesEscape()).toBe(true);
		completing.set(false);
		consumesEscape.set(true);
		expect(live.promptConsumesEscape()).toBe(true);
		consumesEscape.set(false);
		expect(live.promptConsumesEscape()).toBe(false);
	});
});
