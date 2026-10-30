const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"], {
	stdin: "ignore",
	stdout: "inherit",
	stderr: "inherit",
	windowsHide: true,
	// Bun places Windows children in the parent job, which dies with the root;
	// detached lets this descendant outlive the probe and hold the pipe.
	detached: true,
});

await Bun.write(Bun.stdout, `${child.pid}\n`);
process.exit(0);
