// Bundled for the browser by panel-browser-bundle.test.ts with the extension build's `bundle()`, and run: it prints
// the digests the side panel's generic tool card shows for a call's arguments, shallow and nested 50,000 levels.
import { argsDigest } from "@oh-my-pi/collab-web/src/tool-render/util";
import { nestedChain } from "../../../ai/test/helpers/deep-nesting";

console.log(JSON.stringify({ shallow: argsDigest({ a: 1 }), deep: argsDigest(nestedChain()) }));
