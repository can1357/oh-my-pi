import * as fs from "node:fs";
import type { Context } from "../cli";
import { readIndex } from "../index-file";

/** `list`: prints every note with its tags. */
export function list(_args: string[], ctx: Context): void {
	const index = readIndex(ctx.root);
	const files = fs
		.readdirSync(ctx.root)
		.filter(name => name.endsWith(".md"))
		.sort();
	for (const file of files) {
		const name = file.slice(0, -3);
		const tags = index[name] ?? [];
		ctx.out.push(tags.length > 0 ? `${name} [${tags.join(", ")}]` : name);
	}
}
