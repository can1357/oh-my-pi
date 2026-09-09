/**
 * Cleanup-loop discovery scanner. Feeds the `/cleanup` command's Discover phase
 * with ranked, machine-generated candidates so each iteration starts from
 * evidence instead of ad-hoc grepping.
 *
 * Reports (all heuristic — candidates, not proofs):
 *   clones         near-duplicate code regions (normalized line-window hashing)
 *   god-objects    oversized multi-responsibility files (LOC, exports, class methods)
 *   junk-drawers   domain-less modules (utils/helpers/misc/common) accreting code
 *   dead-exports   exported symbols with zero references elsewhere in the repo,
 *                  tiered by exports-map exposure (barrel-public / wildcard-only)
 *   deep-imports   files importing via ../../.. (wrong-home signal)
 *   check-density  defensive-check hotspots (as-casts, ?., ??, typeof re-narrowing)
 *
 * Usage: bun scripts/cleanup-scan.ts [--json] [--top=N] [--pkg=ai,utils|all]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ts } from "@ts-morph/common";

const DEFAULT_PKGS = ["coding-agent", "ai", "catalog", "utils"];
const EXCLUDE = /(-gen\/|\/vendor\/|\.d\.ts$|\.test\.ts$|__tests__\/|\/fixtures\/|\/snapshots\/)/;
const JUNK_NAME = /(^|[-_.])(utils?|helpers?|misc|common)\.ts$/;
const CLONE_WINDOW = 7;

interface FileInfo {
	/** Repo-relative path. */
	rel: string;
	pkg: string;
	text: string;
	lines: string[];
	/** Non-blank line count. */
	loc: number;
	/** Locally declared exported symbol names (excludes re-exports). */
	exportedNames: string[];
	/** `export * from` specifiers (relative only). */
	exportStar: string[];
	/** `export { a, b } from` re-exports: name → specifier. */
	namedReexports: { name: string; from: string }[];
	classes: { name: string; methods: number }[];
	topLevelStatements: number;
	deepImports: number;
	checks: { asCasts: number; optChain: number; coalesce: number; typeofNarrow: number; isArray: number };
}

interface CloneRegion {
	rel: string;
	startLine: number;
	endLine: number;
}

const args = new Map<string, string>();
for (const a of Bun.argv.slice(2)) {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	if (m) args.set(m[1], m[2] ?? "true");
}
const asJson = args.get("json") === "true";
const top = Number(args.get("top") ?? 20);
const pkgArg = args.get("pkg");

async function listPackages(): Promise<string[]> {
	if (pkgArg && pkgArg !== "all") return pkgArg.split(",");
	if (pkgArg === "all") {
		const entries = await fs.readdir("packages", { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => e.name);
	}
	return DEFAULT_PKGS;
}

function parseFile(rel: string, pkg: string, text: string): FileInfo {
	const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
	const info: FileInfo = {
		rel,
		pkg,
		text,
		lines: text.split("\n"),
		loc: 0,
		exportedNames: [],
		exportStar: [],
		namedReexports: [],
		classes: [],
		topLevelStatements: sf.statements.length,
		deepImports: 0,
		checks: { asCasts: 0, optChain: 0, coalesce: 0, typeofNarrow: 0, isArray: 0 },
	};
	for (const line of info.lines) if (line.trim().length > 0) info.loc++;

	const hasExport = (node: ts.HasModifiers): boolean =>
		!!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);

	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
			if (stmt.moduleSpecifier.text.startsWith("../../..")) info.deepImports++;
			continue;
		}
		if (ts.isExportDeclaration(stmt)) {
			const spec = stmt.moduleSpecifier;
			if (spec && ts.isStringLiteral(spec) && spec.text.startsWith(".")) {
				if (!stmt.exportClause) info.exportStar.push(spec.text);
				else if (ts.isNamedExports(stmt.exportClause))
					for (const el of stmt.exportClause.elements)
						info.namedReexports.push({ name: el.name.text, from: spec.text });
			} else if (!spec && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
				for (const el of stmt.exportClause.elements) info.exportedNames.push(el.name.text);
			}
			continue;
		}
		if (ts.isClassDeclaration(stmt)) {
			let methods = 0;
			for (const m of stmt.members)
				if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) methods++;
			info.classes.push({ name: stmt.name?.text ?? "<anon>", methods });
			if (stmt.name && hasExport(stmt)) info.exportedNames.push(stmt.name.text);
			continue;
		}
		if (
			(ts.isFunctionDeclaration(stmt) ||
				ts.isInterfaceDeclaration(stmt) ||
				ts.isTypeAliasDeclaration(stmt) ||
				ts.isEnumDeclaration(stmt) ||
				ts.isModuleDeclaration(stmt)) &&
			hasExport(stmt) &&
			stmt.name &&
			ts.isIdentifier(stmt.name)
		) {
			info.exportedNames.push(stmt.name.text);
			continue;
		}
		if (ts.isVariableStatement(stmt) && hasExport(stmt)) {
			for (const decl of stmt.declarationList.declarations)
				if (ts.isIdentifier(decl.name)) info.exportedNames.push(decl.name.text);
		}
	}

	const t = text;
	info.checks.asCasts = (t.match(/\sas\s+(any|unknown|[A-Z][\w.]*)/g) ?? []).length;
	info.checks.optChain = (t.match(/\?\./g) ?? []).length;
	info.checks.coalesce = (t.match(/\?\?/g) ?? []).length;
	info.checks.typeofNarrow = (t.match(/\btypeof\s+[\w$.]+\s*[!=]==?/g) ?? []).length;
	info.checks.isArray = (t.match(/Array\.isArray\(/g) ?? []).length;
	return info;
}

/** Normalized significant lines for clone hashing: [normalizedText, originalLineNo][]. */
function significantLines(info: FileInfo): [string, number][] {
	const out: [string, number][] = [];
	let inBlock = false;
	for (let i = 0; i < info.lines.length; i++) {
		let line = info.lines[i];
		if (inBlock) {
			const end = line.indexOf("*/");
			if (end === -1) continue;
			line = line.slice(end + 2);
			inBlock = false;
		}
		const blockStart = line.indexOf("/*");
		if (blockStart !== -1 && !line.includes("*/", blockStart)) {
			line = line.slice(0, blockStart);
			inBlock = true;
		}
		line = line
			.replace(/(^|\s)\/\/.*$/, "$1")
			.trim()
			.replace(/`(?:[^`\\]|\\.)*`/g, '"S"')
			.replace(/"(?:[^"\\]|\\.)*"/g, '"S"')
			.replace(/'(?:[^'\\]|\\.)*'/g, '"S"')
			.replace(/\b\d[\d._]*\b/g, "0")
			.replace(/\s+/g, " ");
		if (line.length < 6) continue;
		if (/^(import\b|export \{[^}]*\} from|export \* from)/.test(line)) continue;
		out.push([line, i + 1]);
	}
	return out;
}

class UnionFind {
	#parent = new Map<number, number>();
	find(x: number): number {
		let r = this.#parent.get(x) ?? x;
		if (r !== x) {
			r = this.find(r);
			this.#parent.set(x, r);
		}
		return r;
	}
	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.#parent.set(ra, rb);
	}
}

/** Detect duplicated regions via hashed sliding windows + union-find chaining. */
function detectClones(files: FileInfo[]): { regions: CloneRegion[]; sigLines: number }[] {
	const sig = files.map(significantLines);
	const byHash = new Map<number | bigint, number[]>(); // encoded position = fileIdx * 2^24 + windowIdx
	const POS = 1 << 24;
	for (let f = 0; f < files.length; f++) {
		const s = sig[f];
		for (let i = 0; i + CLONE_WINDOW <= s.length; i++) {
			const h = Bun.hash(
				s
					.slice(i, i + CLONE_WINDOW)
					.map(x => x[0])
					.join("\n"),
			);
			let list = byHash.get(h);
			if (!list) {
				list = [];
				byHash.set(h, list);
			}
			list.push(f * POS + i);
		}
	}
	const uf = new UnionFind();
	const matched = new Set<number>();
	for (const list of byHash.values()) {
		if (list.length < 2) continue;
		for (const pos of list) {
			matched.add(pos);
			uf.union(list[0], pos);
		}
	}
	for (const pos of matched) if (matched.has(pos + 1)) uf.union(pos, pos + 1);

	const clusters = new Map<number, number[]>();
	for (const pos of matched) {
		const root = uf.find(pos);
		let list = clusters.get(root);
		if (!list) {
			list = [];
			clusters.set(root, list);
		}
		list.push(pos);
	}

	const results: { regions: CloneRegion[]; sigLines: number }[] = [];
	for (const positions of clusters.values()) {
		// Merge window positions into per-file line intervals.
		const perFile = new Map<number, number[]>();
		for (const pos of positions) {
			const f = Math.floor(pos / POS);
			let list = perFile.get(f);
			if (!list) {
				list = [];
				perFile.set(f, list);
			}
			list.push(pos % POS);
		}
		const regions: CloneRegion[] = [];
		let sigLines = 0;
		for (const [f, idxs] of perFile) {
			idxs.sort((a, b) => a - b);
			let start = idxs[0];
			let prev = idxs[0];
			const flush = (endIdx: number) => {
				const s = sig[f];
				regions.push({ rel: files[f].rel, startLine: s[start][1], endLine: s[endIdx + CLONE_WINDOW - 1][1] });
				sigLines += endIdx + CLONE_WINDOW - start;
			};
			for (let k = 1; k < idxs.length; k++) {
				if (idxs[k] > prev + CLONE_WINDOW) {
					flush(prev);
					start = idxs[k];
				}
				prev = idxs[k];
			}
			flush(prev);
		}
		if (regions.length < 2) continue;
		results.push({ regions, sigLines });
	}
	return results.sort((a, b) => b.sigLines - a.sigLines);
}

/** Resolve a relative re-export specifier to a repo-relative .ts path. */
function resolveSpecifier(fromRel: string, spec: string, known: Set<string>): string | null {
	const base = path.join(path.dirname(fromRel), spec);
	for (const cand of [base, `${base}.ts`, path.join(base, "index.ts")]) {
		const norm = cand.replaceAll("\\", "/");
		if (known.has(norm)) return norm;
	}
	return null;
}

/**
 * Public-surface tiers from package.json exports maps.
 * Explicit (non-wildcard) entries + their `export *` closure = barrel-public.
 * Wildcard patterns (`./*`) technically expose everything; tracked separately.
 */
async function computePublicSurface(pkgs: string[], byRel: Map<string, FileInfo>) {
	const barrelFiles = new Set<string>();
	const barrelNames = new Map<string, Set<string>>(); // file → names made public via named re-export
	for (const pkg of pkgs) {
		let exportsMap: Record<string, unknown>;
		try {
			const pkgJson: { exports?: Record<string, unknown> } = await Bun.file(`packages/${pkg}/package.json`).json();
			exportsMap = pkgJson.exports ?? {};
		} catch {
			continue;
		}
		const queue: string[] = [];
		for (const key in exportsMap) {
			if (key.includes("*")) continue;
			const value = exportsMap[key];
			let target: string | undefined;
			if (typeof value === "string") target = value;
			else if (value && typeof value === "object" && "import" in value && typeof value.import === "string")
				target = value.import;
			if (!target?.endsWith(".ts")) continue;
			const rel = path.join("packages", pkg, target).replaceAll("\\", "/");
			if (byRel.has(rel)) queue.push(rel);
		}
		const known = new Set(byRel.keys());
		for (let rel = queue.pop(); rel !== undefined; rel = queue.pop()) {
			if (barrelFiles.has(rel)) continue;
			barrelFiles.add(rel);
			const info = byRel.get(rel);
			if (!info) continue;
			for (const spec of info.exportStar) {
				const target = resolveSpecifier(rel, spec, known);
				if (target) queue.push(target);
			}
			for (const re of info.namedReexports) {
				const target = resolveSpecifier(rel, re.from, known);
				if (!target) continue;
				let names = barrelNames.get(target);
				if (!names) {
					names = new Set();
					barrelNames.set(target, names);
				}
				names.add(re.name);
			}
		}
	}
	return { barrelFiles, barrelNames };
}

async function main() {
	const pkgs = await listPackages();
	const scanFiles: FileInfo[] = [];
	const byRel = new Map<string, FileInfo>();

	// Reference corpus = every TS file in the repo (including tests/scripts),
	// so dead-export candidacy sees all in-repo consumers.
	const corpusIdents = new Map<string, Set<string>>(); // identifier → referencing rel paths
	const glob = new Bun.Glob("**/*.ts");
	const corpusRoots = ["packages", "scripts"];
	for (const root of corpusRoots) {
		for await (const p of glob.scan({ cwd: root, onlyFiles: true })) {
			const rel = `${root}/${p}`.replaceAll("\\", "/");
			if (rel.includes("node_modules/") || /(-gen\/|\/vendor\/)/.test(rel)) continue;
			const text = await Bun.file(rel).text();
			const isTest = /(\.test\.ts$|__tests__\/)/.test(rel);
			for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
				const name = m[0];
				if (name.length < 3) continue;
				let set = corpusIdents.get(name);
				if (!set) {
					set = new Set();
					corpusIdents.set(name, set);
				}
				set.add(isTest ? `test:${rel}` : rel);
			}
			const inScope = !EXCLUDE.test(rel) && pkgs.some(pkg => rel.startsWith(`packages/${pkg}/src/`));
			if (inScope) {
				const pkg = rel.split("/")[1];
				const info = parseFile(rel, pkg, text);
				scanFiles.push(info);
				byRel.set(rel, info);
			}
		}
	}

	const { barrelFiles, barrelNames } = await computePublicSurface(pkgs, byRel);

	// God objects: rank by LOC, annotate structure.
	const godObjects = scanFiles
		.filter(f => f.loc >= 800)
		.sort((a, b) => b.loc - a.loc)
		.slice(0, top)
		.map(f => ({
			file: f.rel,
			loc: f.loc,
			exports: f.exportedNames.length,
			topLevelStatements: f.topLevelStatements,
			classes: f.classes.filter(c => c.methods >= 10).sort((a, b) => b.methods - a.methods),
			godScore: Math.round(
				f.loc * (1 + f.exportedNames.length / 20 + Math.max(0, ...f.classes.map(c => c.methods)) / 30),
			),
		}))
		.sort((a, b) => b.godScore - a.godScore);

	// Clones.
	const clones = detectClones(scanFiles)
		.filter(c => c.sigLines >= 2 * CLONE_WINDOW)
		.slice(0, top)
		.map(c => ({
			duplicatedSigLines: c.sigLines,
			regions: c.regions.map(r => `${r.rel}:${r.startLine}-${r.endLine}`),
		}));

	// Junk drawers.
	const junkDrawers = scanFiles
		.filter(f => JUNK_NAME.test(f.rel) || /\/(utils|helpers)\//.test(f.rel))
		.map(f => ({ file: f.rel, loc: f.loc, exports: f.exportedNames.length }))
		.sort((a, b) => b.loc - a.loc)
		.slice(0, top);

	// Dead-export candidates.
	const deadExports: {
		file: string;
		name: string;
		tier: "barrel-public" | "wildcard-only";
		testOnly: boolean;
	}[] = [];
	for (const f of scanFiles) {
		const publicNames = barrelNames.get(f.rel);
		for (const name of f.exportedNames) {
			const refs = corpusIdents.get(name);
			if (!refs) continue;
			const others = [...refs].filter(r => r !== f.rel && r !== `test:${f.rel}`);
			if (others.some(r => !r.startsWith("test:"))) continue;
			deadExports.push({
				file: f.rel,
				name,
				tier: barrelFiles.has(f.rel) || publicNames?.has(name) ? "barrel-public" : "wildcard-only",
				testOnly: others.length > 0,
			});
		}
	}
	deadExports.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

	// Deep imports.
	const deepImports = scanFiles
		.filter(f => f.deepImports > 0)
		.map(f => ({ file: f.rel, count: f.deepImports }))
		.sort((a, b) => b.count - a.count)
		.slice(0, top);

	// Defensive-check density (per 100 LOC, min 150 LOC).
	const checkDensity = scanFiles
		.filter(f => f.loc >= 150)
		.map(f => {
			const total =
				f.checks.asCasts + f.checks.optChain + f.checks.coalesce + f.checks.typeofNarrow + f.checks.isArray;
			return { file: f.rel, loc: f.loc, per100: Math.round((total / f.loc) * 1000) / 10, ...f.checks };
		})
		.sort((a, b) => b.per100 - a.per100)
		.slice(0, top);

	const report = { godObjects, clones, junkDrawers, deadExports, deepImports, checkDensity };
	if (asJson) {
		console.log(JSON.stringify(report, null, 1));
		return;
	}

	const lines: string[] = [];
	lines.push(`# cleanup-scan — packages: ${pkgs.join(", ")} (${scanFiles.length} files)`);
	lines.push("\n## God-object candidates (LOC ≥ 800, ranked by size × structure)");
	for (const g of godObjects) {
		const cls = g.classes.map(c => `${c.name}:${c.methods}m`).join(" ");
		lines.push(
			`- ${g.file} — ${g.loc} loc, ${g.exports} exports, ${g.topLevelStatements} top-level stmts${cls ? `, big classes: ${cls}` : ""}`,
		);
	}
	lines.push("\n## Clone clusters (normalized, ≥2 regions; savings ≈ dup lines × (regions−1))");
	for (const c of clones) {
		lines.push(`- ~${c.duplicatedSigLines} dup lines across ${c.regions.length} regions:`);
		for (const r of c.regions.slice(0, 6)) lines.push(`    ${r}`);
		if (c.regions.length > 6) lines.push(`    … ${c.regions.length - 6} more`);
	}
	lines.push("\n## Junk drawers (domain-less names; sanctioned central utils are fine — judge contents)");
	for (const j of junkDrawers) lines.push(`- ${j.file} — ${j.loc} loc, ${j.exports} exports`);
	lines.push(
		"\n## Dead-export candidates (zero non-test refs in repo — CANDIDATES ONLY, prove with lsp + barrel trace)",
	);
	lines.push("   barrel-public = re-exported via explicit entry point: PROTECTED, do not delete.");
	lines.push("   wildcard-only = deep-importable only: deletable if lsp references confirms.");
	for (const d of deadExports)
		lines.push(`- [${d.tier}]${d.testOnly ? "[test-only-refs]" : ""} ${d.file} → ${d.name}`);
	lines.push("\n## Deep relative imports (../../.. — module likely lives in the wrong place)");
	for (const d of deepImports) lines.push(`- ${d.file} — ${d.count} imports`);
	lines.push("\n## Defensive-check density (as-casts + ?. + ?? + typeof-narrow + isArray per 100 loc)");
	for (const c of checkDensity)
		lines.push(
			`- ${c.file} — ${c.per100}/100loc (as:${c.asCasts} ?.:${c.optChain} ??:${c.coalesce} typeof:${c.typeofNarrow} isArr:${c.isArray}, ${c.loc} loc)`,
		);
	console.log(lines.join("\n"));
}

await main();
