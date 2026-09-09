import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	resolvePluginExtensionPaths,
	resolvePluginToolPaths,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import type { InstalledPlugin, PluginManifest } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

function makePlugin(pluginPath: string, manifest: PluginManifest): InstalledPlugin {
	return {
		name: "fixture-plugin",
		version: "1.0.0",
		path: pluginPath,
		manifest,
		enabledFeatures: null,
		enabled: true,
	};
}

describe("plugin manifest path resolution", () => {
	it("resolves a directory tools entry to its index, not the omp.extensions modules", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-manifest-paths-"));
		try {
			// The package declares both extensions and a directory-based tool entry.
			// `omp.extensions` and the sub-extension scan are extensions-specific and
			// must not hijack the `tools: "."` directory entry (regression: the shared
			// directory resolver returned the extension module for every key).
			fs.writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "fixture-plugin", version: "1.0.0", omp: { extensions: ["./ext.ts"], tools: "." } }),
			);
			fs.writeFileSync(path.join(dir, "index.ts"), "export default {};");
			fs.writeFileSync(path.join(dir, "ext.ts"), "export default function () {};");
			const plugin = makePlugin(dir, {
				name: "fixture-plugin",
				version: "1.0.0",
				extensions: ["./ext.ts"],
				tools: ".",
			});

			expect(resolvePluginToolPaths(plugin)).toEqual([path.join(dir, "index.ts")]);
			expect(resolvePluginExtensionPaths(plugin)).toEqual([path.join(dir, "ext.ts")]);
		} finally {
			removeSyncWithRetries(dir);
		}
	});
});
