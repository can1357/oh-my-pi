import * as path from "node:path";

/** Keep the optional catalog outside JavaScript bundles and standalone executables. */
export async function stageLanguagePack(outDir: string): Promise<void> {
	await Bun.write(
		path.join(outDir, "locales", "ko.json"),
		Bun.file(path.join(import.meta.dir, "../../utils/src/locales/ko.json")),
	);
}
