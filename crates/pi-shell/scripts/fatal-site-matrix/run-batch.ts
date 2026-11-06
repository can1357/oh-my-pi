// Many independent cases through one tree's addon, each in a fresh Shell, in
// one Bun process. argv: <tree>; env CASE_FILE = JSON [{id, script}, ...],
// RESULT_FILE = JSONL output; CASE_CWD = working directory for each case.
//
// A fresh `new mod.Shell()` per case is what `crates/pi-shell/tests/*.rs` does
// with `Shell::new(None)`: no state crosses cases. The single process is only
// to avoid one Bun start-up per row.
const tree = process.argv[2];
if (!tree || !process.env.CASE_FILE || !process.env.RESULT_FILE || !process.env.CASE_CWD) {
	console.error("run-batch: expected <tree> and CASE_FILE, RESULT_FILE, CASE_CWD environment variables");
	process.exit(2);
}
// The selected tree supplies the modules, so these imports are resolved at
// runtime rather than bound to the runner's own checkout.
const mod = await import(`${tree}/packages/natives/native/index.js`);
const loader = await import(`${tree}/packages/natives/native/loader-state.js`);
const status = loader.nativeAddonStatus();
if (!String(status.path ?? "").startsWith(`${tree}/`)) {
	console.error(`run-batch: ${tree} loaded ${status.path}, which is not inside it`);
	process.exit(3);
}
const cases = JSON.parse(await Bun.file(process.env.CASE_FILE).text()) as {
	id: string;
	script: string;
}[];
const cwd = process.env.CASE_CWD;
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
await Bun.write(process.env.RESULT_FILE, `${out.join("\n")}\n`);
console.error(`run-batch: ${cases.length} cases through ${status.path}`);
process.exit(0);
