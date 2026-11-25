import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "../cli";
import { readIndex, writeIndex } from "../index-file";

/** `tag <name> <tag>`: adds a tag to a note. */
export function tag(args: string[], ctx: Context): void {
	const [name, label] = args;
	if (!name || !label) throw new Error("usage: tag <name> <tag>");
	if (!fs.existsSync(path.join(ctx.root, `${name}.md`))) throw new Error(`no such note: ${name}`);
	const index = readIndex(ctx.root);
	index[name] = [...new Set([...(index[name] ?? []), label])].sort();
	writeIndex(ctx.root, index);
	ctx.out.push(`tagged ${name} with ${label}`);
}
