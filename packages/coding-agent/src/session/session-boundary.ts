import * as fs from "node:fs";
import * as path from "node:path";

let boundaryRoot: string | undefined;

/** Resolve existing ancestors too: a not-yet-created journal must not escape through a symlink. */
function canonicalPath(file: string): string {
	// Normalizing ".." before realpath can check a different target than the filesystem opens.
	if (file.split(/[\\/]/).includes("..")) {
		throw new Error(`Session path with parent traversal is not allowed under session boundary: ${file}`);
	}
	let ancestor = path.resolve(file);
	const missing: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(ancestor), ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// A dangling symlink is not a missing directory we may safely create.
			try {
				if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Cannot resolve session path: ${file}`);
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
			}
			const parent = path.dirname(ancestor);
			if (parent === ancestor) throw error;
			missing.unshift(path.basename(ancestor));
			ancestor = parent;
		}
	}
}

/** An explicit launch option wins; inherited environment wins over native configuration. */
export function resolveSessionBoundaryRoot(explicit?: string, configured?: string): string | undefined {
	return explicit ?? boundaryRoot ?? process.env.OMP_SESSION_BOUNDARY_ROOT ?? configured;
}

/** Process-wide opt-in; a resumed project's settings cannot loosen an active boundary. */
export function configureSessionBoundaryRoot(root?: string): () => void {
	const previous = boundaryRoot;
	if (root !== undefined) {
		if (!root.trim()) throw new Error("sessionBoundaryRoot must be a non-empty path");
		const canonical = canonicalPath(root);
		if (boundaryRoot && boundaryRoot !== canonical) {
			throw new Error(`Cannot change active session boundary: ${boundaryRoot}`);
		}
		boundaryRoot = canonical;
	}
	return () => {
		boundaryRoot = previous;
	};
}

/** Call before touching transcript data, including bounded previews and streaming reads. */
export function assertSessionBoundary(file: string): void {
	if (boundaryRoot === undefined && process.env.OMP_SESSION_BOUNDARY_ROOT !== undefined) {
		configureSessionBoundaryRoot(process.env.OMP_SESSION_BOUNDARY_ROOT);
	}
	if (!boundaryRoot) return;
	const relative = path.relative(boundaryRoot, canonicalPath(file));
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Session path is outside session boundary ${boundaryRoot}: ${file}`);
	}
}
