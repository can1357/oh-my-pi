// Many fatal-site rows through one tree's addon, each in a FRESH Shell, in one
// bun process. argv: <tree>; env CASE_FILE = JSON [{id, script}, ...],
// RESULT_FILE = JSONL out, CASE_CWD = the directory the rows run in.
//
// A fresh `new mod.Shell()` per row is what `crates/pi-shell/tests/*.rs` does
// with `Shell::new(None)`: no state crosses rows. The single process is only to
// avoid one bun start-up per row. The tree is chosen per run on argv so one
// pass can measure a candidate head against main, which is why the specifier
// cannot be a literal.
const tree = process.argv[2];
const mod = await import(`${tree}/packages/natives/native/index.js`);
const loader = await import(`${tree}/packages/natives/native/loader-state.js`);
const status = loader.nativeAddonStatus();
if (!String(status.path ?? "").startsWith(`${tree}/`)) {
	console.error(`run-fatal-sites-batch: ${tree} loaded ${status.path}, which is not inside it`);
	process.exit(3);
}
const cases = JSON.parse(await Bun.file(process.env.CASE_FILE as string).text()) as {
	id: string;
	script: string;
}[];
const cwd = process.env.CASE_CWD as string;
const out: string[] = [];
for (const c of cases) {
	const shell = new mod.Shell();
	let text = "";
	try {
		const r = await shell.run(
			{ command: `exec 2>/dev/null\n${c.script}`, cwd, timeoutMs: 10_000 },
			(_e: unknown, chunk: string) => {
				if (chunk) text += chunk;
			},
		);
		out.push(JSON.stringify({ id: c.id, out: text, rc: r.exitCode, timedOut: r.timedOut }));
	} catch (e) {
		out.push(JSON.stringify({ id: c.id, out: text, error: String(e) }));
	}
}
await Bun.write(process.env.RESULT_FILE as string, `${out.join("\n")}\n`);
console.error(`run-fatal-sites-batch: ${cases.length} rows through ${status.path}`);
process.exit(0);
