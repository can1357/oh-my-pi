// Bundled for the browser by client-json-block.test.tsx, with the dashboard's bundle plugins, and run: it prints
// what pi-utils' JSON writer gives there for boxed primitives (which it tells apart through `node:util/types`)
// and for a value nested past the depth `JSON.stringify` reaches.
import { stringifyDeepJson, stringifyJsonIteratively } from "@oh-my-pi/pi-utils/json";
import { nestedChain } from "../../../ai/test/helpers/deep-nesting";

const deep = nestedChain();

console.log(
	JSON.stringify({
		boxed: stringifyJsonIteratively({ n: Object(5), b: Object(true), s: Object("x"), plain: { a: [1] } }),
		deepLength: stringifyDeepJson(deep, { space: 2 })?.length,
	}),
);
