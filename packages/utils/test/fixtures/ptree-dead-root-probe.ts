const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"], {
	stdin: "ignore",
	stdout: "inherit",
	stderr: "inherit",
	windowsHide: true,
});

await Bun.write(Bun.stdout, `${child.pid}\n`);
process.exit(0);
