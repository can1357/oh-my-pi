import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { ImageUrlService, LiveImageUrlService } from "@oh-my-pi/pi-coding-agent/blob-broker/service";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

import { cfgImagesUrlsEnabled, cfgImagesUrlsTtlHours } from "@oh-my-pi/pi-coding-agent/blob-broker/settings";

describe("LiveImageUrlService", () => {
	it("follows images.urls.* changes made after construction", async () => {
		// provider-files only: no URL backend, so no daemon/server is started.
		const settings = Settings.isolated({ "images.urls.backends": ["provider-files"] });
		const live = new LiveImageUrlService(
			settings,
			() => os.tmpdir(),
			async () => undefined,
		);
		try {
			expect(live.current).toBeUndefined();

			cfgImagesUrlsEnabled.set(settings, true);
			await Promise.resolve();
			const first = live.current;
			expect(first).toBeInstanceOf(ImageUrlService);

			cfgImagesUrlsTtlHours.set(settings, 1);
			await Promise.resolve();
			expect(live.current).toBeInstanceOf(ImageUrlService);
			expect(live.current).not.toBe(first);

			cfgImagesUrlsEnabled.set(settings, false);
			await Promise.resolve();
			expect(live.current).toBeUndefined();
		} finally {
			live.dispose();
		}
	});
});
