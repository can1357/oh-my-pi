import type { WorkerContext } from "../messages";
import { type EncodeGifRequest, type EncodeGifResult, OFFSCREEN_PAGE } from "../offscreen/messages";

/** Serialize GIF exports through a single offscreen document and hand them to Chrome downloads. */
export function installGifExport(ctx: WorkerContext): void {
	let exporting: Promise<unknown> = Promise.resolve();
	let pending = 0;
	ctx.handle("exportGif", ({ frames }) => {
		if (frames.length === 0) return Promise.reject(new Error("There are no screenshots to export"));
		if (pending++ === 0) ctx.setBusy("gif", true);
		const result = exporting.then(async () => {
			const contexts = await chrome.runtime.getContexts({
				contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
				documentUrls: [chrome.runtime.getURL(OFFSCREEN_PAGE)],
			});
			if (contexts.length === 0) {
				await chrome.offscreen.createDocument({
					url: OFFSCREEN_PAGE,
					reasons: [chrome.offscreen.Reason.BLOBS],
					justification: "Compose and encode a GIF from the run's screenshot frames",
				});
			}
			try {
				const message: EncodeGifRequest = { omp: "encode-gif", frames };
				const reply: EncodeGifResult | undefined = await chrome.runtime.sendMessage(message);
				if (!reply) throw new Error("The GIF encoder did not reply");
				if (!reply.ok) throw new Error(reply.error);
				const filename = `omp-run-${new Date().toISOString()}.gif`;
				await chrome.downloads.download({ url: reply.url, filename });
				return { filename };
			} finally {
				await chrome.offscreen.closeDocument();
			}
		}).finally(() => {
			if (--pending === 0) ctx.setBusy("gif", false);
		});
		exporting = result.catch(() => undefined);
		return result;
	});
}
