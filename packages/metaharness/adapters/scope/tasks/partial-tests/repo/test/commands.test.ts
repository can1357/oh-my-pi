import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../src/cli";

function setup(): { base: string; root: string } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "notes-"));
	const root = path.join(base, "notes");
	run(["init"], root);
	return { base, root };
}

test("init creates the directory, archive, and index", () => {
	const { root } = setup();
	expect(fs.existsSync(path.join(root, "archive"))).toBe(true);
	expect(fs.readFileSync(path.join(root, "index.json"), "utf8")).toBe("{}\n");
});

test("add, tag, list, and remove", () => {
	const { root } = setup();
	expect(run(["add", "todo", "buy", "milk"], root)).toBe("added todo");
	expect(fs.readFileSync(path.join(root, "todo.md"), "utf8")).toBe("buy milk\n");
	expect(() => run(["add", "todo", "again"], root)).toThrow("note exists: todo");
	expect(run(["tag", "todo", "home"], root)).toBe("tagged todo with home");
	expect(run(["list"], root)).toBe("todo [home]");
	expect(run(["remove", "todo"], root)).toBe("removed todo");
	expect(run(["list"], root)).toBe("");
	expect(fs.readFileSync(path.join(root, "index.json"), "utf8")).toBe("{}\n");
});

test("rename carries tags over", () => {
	const { root } = setup();
	run(["add", "draft", "text"], root);
	run(["tag", "draft", "wip"], root);
	expect(run(["rename", "draft", "final"], root)).toBe("renamed draft to final");
	expect(run(["list"], root)).toBe("final [wip]");
});

test("archive and restore move a note", () => {
	const { root } = setup();
	run(["add", "old", "text"], root);
	expect(run(["archive", "old"], root)).toBe("archived old");
	expect(run(["list"], root)).toBe("");
	expect(fs.existsSync(path.join(root, "archive", "old.md"))).toBe(true);
	expect(run(["restore", "old"], root)).toBe("restored old");
	expect(run(["list"], root)).toBe("old");
});

test("clean deletes temp files only", () => {
	const { root } = setup();
	run(["add", "keep", "text"], root);
	fs.writeFileSync(path.join(root, "a.tmp"), "");
	fs.writeFileSync(path.join(root, "b.bak"), "");
	expect(run(["clean"], root)).toBe("cleaned 2 files");
	expect(fs.readdirSync(root).sort()).toEqual(["archive", "index.json", "keep.md"]);
});

test("import skips existing notes; export bundles them", () => {
	const { base, root } = setup();
	run(["add", "a", "mine"], root);
	const inbox = path.join(base, "inbox");
	fs.mkdirSync(inbox);
	fs.writeFileSync(path.join(inbox, "a.md"), "theirs\n");
	fs.writeFileSync(path.join(inbox, "b.md"), "new\n");
	expect(run(["import", inbox], root)).toBe("imported 1 notes");
	const bundle = path.join(base, "bundle.md");
	expect(run(["export", bundle], root)).toBe(`exported 2 notes to ${bundle}`);
	expect(fs.readFileSync(bundle, "utf8")).toBe("# a\n\nmine\n\n# b\n\nnew\n");
});
