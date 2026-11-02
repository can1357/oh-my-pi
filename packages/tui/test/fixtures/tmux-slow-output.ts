// Transport fixture for resize-tmux-sync.test.ts. Keep the pane alive between
// frames; split UTF-8 and escape sequences like a real backed-up PTY writer.
const directory = process.argv[2]!;
const writer = Bun.stdout.writer();
for (let frame = 0; ; frame++) {
	const filename = `${directory}/${frame}.frame`;
	// A BunFile caches a missing stat, so polling requires a fresh handle.
	while (!(await Bun.file(filename).exists())) await Bun.sleep(10);
	const bytes = await Bun.file(filename).bytes();
	for (let offset = 0; offset < bytes.length; offset += 4096) {
		writer.write(bytes.subarray(offset, offset + 4096));
		await writer.flush();
		await Bun.sleep(30);
	}
	await Bun.write(`${directory}/${frame}.done`, "done");
}
