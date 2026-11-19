import * as path from "node:path";
import { getAgentDir, getConfigRootDir, getPluginsDir } from "@oh-my-pi/pi-utils";

// Drop every extension discovered from the user's machine so each test only
// sees what it wrote into the per-test temp project dir. Production composes
// the user-extension list from three independent roots, any one of which can
// leak entries on a contributor's box:
//
// 1. `getConfigRootDir()` (`~/.omp`)
//    Catches the native builtin provider's settings.json-declared extensions
//    that resolve outside the `agent/extensions/` subtree (e.g. an absolute
//    or `../`-relative entry pointing somewhere else under `~/.omp/`), plus
//    the legacy non-XDG `~/.omp/plugins` tree on hosts without XDG dirs.
// 2. `getAgentDir()` (`~/.omp/agent` or `$PI_CODING_AGENT_DIR`)
//    Handles `PI_CODING_AGENT_DIR` overrides that relocate the agent dir
//    (and therefore `agent/extensions/`) out from under the config root.
// 3. `getPluginsDir()` (XDG-aware: `$XDG_DATA_HOME/omp/plugins` or legacy)
//    Handles installed plugin extensions that live outside `~/.omp` when
//    XDG_DATA_HOME resolves the plugins dir somewhere else.
//
// We deliberately do NOT use `pathIsWithin` from pi-utils here: that helper
// resolves symlinks via `fs.realpathSync` on both sides, so a contributor who
// symlinks `~/.omp/agent/extensions/foo.ts` to a dotfiles repo would see the
// candidate's realpath escape the root and slip past the filter. The loader
// reports lexical paths, so a lexical containment check is both correct and
// sufficient for isolating tests from host state.
function lexicalIsWithin(root: string, candidate: string): boolean {
	const normalizedRoot = path.resolve(root);
	const normalizedCandidate = path.resolve(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function filterUserScoped<T extends { path: string }>(items: T[], keepRoots?: string | string[]): T[] {
	if (keepRoots) {
		const roots = Array.isArray(keepRoots) ? keepRoots : [keepRoots];
		return items.filter(it => roots.some(root => lexicalIsWithin(root, it.path)));
	}
	const prefixes = [getConfigRootDir(), getAgentDir(), getPluginsDir()];
	return items.filter(it => !prefixes.some(prefix => lexicalIsWithin(prefix, it.path)));
}
