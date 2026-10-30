process.stdin.once("data", () => {
	process.stdout.write("Content-Length: 268435457\r\n\r\n");
});
await Bun.sleep(60_000);
