import * as path from "node:path";
import type { BunPlugin } from "bun";

/**
 * `node:util/types`, which Bun's browser target leaves without exports,
 * resolved to the browser checks in `client/node-util-types.ts`, so the
 * pi-utils JSON helpers (its writer and its depth check) run in a browser.
 */
const browserNodeUtilTypes: BunPlugin = {
	name: "browser-node-util-types",
	setup(build) {
		build.onResolve({ filter: /^node:util\/types$/ }, () => ({
			path: path.join(import.meta.dir, "client", "node-util-types.ts"),
		}));
	},
};

/**
 * Plugins of every browser bundle of the dashboard client's code or of the
 * pi-utils JSON helpers: the dashboard's own (`build.ts`), the HTML export
 * viewer's, which shows the client's trace views
 * (`collab-web/scripts/build-export-viewer.ts`), the collab-web app's
 * (`collab-web/scripts/build-app.ts`), and the browser-relay extension's,
 * whose side panel shows collab-web's tool cards
 * (`browser-relay/scripts/build-extension.ts`).
 */
export const clientBundlePlugins: BunPlugin[] = [browserNodeUtilTypes];

/** The plugin as a Bun dev server loads one from `[serve.static] plugins` (collab-web's `bunfig.toml`): a module's default export. */
export default browserNodeUtilTypes;
