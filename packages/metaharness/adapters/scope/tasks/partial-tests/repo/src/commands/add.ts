import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "../cli";

/** `add <name> <text...>`: creates a note. */
export function add(args: string[], ctx: Context): void {
	const [name, ...words] = args;
	if (!name) throw new Error("usage: add <name> <text...>");
	const file = path.join(ctx.root, `${name}.md`);
	if (fs.existsSync(file)) throw new Error(`note exists: ${name}`);
	fs.writeFileSync(file, `${words.join(" ")}\n`);
	ctx.out.push(`added ${name}`);
}
