/**
 * omptype schemas for `marketplace.json` catalogs.
 *
 * {@link parseMarketplaceCatalog} validates with them, and
 * `bun run gen:marketplace-schema` publishes them as `marketplace-schema.json`,
 * so the published schema accepts exactly what omp loads. Fields omp does not
 * check are documented but left unconstrained.
 */
import { type } from "@oh-my-pi/omptype";
import { MAX_NAME_LENGTH, NAME_RE } from "./types";

/** {@link isValidNameSegment} as one pattern, so the emitted JSON Schema keeps its description. */
const NAME_PATTERN = new RegExp(`^(?=.{1,${MAX_NAME_LENGTH}}$)${NAME_RE.source.slice(1)}`);
const NAME_RULE = "Up to 64 ASCII letters, digits, `.` and `-`, starting and ending with a letter or digit.";

function doc<const D>(def: D, description: string): readonly [D, "@", string] {
	return [def, "@", description];
}

/** A field omp preserves but does not validate. */
function documented(description: string): readonly ["unknown", "@", string] {
	return doc("unknown", description);
}

const gitRef = {
	"ref?": documented("Branch or tag to check out."),
	"sha?": documented("Commit SHA to pin."),
};

const PluginSourceSchema = type(doc(/^\.\//, "Directory inside the marketplace, starting with `./`."))
	.or(doc({ source: "'github'", repo: doc("string > 0", "`owner/repo`."), ...gitRef }, "GitHub repository."))
	.or(doc({ source: "'url'", url: doc("string > 0", "Git repository URL."), ...gitRef }, "Git repository."))
	.or(
		doc(
			{
				source: "'git-subdir'",
				url: doc("string > 0", "Git repository URL."),
				path: doc("string > 0", "Subdirectory holding the plugin."),
				...gitRef,
			},
			"Subdirectory of a git repository.",
		),
	)
	.or(
		doc(
			{
				source: "'npm'",
				package: doc("string > 0", "npm package name."),
				"version?": documented("Package version or range."),
				"registry?": documented("Registry URL."),
			},
			"npm package. Not installable yet.",
		),
	);

/** One `plugins[]` entry. */
export const MarketplacePluginEntrySchema = type({
	name: doc(NAME_PATTERN, `Plugin name, installed as \`name@marketplace\`. ${NAME_RULE}`),
	source: PluginSourceSchema.describe("Where to fetch the plugin."),
	"description?": documented("Short description."),
	"version?": documented(
		"Plugin version. Installation requires 1-128 ASCII letters, digits, or `._+-`, without `..`.",
	),
	"author?": documented("`{ name, email? }`."),
	"homepage?": documented("Homepage URL."),
	"repository?": documented("Source repository URL."),
	"license?": documented("License identifier."),
	"keywords?": documented("Search keywords."),
	"category?": documented("Category."),
	"tags?": documented("Tags."),
	"strict?": documented("Preserved; not used by omp."),
	"commands?": documented("Preserved; not used by omp."),
	"agents?": documented("Preserved; not used by omp."),
	"hooks?": documented("Preserved; not used by omp."),
	"mcpServers?": documented("Preserved; not used by omp."),
	"lspServers?": documented("Inline LSP server map or a path inside the plugin."),
	"dapAdapters?": documented("Inline DAP adapter map or a JSON/YAML path inside the plugin."),
});

/**
 * Catalog envelope. `plugins[]` items are left unchecked here because the
 * parser validates and skips them one at a time.
 */
export const MarketplaceCatalogSchema = type({
	"$schema?": documented("JSON Schema URL for editors; ignored by omp."),
	name: doc(NAME_PATTERN, `Marketplace name, the part after \`@\` in plugin IDs. ${NAME_RULE}`),
	owner: doc({ name: "string", "email?": documented("Owner email.") }, "Marketplace owner."),
	"metadata?": documented("`{ description, version, pluginRoot }`; `pluginRoot` prefixes relative sources."),
	plugins: "unknown[]",
});
