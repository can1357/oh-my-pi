import { acquireBrowser, releaseBrowser } from "../../src/tools/browser/registry";

try {
	const handle = await acquireBrowser(
		{ kind: "firefox-relay", webSocketUrl: process.argv[2]! },
		{ cwd: process.cwd() },
	);
	await releaseBrowser(handle, { kill: false });
	process.stdout.write("acquired\n");
} catch (error) {
	if (!(error instanceof Error) || !error.message.includes("already owned by another OMP process")) throw error;
	process.stdout.write("contended\n");
}
