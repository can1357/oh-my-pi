import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "../cli";

/** `init`: creates the notes directory, its archive, and an empty index. */
export function init(_args: string[], ctx: Context): void {
	fs.mkdirSync(path.join(ctx.root, "archive"), { recursive: true });
	const index = path.join(ctx.root, "index.json");
	if (!fs.existsSync(index)) fs.writeFileSync(index, "{}\n");
	ctx.out.push(`initialized ${ctx.root}`);
}
