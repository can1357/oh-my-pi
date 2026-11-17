// Many fatal-site rows through one tree's addon, each in a FRESH Shell, in one
// bun process. argv: <tree>; env CASE_FILE = JSON [{id, script}, ...],
// RESULT_FILE = JSONL out, CASE_CWD = the directory the rows run in.
//
// A fresh `new mod.Shell()` per row is what `crates/pi-shell/tests/*.rs` does
// with `Shell::new(None)`: no state crosses rows. The single process is only to
// avoid one bun start-up per row. The tree is chosen per run on argv so one
// pass can measure a candidate head against main, which is why the specifier
// cannot be a literal — the module path is resolved at the process boundary
// (validated here, loaded through `require()`).

// --- process boundary: validate every input before any I/O ---
const tree = process.argv[2];
if (!tree) {
	console.error("run-fatal-sites-batch: missing argv[1] <tree>");
	process.exit(1);
}
const caseFile = process.env.CASE_FILE;
if (!caseFile) {
	console.error("run-fatal-sites-batch: CASE_FILE is not set");
	process.exit(1);
}
const resultFile = process.env.RESULT_FILE;
if (!resultFile) {
	console.error("run-fatal-sites-batch: RESULT_FILE is not set");
	process.exit(1);
}
const caseCwd = process.env.CASE_CWD;
if (!caseCwd) {
	console.error("run-fatal-sites-batch: CASE_CWD is not set");
	process.exit(1);
}

// Load the tree's addon through `require()` on a validated, absolute path.
// `require()` is Bun's synchronous CJS loader — not `await import()`, which
// AGENTS.md bans — and the tree argument was validated above.
const mod = require(`${tree}/packages/natives/native/index.js`);
const loader = require(`${tree}/packages/natives/native/loader-state.js`);
const status = loader.nativeAddonStatus();
if (!String(status.path ?? "").startsWith(`${tree}/`)) {
	console.error(`run-fatal-sites-batch: ${tree} loaded ${status.path}, which is not inside it`);
	process.exit(3);
}
if (status.stale) {
	console.error(
		`run-fatal-sites-batch: the loaded addon is @oh-my-pi/pi-natives@${status.version}, ` +
			`but this tree expects @${status.packageVersion}. Rebuild with ` +
			"`bun --cwd=packages/natives run build` before measuring.",
	);
	process.exit(3);
}
const cases = JSON.parse(await Bun.file(caseFile).text()) as {
	id: string;
	script: string;
}[];
const out: string[] = [];
let errors = 0;
for (const c of cases) {
	const shell = new mod.Shell();
	let text = "";
	try {
		const r = await shell.run(
			{ command: `exec 2>/dev/null\n${c.script}`, cwd: caseCwd, timeoutMs: 10_000 },
			(_e: unknown, chunk: string) => {
				if (chunk) text += chunk;
			},
		);
		if (r.timedOut) {
			console.error(`run-fatal-sites-batch: row ${c.id} timed out`);
			out.push(JSON.stringify({ id: c.id, out: text, timedOut: true }));
			errors++;
		} else if (r.exitCode == null) {
			console.error(`run-fatal-sites-batch: row ${c.id} produced no exit code`);
			out.push(JSON.stringify({ id: c.id, out: text, error: "no exit code" }));
			errors++;
		} else {
			out.push(JSON.stringify({ id: c.id, out: text, rc: r.exitCode }));
		}
	} catch (e) {
		console.error(`run-fatal-sites-batch: row ${c.id} threw: ${e}`);
		out.push(JSON.stringify({ id: c.id, out: text, error: String(e) }));
		errors++;
	}
}
await Bun.write(resultFile, `${out.join("\n")}\n`);
console.error(`run-fatal-sites-batch: ${cases.length} rows through ${status.path}, ${errors} errors`);
process.exit(errors > 0 ? 1 : 0);
