import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getDocsRsCacheDir, isEnoent, logger, ptree, tryParseJson, USER_AGENT } from "@oh-my-pi/pi-utils";
import { ToolAbortError } from "../../tools/tool-errors";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, MAX_BYTES } from "./types";

// --- Rustdoc JSON types (subset we care about) ---

interface RustdocCrate {
	root: number;
	crate_version: string | null;
	index: Record<string, RustdocItem>;
	paths: Record<string, { crate_id: number; path: string[]; kind: string }>;
	format_version: number;
}

interface RustdocItem {
	name: string | null;
	docs: string | null;
	attrs: string[];
	inner: Record<string, unknown>;
	visibility: string | { restricted: { parent: number; path: string } };
	deprecation: { since: string | null; note: string | null } | null;
}

interface FunctionData {
	sig: { inputs: [string, RustType][]; output: RustType | null };
	generics: Generics;
	has_body: boolean;
	is_async: boolean;
	is_unsafe: boolean;
	is_const: boolean;
}

interface Generics {
	params: GenericParam[];
	where_predicates: unknown[];
}

interface GenericParam {
	name: string;
	kind: Record<string, unknown>;
}

// Rustdoc type representation — a union encoded as single-key objects
type RustType = Record<string, unknown>;

// --- URL parsing ---

interface DocsRsTarget {
	crateName: string;
	version: string;
	/** e.g. "serde/de" for a submodule, "serde" for root */
	modulePath: string[];
	/** e.g. "struct", "trait", "fn", "enum", "macro", "type" */
	itemKind: string | null;
	/** e.g. "Serialize" */
	itemName: string | null;
}

function parseDocsRsUrl(url: string): DocsRsTarget | null {
	const parsed = new URL(url);
	if (parsed.hostname !== "docs.rs") return null;

	const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);

	// Skip /crate/{name}/{version} overview pages — those are docs.rs chrome, not rustdoc
	if (segments[0] === "crate") return null;

	// Rustdoc pages: /{crate}/{version}/{crate_path}/[item.html]
	// Minimum: /{crate}/{version}/{crate}
	if (segments.length < 3) return null;

	const crateName = segments[0];
	const version = segments[1]; // "latest", "1.0.228", etc.

	// The rest is the module path, possibly ending with an item page
	const rest = segments.slice(2);
	let itemKind: string | null = null;
	let itemName: string | null = null;

	const last = rest[rest.length - 1];
	// Item pages: struct.Foo.html, trait.Bar.html, fn.baz.html, etc.
	const itemMatch = last?.match(
		/^(struct|trait|fn|enum|macro|type|constant|static|attr|derive|union|primitive)\.(.+)\.html$/,
	);
	if (itemMatch) {
		itemKind = itemMatch[1];
		itemName = itemMatch[2];
		rest.pop();
	} else if (last === "index.html") {
		rest.pop();
	}

	return { crateName, version, modulePath: rest, itemKind, itemName };
}

// --- Type rendering ---

function renderType(ty: RustType | null | undefined, depth = 0): string {
	if (!ty || depth > 10) return "_";

	if (typeof ty === "string") return ty;

	if ("generic" in ty) return ty.generic as string;
	if ("primitive" in ty) return ty.primitive as string;
	if ("infer" in ty) return "_";

	if ("resolved_path" in ty) {
		const rp = ty.resolved_path as { path: string; args?: { angle_bracketed?: { args: unknown[] } } };
		const args = rp.args?.angle_bracketed?.args;
		if (args?.length) {
			const rendered = args
				.map((a: unknown) => {
					if (typeof a === "object" && a !== null && "type" in a)
						return renderType((a as { type: RustType }).type, depth + 1);
					if (typeof a === "object" && a !== null && "lifetime" in a)
						return `'${(a as { lifetime: string }).lifetime}`;
					return "_";
				})
				.join(", ");
			return `${rp.path}<${rendered}>`;
		}
		return rp.path;
	}

	if ("borrowed_ref" in ty) {
		const br = ty.borrowed_ref as { lifetime: string | null; is_mutable: boolean; type: RustType };
		const lt = br.lifetime ? `'${br.lifetime} ` : "";
		const mutStr = br.is_mutable ? "mut " : "";
		return `&${lt}${mutStr}${renderType(br.type, depth + 1)}`;
	}

	if ("tuple" in ty) {
		const items = (ty.tuple as RustType[]).map(t => renderType(t, depth + 1));
		return `(${items.join(", ")})`;
	}

	if ("slice" in ty) return `[${renderType(ty.slice as RustType, depth + 1)}]`;

	if ("array" in ty) {
		const arr = ty.array as { type: RustType; len: string };
		return `[${renderType(arr.type, depth + 1)}; ${arr.len}]`;
	}

	if ("raw_pointer" in ty) {
		const rp = ty.raw_pointer as { is_mutable: boolean; type: RustType };
		return `*${rp.is_mutable ? "mut" : "const"} ${renderType(rp.type, depth + 1)}`;
	}

	if ("qualified_path" in ty) {
		const qp = ty.qualified_path as { name: string; self_type: RustType; trait_: RustType | null };
		const self_ = renderType(qp.self_type, depth + 1);
		if (qp.trait_) return `<${self_} as ${renderType(qp.trait_, depth + 1)}>::${qp.name}`;
		return `${self_}::${qp.name}`;
	}

	if ("impl_trait" in ty) {
		const bounds = ty.impl_trait as Array<{ trait_bound?: { trait: RustType } }>;
		const parts = bounds
			.map(b => (b.trait_bound ? renderType(b.trait_bound.trait as RustType, depth + 1) : "?"))
			.join(" + ");
		return `impl ${parts}`;
	}

	if ("dyn_trait" in ty) {
		const dt = ty.dyn_trait as { traits: Array<{ trait: RustType }>; lifetime: string | null };
		const parts = dt.traits.map(t => renderType(t.trait as RustType, depth + 1)).join(" + ");
		const lt = dt.lifetime ? ` + '${dt.lifetime}` : "";
		return `dyn ${parts}${lt}`;
	}

	if ("function_pointer" in ty) return "fn(...)";

	return "_";
}

function renderGenerics(generics: Generics): string {
	if (!generics.params.length) return "";
	const params = generics.params.filter(p => p.kind && !("lifetime" in p.kind)).map(p => p.name);
	if (!params.length) return "";
	return `<${params.join(", ")}>`;
}

// --- Item rendering ---

function renderFunctionSig(name: string, fn_: FunctionData, generics?: Generics): string {
	const parts: string[] = [];
	if (fn_.is_const) parts.push("const");
	if (fn_.is_async) parts.push("async");
	if (fn_.is_unsafe) parts.push("unsafe");
	parts.push("fn");

	const gen = generics ? renderGenerics(generics) : renderGenerics(fn_.generics);
	const inputs = fn_.sig.inputs
		.map(([name, ty]) => {
			if (name === "self") return renderType(ty);
			return `${name}: ${renderType(ty)}`;
		})
		.join(", ");

	const output = fn_.sig.output ? ` -> ${renderType(fn_.sig.output)}` : "";
	return `${parts.join(" ")} ${name}${gen}(${inputs})${output}`;
}

function renderItemDecl(item: RustdocItem): string | null {
	const inner = item.inner;

	if ("function" in inner) {
		return renderFunctionSig(item.name ?? "?", inner.function as FunctionData);
	}

	if ("struct" in inner) {
		const s = inner.struct as { generics: Generics; kind: Record<string, unknown> };
		return `struct ${item.name}${renderGenerics(s.generics)}`;
	}

	if ("enum" in inner) {
		const e = inner.enum as { generics: Generics; variants: number[] };
		return `enum ${item.name}${renderGenerics(e.generics)}`;
	}

	if ("trait" in inner) {
		const t = inner.trait as { generics: Generics; is_auto: boolean; is_unsafe: boolean };
		const prefix = t.is_unsafe ? "unsafe " : "";
		return `${prefix}trait ${item.name}${renderGenerics(t.generics)}`;
	}

	if ("type_alias" in inner) {
		const ta = inner.type_alias as { generics: Generics; type: RustType | null };
		const ty = ta.type ? ` = ${renderType(ta.type)}` : "";
		return `type ${item.name}${renderGenerics(ta.generics)}${ty}`;
	}

	if ("macro_def" in inner) {
		return `macro ${item.name}!(...)`;
	}

	if ("constant" in inner) {
		const c = inner.constant as { type: RustType; value: string | null };
		return `const ${item.name}: ${renderType(c.type)}${c.value ? ` = ${c.value}` : ""}`;
	}

	return null;
}

function itemKindFromInner(inner: Record<string, unknown>): string {
	return Object.keys(inner)[0] ?? "unknown";
}

/**
 * Find an item by name in a module, following `use` re-exports.
 */
function findItemInModule(mod_: RustdocItem, name: string, index: Record<string, RustdocItem>): RustdocItem | null {
	const modData = mod_.inner?.module as { items: number[] } | undefined;
	if (!modData?.items) return null;

	for (const id of modData.items) {
		const item = index[String(id)];
		if (!item) continue;

		// Direct match
		if (item.name === name) return item;

		// Re-export: `pub use some::path::Name`
		if ("use" in item.inner) {
			const use_ = item.inner.use as { name: string; id: number | null };
			if (use_.name === name && use_.id != null) {
				const target = index[String(use_.id)];
				if (target) return target;
			}
		}
	}
	return null;
}

const DOCS_RS_CACHE_FILENAME = "rustdoc.json";

/** Hard ceiling for decompressed rustdoc JSON: a 50 MB compressed payload can
 *  expand far enough to block the event loop or OOM without a cap. Exceeding it
 *  throws (RangeError), which the fetch path converts to a `null` result. */
export const MAX_RUSTDOC_GUNZIP_BYTES = 256 * 1024 * 1024;

/** Decompress a docs.rs rustdoc gzip payload with the output-size cap applied.
 *  `maxOutputLength` is overridable only for tests exercising the cap contract. */
export function gunzipRustdocJson(compressed: Buffer, maxOutputLength: number = MAX_RUSTDOC_GUNZIP_BYTES): string {
	return gunzipSync(compressed, { maxOutputLength }).toString("utf-8");
}

function sanitizeCacheSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function getDocsRsCacheVersionSegment(version: string, now = new Date()): string {
	if (version !== "latest") return sanitizeCacheSegment(version);
	return now.toISOString().slice(0, 10);
}

function getDocsRsCachePath(target: DocsRsTarget, now = new Date()): string {
	const crate = sanitizeCacheSegment(target.crateName);
	const version = getDocsRsCacheVersionSegment(target.version, now);
	return path.join(getDocsRsCacheDir(), `docsrs_${crate}_${version}`, DOCS_RS_CACHE_FILENAME);
}

async function readCachedRustdocCrate(
	target: DocsRsTarget,
): Promise<{ crate: RustdocCrate; fetchedAt: string } | null> {
	const cachePath = getDocsRsCachePath(target);
	try {
		const [jsonStr, stat] = await Promise.all([Bun.file(cachePath).text(), fs.stat(cachePath)]);
		const crate = tryParseJson<RustdocCrate>(jsonStr);
		if (!crate?.index) return null;
		return { crate, fetchedAt: stat.mtime.toISOString() };
	} catch (err) {
		if (isEnoent(err)) return null;
		logger.warn("Failed to read docs.rs cache", { path: cachePath, error: String(err) });
		return null;
	}
}

async function writeCachedRustdocCrate(target: DocsRsTarget, json: string): Promise<void> {
	const cachePath = getDocsRsCachePath(target);
	try {
		await Bun.write(cachePath, json);
	} catch (err) {
		logger.warn("Failed to write docs.rs cache", { path: cachePath, error: String(err) });
	}
}

// --- Main handler ---

export const handleDocsRs: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	const target = parseDocsRsUrl(url);
	if (!target) return null;

	const cached = await readCachedRustdocCrate(target);
	if (cached) {
		const notes = ["Loaded from docs.rs rustdoc JSON cache"];
		let currentItem = cached.crate.index[String(cached.crate.root)];
		if (!currentItem) return null;

		const subPath = target.modulePath.slice(1);
		for (const seg of subPath) {
			const modData = currentItem.inner?.module as { items: number[] } | undefined;
			if (!modData?.items) return null;

			const child = modData.items
				.map(id => cached.crate.index[String(id)])
				.find(it => it?.name === seg && "module" in (it?.inner ?? {}));
			if (!child) return null;
			currentItem = child;
		}

		if (target.itemName) {
			const found = findItemInModule(currentItem, target.itemName, cached.crate.index);
			if (!found) return null;

			return buildResult(renderSingleItem(found, cached.crate.index, cached.crate), {
				url,
				method: "docs.rs",
				fetchedAt: cached.fetchedAt,
				notes,
			});
		}

		return buildResult(renderModule(currentItem, cached.crate.index, cached.crate, target), {
			url,
			method: "docs.rs",
			fetchedAt: cached.fetchedAt,
			notes,
		});
	}

	const fetchedAt = new Date().toISOString();
	const notes = ["Fetched via docs.rs rustdoc JSON"];

	// Fetch the rustdoc JSON (gzip variant for native Node decompression)
	const jsonUrl = `https://docs.rs/crate/${target.crateName}/${target.version}/json.gz`;

	let crate_: RustdocCrate | null;
	try {
		const requestSignal = ptree.combineSignals(signal, timeout * 1000);
		const response = await fetch(jsonUrl, {
			signal: requestSignal,
			headers: { "User-Agent": USER_AGENT, Accept: "application/gzip" },
			redirect: "follow",
		});
		if (!response.ok) return null;

		const reader = response.body?.getReader();
		if (!reader) return null;

		const chunks: Uint8Array[] = [];
		let totalSize = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalSize += value.length;
			if (totalSize > MAX_BYTES) {
				reader.cancel();
				break;
			}
		}

		const compressed = Buffer.concat(chunks);
		const jsonStr = gunzipRustdocJson(compressed);
		crate_ = tryParseJson<RustdocCrate>(jsonStr);
		if (crate_?.index) {
			await writeCachedRustdocCrate(target, jsonStr);
		}
	} catch {
		if (signal?.aborted) throw new ToolAbortError();
		return null;
	}
	if (!crate_?.index) return null;

	const index = crate_.index;

	// Find the target module by walking the module path
	let currentItem = index[String(crate_.root)];
	if (!currentItem) return null;

	// Walk into submodules (skip first segment which is the crate name itself)
	const subPath = target.modulePath.slice(1);
	for (const seg of subPath) {
		const modData = currentItem.inner?.module as { items: number[] } | undefined;
		if (!modData?.items) return null;

		const child = modData.items
			.map(id => index[String(id)])
			.find(it => it?.name === seg && "module" in (it?.inner ?? {}));
		if (!child) return null;
		currentItem = child;
	}

	// If looking for a specific item
	if (target.itemName) {
		const found = findItemInModule(currentItem, target.itemName, index);
		if (!found) return null;

		return buildResult(renderSingleItem(found, index, crate_), {
			url,
			method: "docs.rs",
			fetchedAt,
			notes,
		});
	}

	// Render the module view
	return buildResult(renderModule(currentItem, index, crate_, target), {
		url,
		method: "docs.rs",
		fetchedAt,
		notes,
	});
};

// --- Rendering ---

interface RustdocImplData {
	trait?: { path: string; args?: { angle_bracketed?: { args: unknown[] } } } | null;
	items: number[];
	is_synthetic?: boolean;
	blanket_impl?: RustType | null;
}

function renderImplTrait(trait_: NonNullable<RustdocImplData["trait"]>): string {
	return renderType({ resolved_path: { path: trait_.path, args: trait_.args } });
}

function collectInherentMethodLines(implIds: number[], index: Record<string, RustdocItem>): string[] {
	const methods: string[] = [];
	for (const implId of implIds) {
		const impl_ = index[String(implId)];
		if (!impl_ || !("impl" in impl_.inner)) continue;
		const implData = impl_.inner.impl as RustdocImplData;
		if (implData.is_synthetic || implData.trait || implData.blanket_impl) continue;
		for (const mId of implData.items ?? []) {
			const method = index[String(mId)];
			if (!method?.name || !("function" in method.inner)) continue;
			const fn_ = method.inner.function as FunctionData;
			const sig = renderFunctionSig(method.name, fn_);
			methods.push(`- \`${sig}\`${method.docs ? ` — ${firstLine(method.docs)}` : ""}`);
		}
	}
	return methods;
}

function collectExplicitTraitImplNames(implIds: number[], index: Record<string, RustdocItem>): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const implId of implIds) {
		const impl_ = index[String(implId)];
		if (!impl_ || !("impl" in impl_.inner)) continue;
		const implData = impl_.inner.impl as RustdocImplData;
		if (implData.is_synthetic || implData.blanket_impl || !implData.trait) continue;
		const name = renderImplTrait(implData.trait);
		if (!seen.has(name)) {
			seen.add(name);
			names.push(name);
		}
	}
	return names;
}

function renderSingleItem(item: RustdocItem, index: Record<string, RustdocItem>, crate_: RustdocCrate): string {
	let md = "";
	const decl = renderItemDecl(item);
	const kind = itemKindFromInner(item.inner);

	md += `# ${kind} ${item.name}\n\n`;
	if (item.deprecation) {
		const note = item.deprecation.note ? `: ${item.deprecation.note}` : "";
		md += `> **Deprecated**${note}\n\n`;
	}

	if (decl) md += `\`\`\`rust\n${decl}\n\`\`\`\n\n`;
	if (item.docs) md += `${item.docs}\n\n`;

	// For structs/enums/traits, show their methods and associated items
	if ("struct" in item.inner || "enum" in item.inner || "trait" in item.inner || "union" in item.inner) {
		const impls = (item.inner[kind] as { impls?: number[]; items?: number[] })?.impls ?? [];
		const traitItems = (item.inner[kind] as { items?: number[] })?.items ?? [];

		// Render direct trait items (for traits)
		if (traitItems.length > 0) {
			const required: string[] = [];
			const provided: string[] = [];

			for (const id of traitItems) {
				const child = index[String(id)];
				if (!child) continue;
				if ("function" in child.inner) {
					const fn_ = child.inner.function as FunctionData;
					const sig = renderFunctionSig(child.name ?? "?", fn_);
					const line = `- \`${sig}\`${child.docs ? ` — ${firstLine(child.docs)}` : ""}`;
					if (fn_.has_body) provided.push(line);
					else required.push(line);
				} else if ("assoc_type" in child.inner) {
					const line = `- \`type ${child.name}\`${child.docs ? ` — ${firstLine(child.docs)}` : ""}`;
					required.push(line);
				}
			}

			if (required.length) md += `## Required Methods\n\n${required.join("\n")}\n\n`;
			if (provided.length) md += `## Provided Methods\n\n${provided.join("\n")}\n\n`;
		}

		const methods = collectInherentMethodLines(impls, index);
		if (methods.length) {
			md += `## Methods\n\n${methods.join("\n")}\n\n`;
		}

		const traitImpls = collectExplicitTraitImplNames(impls, index);
		if (traitImpls.length) {
			md += `## Trait Implementations\n\n${traitImpls.map(t => `- ${t}`).join("\n")}\n\n`;
		}
	}

	// For enums, show variants
	if ("enum" in item.inner) {
		const variants = (item.inner.enum as { variants: number[] }).variants ?? [];
		const lines: string[] = [];
		for (const vId of variants) {
			const v = index[String(vId)];
			if (!v?.name) continue;
			lines.push(`- \`${v.name}\`${v.docs ? ` — ${firstLine(v.docs)}` : ""}`);
		}
		if (lines.length) md += `## Variants\n\n${lines.join("\n")}\n\n`;
	}

	if (crate_.crate_version) md += `---\n*${crate_.crate_version}*\n`;
	return md;
}

function renderModule(
	mod_: RustdocItem,
	index: Record<string, RustdocItem>,
	crate_: RustdocCrate,
	target: DocsRsTarget,
): string {
	let md = `# ${target.modulePath.join("::")}\n\n`;

	if (mod_.docs) md += `${mod_.docs}\n\n`;

	const modData = mod_.inner?.module as { items: number[] } | undefined;
	if (!modData?.items) return md;

	// Group items by kind, resolving re-exports
	const groups: Record<string, Array<{ name: string; docs: string; decl: string | null }>> = {};
	for (const id of modData.items) {
		let item = index[String(id)];
		if (!item) continue;

		// Resolve re-exports
		let displayName = item.name;
		if ("use" in item.inner) {
			const use_ = item.inner.use as { name: string; id: number | null };
			displayName = use_.name;
			if (use_.id != null) {
				const resolved = index[String(use_.id)];
				if (resolved) item = resolved;
				else continue;
			} else continue;
		}

		if (!displayName) continue;
		// Skip private/hidden items
		if (item.visibility === "crate" || (typeof item.visibility === "object" && "restricted" in item.visibility))
			continue;

		const kind = itemKindFromInner(item.inner);
		if (!groups[kind]) groups[kind] = [];
		groups[kind].push({
			name: displayName,
			docs: firstLine(item.docs ?? ""),
			decl: renderItemDecl(item),
		});
	}

	const kindOrder = ["module", "macro_def", "struct", "enum", "trait", "function", "type_alias", "constant", "static"];
	const kindLabels: Record<string, string> = {
		module: "Modules",
		macro_def: "Macros",
		struct: "Structs",
		enum: "Enums",
		trait: "Traits",
		function: "Functions",
		type_alias: "Type Aliases",
		constant: "Constants",
		static: "Statics",
		union: "Unions",
	};

	for (const kind of kindOrder) {
		const items = groups[kind];
		if (!items?.length) continue;
		md += `## ${kindLabels[kind] ?? kind}\n\n`;
		for (const item of items) {
			if (item.decl && kind === "function") {
				md += `- \`${item.decl}\`${item.docs ? ` — ${item.docs}` : ""}\n`;
			} else {
				md += `- **${item.name}**${item.docs ? ` — ${item.docs}` : ""}\n`;
			}
		}
		md += "\n";
	}

	if (crate_.crate_version) md += `---\n*${crate_.crate_version}*\n`;
	return md;
}

function firstLine(s: string): string {
	const line = s.split("\n")[0].trim();
	return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
