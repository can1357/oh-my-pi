import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "../cli";

/** `export <file>`: writes every note into one Markdown file. */
export function exportNotes(args: string[], ctx: Context): void {
	const [file] = args;
	if (!file) throw new Error("usage: export <file>");
	const names = fs
		.readdirSync(ctx.root)
		.filter(name => name.endsWith(".md"))
		.sort();
	const sections = names.map(
		name => `# ${name.slice(0, -3)}\n\n${fs.readFileSync(path.join(ctx.root, name), "utf8")}`,
	);
	fs.writeFileSync(file, sections.join("\n"));
	ctx.out.push(`exported ${names.length} notes to ${file}`);
}
