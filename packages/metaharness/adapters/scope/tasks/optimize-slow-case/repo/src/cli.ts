import { parseArgs } from "node:util";
import { buildReport } from "./report";

const { values } = parseArgs({
	options: { rows: { type: "string", default: "1000" }, seed: { type: "string", default: "7" } },
});

console.log(buildReport(Number(values.rows), Number(values.seed)));
