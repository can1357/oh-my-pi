import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import {
	calculateCost,
	getBundledModel,
	getBundledModels,
	getBundledProviders,
	modelsAreEqual,
} from "@oh-my-pi/pi-catalog/models";
import { Type as TypeBoxShimType } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import {
	__resetLegacyPiResolutionCache,
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// pi-ai 15.1.0 removed the runtime `Type` export from `@oh-my-pi/pi-ai`'s
// package root. Legacy extensions (and their aliased-scope variants such as
// `@earendil-works/pi-ai`) still author parameter schemas as
// `import { Type } from "@earendil-works/pi-ai"` and then `Type.Object(...)`.
// `legacy-pi-compat.ts` patches that gap by redirecting bare pi-ai root
// imports through `legacy-pi-ai-shim.ts`, which re-exports the canonical
// pi-ai surface plus the Zod-backed `Type` runtime from the same TypeBox shim
// `@sinclair/typebox` is served from.
installLegacyPiSpecifierShim();

const tempRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

async function writeFixtureExtension(source: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pi-ai-type-remap-"));
	tempRoots.push(dir);
	const entry = path.join(dir, "index.ts");
	await fs.writeFile(entry, source, "utf8");
	return entry;
}

describe("legacy-pi @(scope)/pi-ai root `Type` remap (issue #1437)", () => {
	it('redirects `import { Type } from "@earendil-works/pi-ai"` to the TypeBox shim', async () => {
		const entry = await writeFixtureExtension(
			[
				'import { Type } from "@earendil-works/pi-ai";',
				"export const probe = Type;",
				"export const schema = Type.Object({ name: Type.String() }, { additionalProperties: false });",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			probe: typeof TypeBoxShimType;
			schema: { safeParse: (input: unknown) => { success: boolean } };
		};

		expect(loaded.probe).toBe(TypeBoxShimType);
		expect(loaded.schema.safeParse({ name: "ok" }).success).toBe(true);
		expect(loaded.schema.safeParse({}).success).toBe(false);
		expect(loaded.schema.safeParse({ name: "ok", extra: 1 }).success).toBe(false);
	});

	it("redirects the legacy pi-ai compat entrypoint through the root compatibility shim", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { StringEnum, complete, type Model } from "@earendil-works/pi-ai/compat";',
				'export const schema = StringEnum(["red", "green"] as const);',
				"export const completeType = typeof complete;",
				"export type LegacyModel = Model;",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			schema: { safeParse: (input: unknown) => { success: boolean } };
			completeType: string;
		};
		expect(loaded.schema.safeParse("red").success).toBe(true);
		expect(loaded.schema.safeParse("blue").success).toBe(false);
		expect(loaded.completeType).toBe("function");
	});

	it('redirects `import { Type } from "@oh-my-pi/pi-ai"` for plugins published against the canonical scope', async () => {
		const entry = await writeFixtureExtension(
			['import { Type } from "@oh-my-pi/pi-ai";', "export const probe = Type;"].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as { probe: typeof TypeBoxShimType };
		expect(loaded.probe).toBe(TypeBoxShimType);
	});

	it("does not redirect subpath imports such as @oh-my-pi/pi-ai/utils/schema", async () => {
		const entry = await writeFixtureExtension(
			[
				// `arkToWireSchema` is only exported from the subpath, not the root,
				// so a successful import proves the subpath still resolves directly
				// against the bundled pi-ai package rather than the shim.
				'import { arkToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";',
				"export const fn = arkToWireSchema;",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as { fn: unknown };
		expect(typeof loaded.fn).toBe("function");
	});

	it("re-exports the legacy model catalog and schema helpers from the root", async () => {
		const loaded = (await loadLegacyPiModule(
			await writeFixtureExtension(
				[
					'import { calculateCost, clampThinkingLevel, getBundledModel, getBundledModels, getBundledProviders, getModel, getModels, modelsAreEqual, StringEnum } from "@oh-my-pi/pi-ai";',
					"export const helpers = { calculateCost, getBundledModel, getBundledModels, getBundledProviders, getModel, getModels, modelsAreEqual };",
					"export const supported = clampThinkingLevel({ reasoning: true, thinking: { efforts: ['low', 'high'] } }, 'high');",
					"export const disabled = clampThinkingLevel({ reasoning: false }, 'high');",
					'export const schema = StringEnum(["red", "green"] as const, { description: "primary colors" });',
				].join("\n"),
			),
		)) as {
			helpers: {
				calculateCost: unknown;
				getBundledModel: unknown;
				getBundledModels: unknown;
				getBundledProviders: unknown;
				getModel: unknown;
				getModels: unknown;
				modelsAreEqual: unknown;
			};
			supported: string;
			disabled: string;
			schema: { safeParse: (input: unknown) => { success: boolean }; toJSON?: () => any };
		};

		expect(loaded.helpers.calculateCost).toBe(calculateCost);
		expect(loaded.helpers.getModel).toBe(getBundledModel);
		expect(loaded.helpers.getModels).toBe(getBundledModels);
		expect(loaded.helpers.getBundledModel).toBe(getBundledModel);
		expect(loaded.helpers.getBundledModels).toBe(getBundledModels);
		expect(loaded.helpers.getBundledProviders).toBe(getBundledProviders);
		expect(loaded.helpers.modelsAreEqual).toBe(modelsAreEqual);
		expect(loaded.supported).toBe("high");
		expect(loaded.disabled).toBe("off");
		expect(loaded.schema.safeParse("red").success).toBe(true);
		expect(loaded.schema.safeParse("blue").success).toBe(false);
		expect(loaded.schema.toJSON?.()?.description).toBe("primary colors");
	});

	it("exports isRetryableAssistantError for legacy retry classification (issue #6847)", async () => {
		// `@earendil-works/pi-ai@0.82.x` exports isRetryableAssistantError from its
		// package root (utils/retry.js). Plugins such as
		// `@router-for-me/pi-cliproxyapi-provider` (>=1.4.9) import it, so a missing
		// shim export surfaced as a plain
		// `Export named 'isRetryableAssistantError' not found` at validation time.
		const loaded = (await loadLegacyPiModule(
			await writeFixtureExtension(
				[
					'import { isRetryableAssistantError } from "@earendil-works/pi-ai";',
					'const err = errorMessage => ({ role: "assistant", stopReason: "error", errorMessage });',
					'export const transient = isRetryableAssistantError(err("upstream connect error"));',
					'export const quota = isRetryableAssistantError(err("insufficient_quota"));',
					'export const ok = isRetryableAssistantError({ role: "assistant", stopReason: "stop" });',
				].join("\n"),
			),
		)) as { transient: boolean; quota: boolean; ok: boolean };

		expect(loaded.transient).toBe(true);
		expect(loaded.quota).toBe(false);
		expect(loaded.ok).toBe(false);
	});
});

describe("legacy pi package root remaps (issue #1474)", () => {
	it("loads @earendil-works/pi-coding-agent root imports when host package resolution is unavailable", async () => {
		const realResolveSync = Bun.resolveSync.bind(Bun);
		vi.spyOn(Bun, "resolveSync").mockImplementation((specifier: string, from: string) => {
			if (specifier === "@oh-my-pi/pi-coding-agent" && from.endsWith(path.join("src", "extensibility", "plugins"))) {
				throw new Error("compiled binary host package resolution unavailable");
			}
			return realResolveSync(specifier, from);
		});
		const entry = await writeFixtureExtension(
			['import { VERSION } from "@earendil-works/pi-coding-agent";', "export const loadedVersion = VERSION;"].join(
				"\n",
			),
		);

		const loaded = (await loadLegacyPiModule(entry)) as { loadedVersion: string };
		expect(loaded.loadedVersion).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("loads pi-vimmode's minified legacy imports", async () => {
		const entry = await writeFixtureExtension(
			[
				'import{CustomEditor,copyToClipboard}from"@earendil-works/pi-coding-agent";',
				'import{CURSOR_MARKER,decodeKittyPrintable,matchesKey,parseKey,truncateToWidth,visibleWidth}from"@earendil-works/pi-tui";',
				"export const apiTypes=[typeof CustomEditor,typeof copyToClipboard,typeof CURSOR_MARKER,typeof decodeKittyPrintable,typeof matchesKey,typeof parseKey,typeof truncateToWidth,typeof visibleWidth];",
				'export const printable=decodeKittyPrintable("\\x1b[97u");',
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as { apiTypes: string[]; printable: string };
		expect(loaded.apiTypes).toEqual([
			"function",
			"function",
			"string",
			"function",
			"function",
			"function",
			"function",
			"function",
		]);
		expect(loaded.printable).toBe("a");
	});

	it("loads pi-sprite's legacy terminal helpers", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { deleteAllKittyImages, deleteKittyImage, getCapabilities } from "@earendil-works/pi-tui";',
				"export const deleteOne = deleteKittyImage(42);",
				"export const deleteAll = deleteAllKittyImages();",
				"export const capabilities = getCapabilities();",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			deleteOne: string;
			deleteAll: string;
			capabilities: { images: "kitty" | "iterm2" | null; trueColor: boolean; hyperlinks: boolean };
		};
		// Bare sequences, exactly like upstream Pi: legacy callers (pi-sprite)
		// apply their own tmux passthrough wrapping.
		expect(loaded.deleteOne).toBe("\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		expect(loaded.deleteAll).toBe("\x1b_Ga=d,d=A,q=2\x1b\\");
		expect(["kitty", "iterm2", null]).toContain(loaded.capabilities.images);
		expect(typeof loaded.capabilities.trueColor).toBe("boolean");
		expect(typeof loaded.capabilities.hyperlinks).toBe("boolean");
	});

	it("preserves legacy defineTool root imports and usable coding tools", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-coding-tools-"));
		tempRoots.push(dir);
		await fs.writeFile(path.join(dir, "sample.txt"), "legacy read body", "utf8");
		const entry = path.join(dir, "index.ts");
		await fs.writeFile(
			entry,
			[
				'import { dirname } from "node:path";',
				'import { fileURLToPath } from "node:url";',
				'import { createCodingTools, defineTool, Type } from "@earendil-works/pi-coding-agent";',
				"const definition = {",
				'\tname: "legacy_define_tool",',
				'\tlabel: "Legacy Define Tool",',
				'\tdescription: "legacy helper probe",',
				"\tparameters: Type.Object({}),",
				'\texecute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
				"};",
				"const cwd = dirname(fileURLToPath(import.meta.url));",
				"const codingTools = createCodingTools(cwd);",
				"const readTool = codingTools.find(tool => tool.name === 'read');",
				"export const tool = defineTool(definition);",
				"export const sameReference = tool === definition;",
				"export const codingToolNames = codingTools.map(tool => tool.name);",
				"export const readResult = await readTool?.execute('legacy-read', { path: 'sample.txt' });",
			].join("\n"),
			"utf8",
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			tool: { name: string; parameters: { safeParse: (input: unknown) => { success: boolean } } };
			sameReference: boolean;
			codingToolNames: string[];
			readResult: { content: Array<{ type: string; text?: string }> };
		};

		expect(loaded.sameReference).toBe(true);
		expect(loaded.tool.name).toBe("legacy_define_tool");
		expect(loaded.codingToolNames).toEqual(["read", "bash", "edit", "write"]);
		expect(loaded.readResult.content[0]?.text).toContain("legacy read body");
	});

	it("preserves legacy frontmatter helper root imports", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";',
				"const content = ['---', 'name: demo', '---', '# Body'].join('\\n');",
				"export const parsed = parseFrontmatter(content);",
				"export const stripped = stripFrontmatter(content);",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			parsed: { frontmatter: { name?: string }; body: string };
			stripped: string;
		};

		expect(loaded.parsed.frontmatter.name).toBe("demo");
		expect(loaded.parsed.body).toBe("# Body");
		expect(loaded.stripped).toBe("# Body");
	});

	it("falls back to legacy-scoped subpath peers for direct plugin imports", async () => {
		const realResolveSync = Bun.resolveSync.bind(Bun);
		vi.spyOn(Bun, "resolveSync").mockImplementation((specifier: string, from: string) => {
			if (specifier === "@oh-my-pi/pi-ai/oauth") {
				throw new Error(`canonical peer unavailable from ${from}`);
			}
			return realResolveSync(specifier, from);
		});

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-direct-subpath-"));
		tempRoots.push(dir);
		const packageDir = path.join(dir, "node_modules", "@mariozechner", "pi-ai");
		await fs.mkdir(packageDir, { recursive: true });
		await fs.writeFile(
			path.join(packageDir, "package.json"),
			JSON.stringify({ type: "module", exports: { "./oauth": "./oauth.js" } }),
			"utf8",
		);
		await fs.writeFile(path.join(packageDir, "oauth.js"), 'export const marker = "legacy-oauth";', "utf8");
		const entry = path.join(dir, "index.ts");
		await fs.writeFile(
			entry,
			['import { marker } from "@mariozechner/pi-ai/oauth";', "export const loadedMarker = marker;"].join("\n"),
			"utf8",
		);

		const loaded = (await import(`${url.pathToFileURL(entry).href}?nonce=${Date.now()}`)) as {
			loadedMarker: string;
		};
		expect(loaded.loadedMarker).toBe("legacy-oauth");
	});

	it("routes @earendil-works/pi-utils through canonical Bun.resolveSync in non-compiled mode", async () => {
		// Regression: when omp runs from a node_modules install (not the monorepo
		// and not a compiled binary), the bundled packages live at
		// `node_modules/@oh-my-pi/pi-*`, not next to the source tree. Hardcoding
		// a sibling `packages/<pkg>/src/index.ts` path would miss them, so the
		// non-compiled branch must delegate to `Bun.resolveSync` against the
		// canonical specifier.
		// The resolver memoizes canonical lookups process-wide; clear it so this
		// assertion observes the Bun.resolveSync delegation rather than a warm
		// cache populated by an earlier test in the full suite.
		__resetLegacyPiResolutionCache();
		const realResolveSync = Bun.resolveSync.bind(Bun);
		let canonicalLookupSeen = false;
		vi.spyOn(Bun, "resolveSync").mockImplementation((specifier: string, from: string) => {
			if (specifier === "@oh-my-pi/pi-utils") {
				canonicalLookupSeen = true;
			}
			return realResolveSync(specifier, from);
		});
		const entry = await writeFixtureExtension(
			[
				'import { isCompiledBinary } from "@earendil-works/pi-utils";',
				"export const probe = isCompiledBinary;",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as { probe: () => boolean };
		expect(typeof loaded.probe).toBe("function");
		expect(canonicalLookupSeen).toBe(true);
	});
});
