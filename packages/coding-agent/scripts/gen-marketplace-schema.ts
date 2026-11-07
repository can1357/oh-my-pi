/**
 * `bun run gen:marketplace-schema`: regenerates the published `marketplace.json`
 * JSON Schema from the schemas `parseMarketplaceCatalog` validates with.
 *
 * Output (committed; `test/marketplace/schema.test.ts` fails when stale):
 * - `src/extensibility/plugins/marketplace/marketplace-schema.json`
 */
import * as path from "node:path";
import {
	MarketplaceCatalogSchema,
	MarketplacePluginEntrySchema,
} from "../src/extensibility/plugins/marketplace/schema";

export const MARKETPLACE_SCHEMA_PATH = path.resolve(
	import.meta.dir,
	"../src/extensibility/plugins/marketplace/marketplace-schema.json",
);

const MARKETPLACE_SCHEMA_URL =
	"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/extensibility/plugins/marketplace/marketplace-schema.json";

export function renderMarketplaceSchema(): string {
	const catalog = MarketplaceCatalogSchema.merge({
		plugins: MarketplacePluginEntrySchema.array().describe("Plugins offered by this marketplace."),
	});
	const schema = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: MARKETPLACE_SCHEMA_URL,
		title: "OMP marketplace catalog",
		description: "Schema for .omp-plugin/marketplace.json and .claude-plugin/marketplace.json read by omp.",
		...catalog.toJsonSchema(),
	};
	return `${JSON.stringify(schema, null, "\t")}\n`;
}

if (import.meta.main) {
	await Bun.write(MARKETPLACE_SCHEMA_PATH, renderMarketplaceSchema());
	console.log(`wrote ${path.relative(process.cwd(), MARKETPLACE_SCHEMA_PATH)}`);
}
