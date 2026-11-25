import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { buildExportViewer } from "../../../collab-web/scripts/build-export-viewer";
import viewerAsset from "../../src/export/html/viewer.generated.json" with { type: "json" };

/** Direct source exports need the pinned viewer even when install's prepare hook hasn't run. */
export async function ensureDevelopmentViewer(): Promise<void> {
	const outDir = path.resolve(import.meta.dir, "../../export-assets");
	const viewerPath = path.join(outDir, viewerAsset.file);
	if (await Bun.file(viewerPath).exists()) return;

	// The generator prunes old assets. Stage privately and publish one complete file, even across test workers.
	await fs.mkdir(outDir, { recursive: true });
	await using stage = await TempDir.create(path.join(outDir, ".test-"));
	await buildExportViewer({
		outDir: stage.path(),
		metadataPath: path.resolve(import.meta.dir, "../../src/export/html/viewer.generated.json"),
		check: true,
	});
	await fs.rename(stage.join(viewerAsset.file), viewerPath);
}
