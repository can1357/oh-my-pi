/** End-to-end benchmark: replays shopper queries of each kind against the whole catalogue. */
import { CATALOGUE, type Mangle, mangledNames } from "../src/catalogue";
import { bestMatch } from "../src/match";

const QUERIES_PER_SCENARIO = 48;
const SCENARIOS: Mangle[] = ["typos", "truncated", "shouting"];

let total = 0;
for (const scenario of SCENARIOS) {
	const queries = mangledNames(QUERIES_PER_SCENARIO, scenario);
	const started = performance.now();
	let matched = 0;
	for (const query of queries) if (bestMatch(query, CATALOGUE)) matched++;
	const ms = performance.now() - started;
	total += ms;
	console.log(`${scenario.padEnd(10)} ${matched}/${queries.length} matched  ${ms.toFixed(0)} ms`);
}
console.log(`total      ${total.toFixed(0)} ms`);
