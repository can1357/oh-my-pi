import * as fs from "node:fs";
import { stripWindowsExtendedLengthPathPrefix } from "@oh-my-pi/pi-utils";

/**
 * Bun cannot import or require a module from a path that contains `?`: it
 * reads the path cut at the `?`, whatever the specifier's form (a raw path, a
 * `file://` URL, with or without a query), and also when a `?`-free symbolic
 * link leads to such a path. It fails with "Cannot find module", or, for a
 * plain `import()` through such a link, with "ENOENT reading" the cut path. No
 * other path character has this limit.
 */
export class UnloadableModulePathError extends Error {
	constructor(
		readonly modulePath: string,
		readonly pathWithQuestionMark: string,
	) {
		const via = pathWithQuestionMark === modulePath ? "" : ` (its real path ${pathWithQuestionMark})`;
		super(
			`Cannot load ${modulePath}${via}: Bun cannot load a module from a path that contains "?". ` +
				'Move the files to a directory whose path has no "?".',
		);
		this.name = "UnloadableModulePathError";
	}
}

/** The path Bun reads, which on Windows may carry an extended-length prefix holding `?`. */
function holdsQuestionMark(filePath: string): boolean {
	return stripWindowsExtendedLengthPathPrefix(filePath).includes("?");
}

/**
 * Throw {@link UnloadableModulePathError} before importing `modulePath` when
 * Bun cannot load it: when the path itself, or the real path it resolves to,
 * contains `?`. A path with no `?` that does not exist is left for the import
 * to report.
 */
export async function assertBunCanImport(modulePath: string): Promise<void> {
	if (holdsQuestionMark(modulePath)) throw new UnloadableModulePathError(modulePath, modulePath);
	let realPath: string;
	try {
		realPath = await fs.promises.realpath(modulePath);
	} catch {
		return;
	}
	if (holdsQuestionMark(realPath)) throw new UnloadableModulePathError(modulePath, realPath);
}
