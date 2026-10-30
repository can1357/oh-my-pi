import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import viewerAsset from "../src/export/html/viewer.generated.json" with { type: "json" };

const exportModule = new URL("../src/export/html/index.ts", import.meta.url).href;
const i18nModule = new URL("../../utils/src/i18n.ts", import.meta.url).href;

async function packagedTemplate(language?: string, messages?: Record<string, string>) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-export-i18n-"));
	try {
		if (messages) await Bun.write(path.join(directory, "ko.json"), JSON.stringify(messages));
		const script = `import {initializeI18n} from ${JSON.stringify(i18nModule)};
import {getTemplate} from ${JSON.stringify(exportModule)};
await initializeI18n();
process.stdout.write(getTemplate());`;
		const child = Bun.spawnSync([process.execPath, "-e", script], {
			env: {
				...process.env,
				OMP_LANG: language,
				OMP_LOCALE_DIR: messages ? directory : undefined,
				PI_BUNDLED: "true",
				PI_COMPILED: undefined,
			},
		});
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		return child.stdout.toString();
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

describe("hosted HTML export language boundary", () => {
	test("keeps the upstream hosted loader and integrity unchanged when Korean is selected", async () => {
		const english = await packagedTemplate();
		expect(await packagedTemplate("ko")).toBe(english);
		const { document } = parseHTML(english);
		const viewer = document.querySelector(`script[src$="/${viewerAsset.file}"]`);
		expect(viewer?.getAttribute("src")).toStartWith("https://build.stencil.so/web/omp/");
		expect(viewer?.getAttribute("integrity")).toBe(viewerAsset.integrity);
		expect(viewer?.getAttribute("crossorigin")).toBe("anonymous");
	});

	test("does not inject external pack contents into the incompatible upstream export shell", async () => {
		const hostile = '<script>throw new Error("external-pack-marker")</script>';
		const html = await packagedTemplate("ko", {
			"Session Export\u0004browser-assets": hostile,
			"Open sidebar\u0004browser-assets": hostile,
		});
		expect(html).toBe(await packagedTemplate());
		expect(html).not.toContain("external-pack-marker");
	});
});
