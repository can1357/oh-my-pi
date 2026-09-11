/**
 * The fullscreen transcript selectors recompose their whole column on every
 * keystroke, so the prompt-zone strip is cached per child. The cache keys on
 * the array a child returns, which is the {@link Component} render contract's
 * "nothing changed" signal — a child that repaints itself asynchronously
 * (Kitty image conversion, todo strike frames) must not keep serving the rows
 * it had before.
 */
import { describe, expect, it } from "bun:test";
import { OutlineRowCache } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-outline";
import type { Component } from "@oh-my-pi/pi-tui";

/** A child that honors the render contract: same array until its rows change. */
function child(initial: string): Component & { update(text: string): void; strips: number } {
	let rows = [initial];
	return {
		strips: 0,
		update(text: string) {
			rows = [text];
		},
		render(): readonly string[] {
			return rows;
		},
	} as unknown as Component & { update(text: string): void; strips: number };
}

describe("OutlineRowCache", () => {
	it("reuses the stripped rows while a child returns the same array", () => {
		const cache = new OutlineRowCache();
		const children = [child("a"), child("b")];

		const first = cache.rows(children, 40);
		const second = cache.rows(children, 40);

		expect(first).toEqual([["a"], ["b"]]);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).toBe(first[1]);
	});

	it("serves the new rows after a child repaints itself", () => {
		const cache = new OutlineRowCache();
		const target = child("converting image…");
		cache.rows([target], 40);

		(target as unknown as { update(text: string): void }).update("<image>");

		expect(cache.rows([target], 40)).toEqual([["<image>"]]);
	});

	it("strips OSC 133 prompt zones, which would garble the overlay frame", () => {
		const cache = new OutlineRowCache();
		const bubble = {
			render: () => ["\x1b]133;A\x07 prompt \x1b]133;B\x07"],
		} as unknown as Component;

		expect(cache.rows([bubble], 40)).toEqual([[" prompt "]]);
	});
});
