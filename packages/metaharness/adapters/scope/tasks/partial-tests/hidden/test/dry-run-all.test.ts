import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../src/cli";

/** Every directory and file under `dir`, files with their content. */
function tree(dir: string, prefix = ""): Record<string, string> {
	const files: Record<string, string> = {};
	if (!fs.existsSync(dir)) return files;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const relative = path.join(prefix, entry.name);
		if (entry.isDirectory()) {
			files[`${relative}/`] = "";
			Object.assign(files, tree(path.join(dir, entry.name), relative));
		} else {
			files[relative] = fs.readFileSync(path.join(dir, entry.name), "utf8");
		}
	}
	return files;
}

interface Workspace {
	base: string;
	root: string;
	inbox: string;
}

/** Notes `alpha` (tagged) and archived `beta`, a temp file, and an inbox holding `gamma`. */
function workspace(): Workspace {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "notes-hidden-"));
	const root = path.join(base, "notes");
	run(["init"], root);
	run(["add", "alpha", "first", "note"], root);
	run(["add", "beta", "second", "note"], root);
	run(["tag", "alpha", "work"], root);
	run(["archive", "beta"], root);
	fs.writeFileSync(path.join(root, "scratch.tmp"), "x");
	const inbox = path.join(base, "inbox");
	fs.mkdirSync(inbox);
	fs.writeFileSync(path.join(inbox, "gamma.md"), "third\n");
	return { base, root, inbox };
}

const MUTATING: Array<[command: string, argv: (w: Workspace) => string[]]> = [
	["add", () => ["add", "delta", "new", "note"]],
	["remove", () => ["remove", "alpha"]],
	["rename", () => ["rename", "alpha", "omega"]],
	["archive", () => ["archive", "alpha"]],
	["restore", () => ["restore", "beta"]],
	["tag", () => ["tag", "alpha", "urgent"]],
	["clean", () => ["clean"]],
	["import", w => ["import", w.inbox]],
	["export", w => ["export", path.join(w.base, "bundle.md")]],
];

for (const [command, argv] of MUTATING) {
	test(`${command} --dry-run reports and changes nothing`, () => {
		const w = workspace();
		const before = tree(w.base);
		expect(run([...argv(w), "--dry-run"], w.root)).toMatch(/^would /m);
		expect(tree(w.base)).toEqual(before);
	});
}

test("init --dry-run reports and creates nothing", () => {
	const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "notes-hidden-")), "notes");
	expect(run(["init", "--dry-run"], root)).toMatch(/^would /m);
	expect(fs.existsSync(root)).toBe(false);
});

// Read-only: listing as usual and reporting `would list …` are both fair readings.
test("list --dry-run is accepted and changes nothing", () => {
	const w = workspace();
	const before = tree(w.base);
	run(["list", "--dry-run"], w.root);
	expect(tree(w.base)).toEqual(before);
});
