/**
 * Child process for `commit-git-config-global.test.ts`. The native addon reads
 * the process environment when it loads, so each commit runs here with the
 * environment under test. Arguments: the repository directory and the message.
 */
import { requireGit } from "../native/vcs.js";

const repo = requireGit(process.argv[2]);
try {
	await repo.commitCreate(process.argv[3], {});
	console.log("committed");
} catch (error) {
	console.log(`refused: ${error instanceof Error ? error.message : String(error)}`);
}
