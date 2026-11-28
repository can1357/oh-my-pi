import * as path from "node:path";
import { add } from "./commands/add";
import { archive } from "./commands/archive";
import { clean } from "./commands/clean";
import { exportNotes } from "./commands/export";
import { importNotes } from "./commands/import";
import { init } from "./commands/init";
import { list } from "./commands/list";
import { remove } from "./commands/remove";
import { rename } from "./commands/rename";
import { restore } from "./commands/restore";
import { tag } from "./commands/tag";

/** What a command works with. */
export interface Context {
	/** Directory holding the notes. */
	root: string;
	/** Lines the command prints. */
	out: string[];
}

export type Command = (args: string[], ctx: Context) => void;

export const COMMANDS: Record<string, Command> = {
	init,
	add,
	remove,
	rename,
	archive,
	restore,
	tag,
	clean,
	import: importNotes,
	export: exportNotes,
	list,
};

/** Runs one command against the notes directory `root`; returns what it printed. */
export function run(argv: string[], root: string): string {
	const [name, ...args] = argv;
	const command = COMMANDS[name];
	if (!command) throw new Error(`unknown command: ${name}`);
	const ctx: Context = { root, out: [] };
	command(args, ctx);
	return ctx.out.join("\n");
}

if (import.meta.main) {
	try {
		console.log(run(process.argv.slice(2), path.resolve(process.env.NOTES_DIR ?? "notes")));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
