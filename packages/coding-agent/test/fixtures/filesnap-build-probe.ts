import * as path from "node:path";
import { compileCodingAgent } from "../../scripts/compile-binary";

await compileCodingAgent({
	repoRoot: path.resolve(import.meta.dir, "../../../.."),
	entrypoint: path.join(import.meta.dir, "filesnap-distribution-probe.ts"),
	outfile: process.argv[2]!,
	transformersVersion: "unused",
});
