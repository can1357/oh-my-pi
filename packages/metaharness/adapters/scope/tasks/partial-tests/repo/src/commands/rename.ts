import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "../cli";
import { readIndex, writeIndex } from "../index-file";

/** `rename <from> <to>`: renames a note and carries its tags over. */
export function rename(args: string[], ctx: Context): void {
	const [from, to] = args;
	if (!from || !to) throw new Error("usage: rename <from> <to>");
	const source = path.join(ctx.root, `${from}.md`);
	const target = path.join(ctx.root, `${to}.md`);
	if (!fs.existsSync(source)) throw new Error(`no such note: ${from}`);
	if (fs.existsSync(target)) throw new Error(`note exists: ${to}`);
	fs.renameSync(source, target);
	const index = readIndex(ctx.root);
	if (from in index) {
		index[to] = index[from];
		delete index[from];
		writeIndex(ctx.root, index);
	}
	ctx.out.push(`renamed ${from} to ${to}`);
}
