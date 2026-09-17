#!/usr/bin/env bun
/**
 * Build cookbook-shaped hermes_roster.json from a hermes-agent checkout.
 *
 * Usage:
 *   bun evals/jev-showcase/skill-suggestion/build-hermes-roster.ts \
 *     --hermes-dir /path/to/hermes-agent \
 *     --out evals/jev-showcase/skill-suggestion/data/hermes_roster.json
 */
import * as fs from "node:fs";
import * as path from "node:path";

const INDEX_TRUNCATE = 60;
const BODY_STORE_CHARS = 1600;

export interface HermesRosterEntry {
	name: string;
	category: string;
	description: string;
	description_full: string;
	body: string;
}

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!m) return { fm: {}, body: text };
	const fm: Record<string, string> = {};
	let key = "";
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (kv) {
			key = kv[1]!;
			fm[key] = kv[2]!.trim();
			continue;
		}
		if (key && /^\s/.test(line)) {
			fm[key] = `${fm[key] ?? ""} ${line.trim()}`.trim();
		}
	}
	const cat = /category:\s*(\S+)/.exec(m[1]);
	if (cat) fm.__category = cat[1]!;
	for (const k of Object.keys(fm)) {
		fm[k] = fm[k]!.replace(/^(['"])([\s\S]*)\1$/, "$2");
	}
	return { fm, body: m[2] ?? "" };
}

function truncateIndex(description: string): string {
	const flat = description.replace(/\s+/g, " ").trim();
	if (flat.length <= INDEX_TRUNCATE) return flat;
	return `${flat.slice(0, INDEX_TRUNCATE).trimEnd()}…`;
}

export function buildHermesRoster(hermesDir: string): HermesRosterEntry[] {
	const roots = [path.join(hermesDir, "skills"), path.join(hermesDir, "optional-skills")];
	const out: HermesRosterEntry[] = [];
	const seen = new Set<string>();

	for (const root of roots) {
		if (!fs.existsSync(root)) continue;
		for (const file of fs.readdirSync(root, { recursive: true })) {
			if (typeof file !== "string" || !file.endsWith("SKILL.md")) continue;
			const skillPath = path.join(root, file);
			let text: string;
			try {
				text = fs.readFileSync(skillPath, "utf8");
			} catch {
				continue;
			}
			const { fm, body } = parseFrontmatter(text);
			const descriptionFull = (fm.description ?? "").replace(/\s+/g, " ").trim();
			if (!descriptionFull) continue;
			const name = (fm.name ?? path.basename(path.dirname(skillPath))).trim();
			if (!name || seen.has(name)) continue;
			seen.add(name);
			const parts = file.split(/[/\\]/);
			const category = fm.__category ?? parts[0] ?? "misc";
			const bodyFlat = body.replace(/\s+/g, " ").trim();
			out.push({
				name,
				category,
				description: truncateIndex(descriptionFull),
				description_full: descriptionFull,
				body: bodyFlat.slice(0, BODY_STORE_CHARS),
			});
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

const hermesDir = arg("hermes-dir", process.env.HERMES_AGENT_DIR ?? "/tmp/hermes-agent");
const outPath = arg("out", path.join(import.meta.dir, "data", "hermes_roster.json"));

const roster = buildHermesRoster(hermesDir);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(roster, null, 2)}\n`, "utf8");
console.log(`wrote ${roster.length} skills -> ${outPath}`);
console.log(`${roster.filter(s => s.description.endsWith("…")).length} with truncated index descriptions`);
