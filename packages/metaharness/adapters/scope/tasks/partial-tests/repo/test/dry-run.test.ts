import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../src/cli";

function setup(): string {
	const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "notes-")), "notes");
	run(["init"], root);
	return root;
}

test("add --dry-run reports the note and writes nothing", () => {
	const root = setup();
	expect(run(["add", "todo", "buy", "milk", "--dry-run"], root)).toMatch(/^would /m);
	expect(fs.existsSync(path.join(root, "todo.md"))).toBe(false);
});

test("remove --dry-run reports the note and keeps it", () => {
	const root = setup();
	run(["add", "todo", "buy", "milk"], root);
	expect(run(["remove", "todo", "--dry-run"], root)).toMatch(/^would /m);
	expect(fs.existsSync(path.join(root, "todo.md"))).toBe(true);
});
