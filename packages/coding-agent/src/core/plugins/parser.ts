/**
 * Feature bracket parser for plugin specifiers.
 *
 * Supports syntax like:
 * - "my-plugin" -> base features (null)
 * - "my-plugin[search,web]" -> specific features
 * - "my-plugin[*]" -> all features
 * - "my-plugin[]" -> no optional features
 * - "@scope/plugin@1.2.3[feat]" -> scoped with version and features
 */

export interface ParsedPluginSpec {
	/** Package name (may include version specifier like @1.0.0) */
	packageName: string;
	/**
	 * Feature selection:
	 * - null: use defaults (base features on first install, preserve on reinstall)
	 * - "*": all features
	 * - string[]: specific features (empty array = no optional features)
	 */
	features: string[] | null | "*";
}

/**
 * Parse plugin specifier with feature bracket syntax.
 *
 * @example
 * parsePluginSpec("my-plugin") // { packageName: "my-plugin", features: null }
 * parsePluginSpec("my-plugin[search,web]") // { packageName: "my-plugin", features: ["search", "web"] }
 * parsePluginSpec("my-plugin[*]") // { packageName: "my-plugin", features: "*" }
 * parsePluginSpec("my-plugin[]") // { packageName: "my-plugin", features: [] }
 * parsePluginSpec("@scope/pkg@1.2.3[feat]") // { packageName: "@scope/pkg@1.2.3", features: ["feat"] }
 */
export function parsePluginSpec(spec: string): ParsedPluginSpec {
	// Find the last bracket pair (to handle version specifiers like @1.0.0)
	const bracketStart = spec.lastIndexOf("[");
	const bracketEnd = spec.lastIndexOf("]");

	// No brackets or malformed -> base features
	if (bracketStart === -1 || bracketEnd === -1 || bracketEnd < bracketStart) {
		return { packageName: spec, features: null };
	}

	const packageName = spec.slice(0, bracketStart);
	const featureStr = spec.slice(bracketStart + 1, bracketEnd).trim();

	// All features
	if (featureStr === "*") {
		return { packageName, features: "*" };
	}

	// No optional features
	if (featureStr === "") {
		return { packageName, features: [] };
	}

	// Specific features (comma-separated)
	const features = featureStr
		.split(",")
		.map((f) => f.trim())
		.filter(Boolean);

	return { packageName, features };
}

/**
 * Format a parsed plugin spec back to string form.
 *
 * @example
 * formatPluginSpec({ packageName: "pkg", features: null }) // "pkg"
 * formatPluginSpec({ packageName: "pkg", features: "*" }) // "pkg[*]"
 * formatPluginSpec({ packageName: "pkg", features: [] }) // "pkg[]"
 * formatPluginSpec({ packageName: "pkg", features: ["a", "b"] }) // "pkg[a,b]"
 */
export function formatPluginSpec(spec: ParsedPluginSpec): string {
	if (spec.features === null) {
		return spec.packageName;
	}
	if (spec.features === "*") {
		return `${spec.packageName}[*]`;
	}
	if (spec.features.length === 0) {
		return `${spec.packageName}[]`;
	}
	return `${spec.packageName}[${spec.features.join(",")}]`;
}

/**
 * Extract the base package name without version specifier.
 * Used for path lookups after npm install.
 *
 * @example
 * extractPackageName("lodash@4.17.21") // "lodash"
 * extractPackageName("@scope/pkg@1.0.0") // "@scope/pkg"
 * extractPackageName("@scope/pkg") // "@scope/pkg"
 */
export function extractPackageName(specifier: string): string {
	// Handle scoped packages: @scope/name@version -> @scope/name
	if (specifier.startsWith("@")) {
		const match = specifier.match(/^(@[^/]+\/[^@]+)/);
		return match ? match[1] : specifier;
	}
	// Unscoped: name@version -> name
	return specifier.replace(/@[^@]+$/, "");
}
