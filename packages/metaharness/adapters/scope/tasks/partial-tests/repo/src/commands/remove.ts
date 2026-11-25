import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "../cli";
import { readIndex, writeIndex } from "../index-file";

/** `remove <name>`: deletes a note and its tags. */
export function remove(args: string[], ctx: Context): void {
	const [name] = args;
	const file = path.join(ctx.root, `${name}.md`);
	if (!name || !fs.existsSync(file)) throw new Error(`no such note: ${name}`);
	fs.unlinkSync(file);
	const index = readIndex(ctx.root);
	if (name in index) {
		delete index[name];
		writeIndex(ctx.root, index);
	}
	ctx.out.push(`removed ${name}`);
}
