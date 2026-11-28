/**
 * The side panel shows collab-web's tool cards, whose digest of a call's arguments (`argsDigest`) uses pi-utils' JSON
 * helpers. Those read `node:util/types`, which Bun's browser target leaves without exports: an extension bundle built
 * without the stats client's plugins threw `isProxy is not a function` on every generic card, and React dropped the
 * panel.
 */
import { expect, it } from "bun:test";
import * as path from "node:path";
import { argsDigest } from "@oh-my-pi/collab-web/src/tool-render/util";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { nestedChain } from "../../ai/test/helpers/deep-nesting";
import { bundle } from "../scripts/build-extension";

it("bundles the panel's tool-card helpers so a generic card's argument digest runs in the browser", async () => {
	using dir = TempDir.createSync("@omp-relay-panel-bundle-");
	await bundle(dir.path(), "../test/fixtures/panel-args-digest.ts", "probe", "esm");

	const printed = await $`${process.execPath} ${path.join(dir.path(), "probe.js")}`.quiet().nothrow();

	expect(printed.stderr.toString()).toBe("");
	expect(JSON.parse(printed.stdout.toString())).toEqual({
		shallow: argsDigest({ a: 1 }),
		deep: argsDigest(nestedChain()),
	});
}, 30_000);
