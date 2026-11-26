import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "../cli";

/** `import <dir>`: copies every note in `<dir>` that does not exist yet. */
export function importNotes(args: string[], ctx: Context): void {
	const [dir] = args;
	if (!dir || !fs.existsSync(dir)) throw new Error(`no such directory: ${dir}`);
	let copied = 0;
	for (const name of fs.readdirSync(dir).sort()) {
		const target = path.join(ctx.root, name);
		if (!name.endsWith(".md") || fs.existsSync(target)) continue;
		fs.copyFileSync(path.join(dir, name), target);
		copied++;
	}
	ctx.out.push(`imported ${copied} notes`);
}
