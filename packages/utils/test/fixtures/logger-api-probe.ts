import * as fs from "node:fs";
import { logger as rootLogger } from "../../src/index";
import * as directLogger from "../../src/logger";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("expected output path");

const keys = Object.keys(directLogger).sort();
const identities = keys.every(key => {
	const direct = directLogger as Record<string, unknown>;
	const root = rootLogger as Record<string, unknown>;
	return direct[key] === root[key];
});

fs.writeFileSync(outputPath, JSON.stringify({ identities, keys }));
