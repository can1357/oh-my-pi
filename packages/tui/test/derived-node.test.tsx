/** @jsxImportSource @oh-my-pi/pi-tui */
/** A derived node: another node's kind, key and children under mapped props and its own handlers. */
import { describe, expect, it } from "bun:test";
import { createRoot, derivedNode, resolveChildren, signal } from "@oh-my-pi/pi-tui";

describe("derivedNode", () => {
	it("lays mapped props over the node and follows both the node and the mapping", () => {
		createRoot(dispose => {
			const tone = signal<"accent" | "muted">("accent");
			const mark = signal<"pick" | "drop" | undefined>(undefined);
			const card = resolveChildren(
				<card key="turn" role="app.turn" tone={tone}>
					<text text="hello" />
				</card>,
			)()[0]!;
			const view = derivedNode(card, props => {
				const current = mark();
				return current ? { ...props, mark: current } : props;
			});

			expect(view.kind).toBe("card");
			expect(view.key()).toBe("turn");
			expect(view.children()).toBe(card.children());
			// Nothing to lay over: the node's own props, untouched.
			expect(view.props()).toBe(card.props());

			mark.set("pick");
			expect(view.props()).toEqual({ role: "app.turn", tone: "accent", mark: "pick" });
			tone.set("muted");
			expect(view.props()).toEqual({ role: "app.turn", tone: "muted", mark: "pick" });
			// The node itself never carries the mark.
			expect(card.props()).toEqual({ role: "app.turn", tone: "muted" });
			dispose();
		});
	});

	it("keeps the node's handlers unless given its own", () => {
		createRoot(dispose => {
			const acts: string[] = [];
			const row = resolveChildren(<row onAction={act => acts.push(`row:${act}`)} />)()[0]!;
			const same = derivedNode(row, props => props);
			const own = derivedNode(row, props => props, {
				onAction: (act, event) => {
					if (act === "pick") acts.push("view:pick");
					else row.handlers.onAction?.(act, event);
				},
			});
			const event = { type: "action", key: "", act: "pick", mods: [] } as const;

			same.handlers.onAction?.("pick", event);
			own.handlers.onAction?.("pick", event);
			own.handlers.onAction?.("copy", { ...event, act: "copy" });
			expect(acts).toEqual(["row:pick", "view:pick", "row:copy"]);
			dispose();
		});
	});
});
