import { describe, expect, it } from "bun:test";
import { type Component, Container } from "@oh-my-pi/pi-tui";

function inert(dispose?: () => void): Component {
	return { render: () => [], invalidate: () => {}, dispose };
}

describe("Container.dispose", () => {
	it("calls dispose on each child and tolerates children without dispose", () => {
		const order: string[] = [];
		const container = new Container();
		container.addChild(inert(() => order.push("a")));
		container.addChild(inert()); // no dispose — must not throw
		container.addChild(inert(() => order.push("c")));

		expect(() => container.dispose()).not.toThrow();
		expect(order).toEqual(["a", "c"]);
	});

	it("recurses through nested containers", () => {
		let leafDisposed = 0;
		const outer = new Container();
		const inner = new Container();
		inner.addChild(inert(() => leafDisposed++));
		outer.addChild(inner);

		outer.dispose();
		expect(leafDisposed).toBe(1);
	});

	it("disposeChildren disposes children and detaches them", () => {
		let disposed = 0;
		const container = new Container();
		container.addChild(inert(() => disposed++));

		container.disposeChildren();

		expect(disposed).toBe(1);
		expect(container.children).toEqual([]);
	});
});
