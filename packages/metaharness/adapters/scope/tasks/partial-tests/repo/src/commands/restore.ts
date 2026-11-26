import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "../cli";

/** `restore <name>`: moves an archived note back. */
export function restore(args: string[], ctx: Context): void {
	const [name] = args;
	const archived = path.join(ctx.root, "archive", `${name}.md`);
	if (!name || !fs.existsSync(archived)) throw new Error(`not archived: ${name}`);
	fs.renameSync(archived, path.join(ctx.root, `${name}.md`));
	ctx.out.push(`restored ${name}`);
}
