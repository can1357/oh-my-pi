/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, it } from "bun:test";
import { createRoot, effect, isSettled, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { Overlays, Transcript, type TranscriptBlock } from "@oh-my-pi/pi-coding-agent/ui/shell/index";

/** The node Tern receives for a single-node block. */
const content = (block: TranscriptBlock): UiNode => block.native()[0]!;

describe("Transcript", () => {
	it("wraps runs of compact blocks for Tern and packs them in the terminal", () => {
		const transcript = new Transcript();
		const a = transcript.append(() => <text text="a" />);
		const c1 = transcript.append(() => <text text="c1" />, { compact: () => true });
		const c2 = transcript.append(() => <text text="c2" />, { compact: () => true });
		createRoot(() => {
			const nodes = transcript.nativeNodes();
			expect(nodes).toHaveLength(2);
			// Tern gets each block's content, not the terminal's edge-trimming wrapper.
			expect(nodes[0]).toBe(content(a));
			expect(nodes[0]!.kind).toBe("text");
			const run = nodes[1]!;
			expect(run.kind).toBe("col");
			expect(run.props()).toMatchObject({ role: "omp.compact", gap: "none" });
			expect(run.children()).toEqual([content(c1), content(c2)]);

			// The run keeps its wrapper while it grows, and settles with its last member.
			const c3 = transcript.append(() => <text text="c3" />, { compact: () => true });
			const grown = transcript.nativeNodes();
			expect(grown[1]).toBe(run);
			expect(run.children()).toEqual([content(c1), content(c2), content(c3)]);
			for (const block of [c1, c2]) transcript.settle(block);
			transcript.nativeNodes();
			expect(isSettled(run)).toBe(false);
			transcript.settle(c3);
			transcript.nativeNodes();
			expect(isSettled(run)).toBe(true);
		});
		expect(transcript.separator(c1.node, c2.node)).toBe(0);
		expect(transcript.separator(a.node, c1.node)).toBe(1);
	});

	it("puts an inline block's children in Tern's main region themselves", () => {
		const transcript = new Transcript();
		transcript.append(
			() => (
				<col role="omp.welcome.block">
					<spacer size="sm" />
					<card role="omp.welcome" />
					<spacer size="sm" />
				</col>
			),
			{ spacedBelow: true, inline: true },
		);
		createRoot(() => {
			expect(transcript.nativeNodes().map(node => node.kind)).toEqual(["spacer", "card", "spacer"]);
		});
	});

	it("leaves a lone compact block bare and follows compactness changes", () => {
		const transcript = new Transcript();
		const compact = signal(false);
		const b1 = transcript.append(() => <text text="b1" />, { compact: () => true });
		const b2 = transcript.append(() => <text text="b2" />, { compact });
		createRoot(() => {
			expect(transcript.nativeNodes()).toEqual([content(b1), content(b2)]);
			compact.set(true);
			const [run] = transcript.nativeNodes();
			expect(run!.children()).toEqual([content(b1), content(b2)]);
			compact.set(false);
			expect(transcript.nativeNodes()).toEqual([content(b1), content(b2)]);
			expect(run!.disposed).toBe(true);
		});
	});

	it("rebuilds scrollback once when removed blocks had rows there", () => {
		const transcript = new Transcript();
		const retired = new Set<UiNode>();
		let replays = 0;
		transcript.attach({ retired: node => retired.has(node), replayHistory: () => replays++, redescribe: () => {} });
		const blocks = ["a", "b", "c"].map(t => transcript.append(() => <text text={t} />));
		retired.add(blocks[1]!.node);

		expect(transcript.truncate(blocks[2]!)).toBe(true);
		expect(replays).toBe(0);
		expect(transcript.truncate(blocks[0]!, { replay: false })).toBe(false);
		expect(transcript.length).toBe(2);
		expect(transcript.truncate(blocks[0]!)).toBe(true);
		expect(replays).toBe(1);
		expect(transcript.length).toBe(0);
		expect(blocks[0]!.node.disposed).toBe(true);
	});

	it("retains the kept blocks in one update of the region and replays scrollback once", () => {
		const transcript = new Transcript();
		const retired = new Set<UiNode>();
		let replays = 0;
		transcript.attach({ retired: node => retired.has(node), replayHistory: () => replays++, redescribe: () => {} });
		const blocks = ["a", "b", "c", "d", "e"].map(t => transcript.append(() => <text text={t} />));
		retired.add(blocks[0]!.node);
		retired.add(blocks[2]!.node);
		createRoot(dispose => {
			const seen: number[] = [];
			effect(() => {
				seen.push(transcript.nodes().length);
			});
			transcript.retain(new Set([blocks[1]!, blocks[4]!]));
			// Every removal lands in one write: the main region is recomputed once, not per removed block.
			expect(seen).toEqual([5, 2]);
			// Keeping every block (one of them in scrollback) writes nothing and replays nothing.
			retired.add(blocks[1]!.node);
			transcript.retain(new Set([blocks[1]!, blocks[4]!]));
			expect(seen).toEqual([5, 2]);
			expect(replays).toBe(1);
			dispose();
		});
		expect(transcript.blocks()).toEqual([blocks[1]!, blocks[4]!]);
		expect(replays).toBe(1);
		expect([0, 2, 3].map(i => blocks[i]!.node.disposed)).toEqual([true, true, true]);
		expect(blocks[1]!.node.disposed).toBe(false);
	});
});

describe("Overlays", () => {
	function setup() {
		const focused = signal<UiNode | null>(null);
		const home = (<editor />) as UiNode;
		const overlays = new Overlays({ focused, focus: node => focused.set(node), fallback: () => home });
		focused.set(home);
		return { focused, home, overlays };
	}

	it("takes focus on open and gives it back on close", () => {
		const { focused, home, overlays } = setup();
		const first = overlays.show(() => <picker />);
		expect(focused()).toBe(first.node);
		const second = overlays.show(() => <picker />);
		second.close();
		expect(focused()).toBe(first.node);
		first.close();
		expect(focused()).toBe(home);
		expect(overlays.open()).toBe(false);
	});

	it("falls back to home when the previous holder is gone, and toasts never take focus", () => {
		const { focused, home, overlays } = setup();
		const first = overlays.show(() => <picker />);
		const second = overlays.show(
			() => (
				<overlay>
					<input key="field" />
				</overlay>
			),
			{ focus: root => root.children()[0]! },
		);
		const field = second.node.children()[0]!;
		expect(focused()).toBe(field);
		first.close();
		second.close();
		expect(focused()).toBe(home);

		let closed = 0;
		const toast = overlays.show(() => <toast text="hi" />, { focus: false, onClose: () => closed++ });
		expect(focused()).toBe(home);
		toast.close();
		toast.close();
		expect(closed).toBe(1);
	});
});
