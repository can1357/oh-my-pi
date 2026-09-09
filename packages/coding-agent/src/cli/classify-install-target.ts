/**
 * Classify an install spec as a local path, marketplace plugin reference, or
 * plain npm package.
 *
 * Rules (applied in order):
 *  0. Looks like a filesystem path (`.`, `..`, `./…`, `..\…`, `/…`, `~/…`,
 *     `C:\…`, `\\unc`) -> local. Routed through `PluginManager.link()` so the
 *     `omp plugin install <path>` and `omp plugin link <path>` flows agree.
 *  1. Starts with `@` (scoped npm) -> always npm.
 *  2. Contains `@` after the first character -> split on the LAST `@`.
 *     If the right-hand side is a known marketplace name, it's a marketplace ref.
 *     Otherwise it's an npm spec (e.g. `pkg@1.2.3`).
 *  3. No `@` -> npm.
 */
// Common npm dist-tags that should never be interpreted as marketplace names
const NPM_DIST_TAGS = new Set([
	"latest",
	"next",
	"beta",
	"alpha",
	"canary",
	"rc",
	"dev",
	"stable",
	"nightly",
	"experimental",
]);

// Semver-like: starts with digit, or contains version range prefixes
const LOOKS_LIKE_VERSION = /^[\d~^>=<]/;

/**
 * Detect specs that name a filesystem path rather than a package: bare `.` /
 * `..`, cwd-relative (`./`, `../`, `.\`, `..\`), absolute (`/`, `C:\`, `C:/`,
 * UNC `\\`), and tilde-prefixed (`~`, `~/`, `~\`). Tilde paths still rely on
 * the shell or the caller for expansion — we only classify them so they reach
 * the link path instead of npm-name validation.
 */
function isLocalPathSpec(spec: string): boolean {
	if (spec === "." || spec === ".." || spec === "~") return true;
	if (spec.startsWith("./") || spec.startsWith("../")) return true;
	if (spec.startsWith(".\\") || spec.startsWith("..\\")) return true;
	if (spec.startsWith("~/") || spec.startsWith("~\\")) return true;
	if (spec.startsWith("/")) return true;
	if (spec.startsWith("\\\\")) return true;
	if (/^[A-Za-z]:[\\/]/.test(spec)) return true;
	return false;
}

export type ClassifiedInstallTarget =
	| { type: "local"; path: string }
	| { type: "marketplace"; name: string; marketplace: string }
	| { type: "npm"; spec: string };

export function classifyInstallTarget(spec: string, knownMarketplaces: Set<string>): ClassifiedInstallTarget {
	// Rule 0: filesystem path — bypass npm/marketplace validation entirely.
	if (isLocalPathSpec(spec)) return { type: "local", path: spec };
	// Rule 1: scoped npm package — @ at position 0 is never a marketplace separator.
	if (spec.startsWith("@")) return { type: "npm", spec };
	// Rule 2: @ somewhere after the first character.
	const atIdx = spec.lastIndexOf("@");
	if (atIdx > 0) {
		const rhs = spec.slice(atIdx + 1);
		// Dist-tags and version specifiers are never marketplace names.
		if (NPM_DIST_TAGS.has(rhs) || LOOKS_LIKE_VERSION.test(rhs)) {
			return { type: "npm", spec };
		}
		if (knownMarketplaces.has(rhs)) {
			return { type: "marketplace", name: spec.slice(0, atIdx), marketplace: rhs };
		}
		// Not a known marketplace — treat as npm version specifier.
		return { type: "npm", spec };
	}
	// Rule 3: no @ at all.
	return { type: "npm", spec };
}
