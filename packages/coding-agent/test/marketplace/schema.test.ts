import { describe, expect, test } from "bun:test";
import { isJsonSchemaValueValid } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { parseMarketplaceCatalog } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { MARKETPLACE_SCHEMA_PATH, renderMarketplaceSchema } from "../../scripts/gen-marketplace-schema";
import marketplaceSchema from "../../src/extensibility/plugins/marketplace/marketplace-schema.json" with { type: "json" };

const catalog = (plugins: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	name: "acme-plugins",
	owner: { name: "Acme" },
	plugins,
	...overrides,
});

/** Catalogs and whether omp loads them with every plugin entry intact. */
const CASES: Array<[label: string, catalog: Record<string, unknown>, accepted: boolean]> = [
	[
		"every source variant, extra fields, and loosely typed optional fields",
		catalog(
			[
				{ name: "local", source: "./plugins/local", description: 5, version: ["1"], author: "Ada" },
				{ name: "gh", source: { source: "github", repo: "acme/gh", ref: "main", sha: 7 } },
				{ name: "git", source: { source: "url", url: "https://git.example.com/acme/git.git" } },
				{ name: "sub", source: { source: "git-subdir", url: "acme/mono", path: "tools/sub" } },
				{ name: "pkg", source: { source: "npm", package: "@acme/pkg" }, custom: true },
			],
			{ $schema: "https://example.com/any.json", metadata: "free-form", extra: { kept: true } },
		),
		true,
	],
	["empty owner name", catalog([], { owner: { name: "" } }), true],
	["marketplace name with a space", catalog([], { name: "Acme Plugins" }), false],
	["marketplace name over 64 characters", catalog([], { name: "a".repeat(65) }), false],
	["owner without a name", catalog([], { owner: { email: "a@b.c" } }), false],
	["plugin entry that is not an object", catalog(["./plugins/x"]), false],
	["plugin name ending in a dot", catalog([{ name: "bad.", source: "./x" }]), false],
	["relative source without ./", catalog([{ name: "p", source: "plugins/p" }]), false],
	["unknown source variant", catalog([{ name: "p", source: { source: "archive", url: "https://x" } }]), false],
	["git-subdir source without a path", catalog([{ name: "p", source: { source: "git-subdir", url: "a/b" } }]), false],
];

function loadsIntact(value: Record<string, unknown>): boolean {
	try {
		const parsed = parseMarketplaceCatalog(JSON.stringify(value), "/marketplace.json");
		return Array.isArray(value.plugins) && parsed.plugins.length === value.plugins.length;
	} catch {
		return false;
	}
}

describe("marketplace-schema.json", () => {
	test("matches a fresh `bun run gen:marketplace-schema`", async () => {
		expect(await Bun.file(MARKETPLACE_SCHEMA_PATH).text()).toBe(renderMarketplaceSchema());
	});

	test("accepts exactly the catalogs omp loads with every entry intact", () => {
		for (const [label, value, accepted] of CASES) {
			expect({ label, schema: isJsonSchemaValueValid(marketplaceSchema, value) }).toEqual({
				label,
				schema: accepted,
			});
			expect({ label, parser: loadsIntact(value) }).toEqual({ label, parser: accepted });
		}
	});
});
