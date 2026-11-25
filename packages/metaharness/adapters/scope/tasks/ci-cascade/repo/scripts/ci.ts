/**
 * CI for mdlite: runs each stage in order and stops at the first failure.
 *
 * Stages import `src/` themselves: a module that fails to load then fails its stage instead of
 * this script.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** Resolves with the failure to report, or `null` when the stage passes. */
type Stage = () => Promise<string | null>;

/** Every rule module is listed in `RULES`. */
async function registry(): Promise<string | null> {
	const { RULES } = await import("../src/rules/index");
	for (const file of fs.readdirSync(path.join(ROOT, "src/rules")).sort()) {
		const name = path.basename(file, ".ts");
		if (name === "index" || name === "rule") continue;
		if (!RULES.some((rule: { name: string }) => rule.name === name)) {
			return `src/rules/${file} is not listed in RULES (src/rules/index.ts)`;
		}
	}
	return null;
}

async function unit(): Promise<string | null> {
	const proc = Bun.spawn(["bun", "test", "test/unit"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return code === 0 ? null : `${out}${err}`.trim();
}

/** Each `cases/<name>.md` renders to `cases/<name>.html`; reports the first line that differs. */
async function golden(): Promise<string | null> {
	const { renderMarkdown } = await import("../src/render");
	const dir = path.join(ROOT, "cases");
	const inputs = fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".md"))
		.sort();
	for (const input of inputs) {
		const expected = fs
			.readFileSync(path.join(dir, input.replace(/\.md$/, ".html")), "utf8")
			.trimEnd()
			.split("\n");
		const actual = renderMarkdown(fs.readFileSync(path.join(dir, input), "utf8")).split("\n");
		let line = expected.findIndex((text, index) => text !== actual[index]);
		if (line === -1 && actual.length > expected.length) line = expected.length;
		if (line !== -1) {
			return [
				`cases/${input}: output line ${line + 1} differs`,
				`  expected: ${expected[line] ?? "<end of output>"}`,
				`  actual:   ${actual[line] ?? "<end of output>"}`,
			].join("\n");
		}
	}
	return null;
}

/** Every rule has a section in docs/syntax.md. */
async function docs(): Promise<string | null> {
	const { RULES } = await import("../src/rules/index");
	const sections = fs.readFileSync(path.join(ROOT, "docs/syntax.md"), "utf8").split("\n");
	for (const rule of RULES as Array<{ name: string }>) {
		if (!sections.includes(`## ${rule.name}`)) return `rule "${rule.name}" has no "## ${rule.name}" section in docs/syntax.md`;
	}
	return null;
}

const STAGES: Array<[name: string, run: Stage]> = [
	["registry", registry],
	["unit", unit],
	["golden", golden],
	["docs", docs],
];

for (const [name, run] of STAGES) {
	const failure = await run();
	if (failure !== null) {
		console.error(`✗ ${name}\n${failure}`);
		process.exit(1);
	}
	console.log(`✓ ${name}`);
}
console.log("ci: all stages passed");
