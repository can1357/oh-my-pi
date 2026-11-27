import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "../cli";

/** `archive <name>`: moves a note into `archive/`. */
export function archive(args: string[], ctx: Context): void {
	const [name] = args;
	const file = path.join(ctx.root, `${name}.md`);
	if (!name || !fs.existsSync(file)) throw new Error(`no such note: ${name}`);
	fs.mkdirSync(path.join(ctx.root, "archive"), { recursive: true });
	fs.renameSync(file, path.join(ctx.root, "archive", `${name}.md`));
	ctx.out.push(`archived ${name}`);
}
