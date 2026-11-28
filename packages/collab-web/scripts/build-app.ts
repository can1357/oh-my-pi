#!/usr/bin/env bun
/**
 * Bundle the collab-web app (`index.html`) into `dist/`. A script rather than `bun build`, whose command line
 * takes no plugins: the tool cards use pi-utils' JSON helpers, which need the stats client's browser plugins.
 */
import * as path from "node:path";
import { clientBundlePlugins } from "@oh-my-pi/omp-stats/client-bundle";

const collabDir = path.join(import.meta.dir, "..");

const result = await Bun.build({
	entrypoints: [path.join(collabDir, "index.html")],
	outdir: path.join(collabDir, "dist"),
	minify: true,
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	naming: { entry: "[hash].[ext]", chunk: "[hash].[ext]", asset: "[hash].[ext]" },
	plugins: clientBundlePlugins,
});
if (!result.success) throw new AggregateError(result.logs, "collab-web app bundle failed");
