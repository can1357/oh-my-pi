import { expect, test } from "bun:test";
import { LinkTable } from "../src/links";

test("a link is stored under its title's slug", () => {
	const table = new LinkTable();
	expect(table.add("Launch Notes", "https://example.com/launch")).toEqual({
		slug: "launch-notes",
		url: "https://example.com/launch",
	});
	expect(table.get("launch-notes")?.url).toBe("https://example.com/launch");
});

test("a taken slug gets a numeric suffix", () => {
	const table = new LinkTable();
	table.add("Launch Notes", "https://example.com/a");
	expect(table.add("launch notes", "https://example.com/b").slug).toBe("launch-notes-2");
	expect(table.add("Launch, Notes!", "https://example.com/c").slug).toBe("launch-notes-3");
});

test("a title with nothing sluggable falls back to `link`", () => {
	expect(new LinkTable().add("!!!", "https://example.com").slug).toBe("link");
});
