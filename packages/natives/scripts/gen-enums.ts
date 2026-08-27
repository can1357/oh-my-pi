/**
 * Post-build script: reads the napi-rs generated `index.d.ts`, rewrites
 * TypeScript-only enum declarations to runtime-backed declarations, and writes
 * `native/index.js` from the checked-in ESM loader template.
 *
 * Why explicit ESM exports matter (issue #892):
 *
 * Consumers import named symbols from `@oh-my-pi/pi-natives`. The native addon
 * loader returns most values dynamically, while napi-rs `#[napi(string_enum)]`
 * emits `const enum` in the .d.ts — a TypeScript-only construct with no JS
 * runtime value. This script renders the ESM loader template and emits one
 * explicit `export const X = …` per public class/function declared in
 * `index.d.ts`, plus literal runtime objects for each enum.
 *
 * Run after `napi build`: `bun packages/natives/scripts/gen-enums.ts`
 */
import * as path from "node:path";

const nativeDir = path.resolve(import.meta.dir, "../native");
const dtsPath = path.join(nativeDir, "index.d.ts");
const jsPath = path.join(nativeDir, "index.js");

const MARKER_START = "// --- generated native exports (do not edit) ---";
const MARKER_END = "// --- end generated native exports ---";

// Match each `export declare const enum Name { ... }` block. The closing `}`
// is matched only at line start (enum bodies are indented).
const CONST_ENUM_RE = /export declare (?:const )?enum (\w+)\s*\{(.*?)\n\}/gs;

// Match `export declare class Name` (signatures or block headers). napi-rs
// always emits these as top-level declarations; we just need the name.
const CLASS_RE = /^export declare class (\w+)/gm;

// Match `export declare function name(...)`. Same shape rationale.
const FUNCTION_RE = /^export declare function (\w+)/gm;

interface EnumExport {
	name: string;
	entries: string[];
}

function collectEnums(dts: string): EnumExport[] {
	const enums: EnumExport[] = [];
	CONST_ENUM_RE.lastIndex = 0;
	for (;;) {
		const match = CONST_ENUM_RE.exec(dts);
		if (match === null) break;
		const name = match[1]!;
		const body = match[2]!;
		const entries: string[] = [];
		for (const line of body.split("\n")) {
			const m = line.match(/^\s*(\w+)\s*=\s*'([^']*)'/) ?? line.match(/^\s*(\w+)\s*=\s*(\d+)/);
			if (m) {
				const rawValue = m[2]!;
				const value = rawValue.match(/^\d+$/) ? rawValue : JSON.stringify(rawValue);
				entries.push(`\t${m[1]}: ${value},`);
			}
		}
		if (entries.length > 0) {
			enums.push({ name, entries });
		}
	}
	return enums;
}

function collectMatches(dts: string, re: RegExp): string[] {
	const names: string[] = [];
	re.lastIndex = 0;
	for (;;) {
		const match = re.exec(dts);
		if (match === null) break;
		names.push(match[1]!);
	}
	return names;
}

function buildGeneratedBlock(dts: string): string {
	const classes = collectMatches(dts, CLASS_RE);
	const functions = collectMatches(dts, FUNCTION_RE);
	const enums = collectEnums(dts);

	if (classes.length === 0 && functions.length === 0 && enums.length === 0) {
		throw new Error("No public symbols found in index.d.ts — check napi build output");
	}

	const lines: string[] = [];
	if (classes.length > 0) {
		lines.push("// classes");
		for (const name of classes) {
			const binding =
				name === "DesktopSession" ? `adaptDesktopSession(nativeBindings.${name})` : `nativeBindings.${name}`;
			lines.push(`export const ${name} = ${binding};`);
		}
	}
	if (functions.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("// functions");
		for (const name of functions) {
			lines.push(`export const ${name} = nativeBindings.${name};`);
		}
	}
	if (enums.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("// string/numeric enums (napi-rs string_enum produces TS-only const enum)");
		for (const e of enums) {
			lines.push(`export const ${e.name} = {\n${e.entries.join("\n")}\n};`);
		}
	}

	return `${MARKER_START}\n${lines.join("\n")}\n${MARKER_END}`;
}

export async function generateEnumExports(): Promise<void> {
	const dts = await Bun.file(dtsPath).text();
	const existing = await Bun.file(jsPath).text();
	const generatedBlock = buildGeneratedBlock(dts);

	// Patch the generated block in place. `native/index.js` is the hand-edited
	// loader; only the block between MARKER_START and MARKER_END is owned by
	// this script. The markers are committed to disk so the patch is purely
	// content replacement — no scaffold, no template file.
	const blockStart = existing.indexOf(MARKER_START);
	const blockEnd = existing.indexOf(MARKER_END);
	if (blockStart === -1 || blockEnd === -1 || blockEnd < blockStart) {
		throw new Error(
			`gen-enums: ${jsPath} is missing the generated marker block. ` +
				`Add\n\n${MARKER_START}\n${MARKER_END}\n\nplaceholders before running.`,
		);
	}
	const js = existing.slice(0, blockStart) + generatedBlock + existing.slice(blockEnd + MARKER_END.length);

	await Bun.write(jsPath, js);

	// Also fix the .d.ts: replace `const enum` with `enum` so TS allows
	// assigning string literals to enum types without casts.
	const constEnumCount = (dts.match(/export (?:declare )?const enum/g) ?? []).length;
	const dtsContent = dts
		.replaceAll("export const enum", "export declare enum")
		.replaceAll("export declare const enum", "export declare enum");
	await Bun.write(dtsPath, dtsContent);

	const symbolCount = (generatedBlock.match(/^export const /gm) ?? []).length;
	console.log(
		`Generated ${symbolCount} explicit ESM exports in index.js, fixed ${constEnumCount} const enums in index.d.ts`,
	);
}

if (import.meta.main) {
	await generateEnumExports();
}
