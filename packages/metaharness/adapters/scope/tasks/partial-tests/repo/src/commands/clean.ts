import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "../cli";

/** `clean`: deletes leftover `*.tmp` and `*.bak` files. */
export function clean(_args: string[], ctx: Context): void {
	let removed = 0;
	for (const name of fs.readdirSync(ctx.root)) {
		if (!name.endsWith(".tmp") && !name.endsWith(".bak")) continue;
		fs.unlinkSync(path.join(ctx.root, name));
		removed++;
	}
	ctx.out.push(`cleaned ${removed} files`);
}
