/**
 * Tab screenshots for the panel: the visible viewport, or a region or element the user picks with the overlay,
 * cropped from the viewport capture. The overlay is hidden around every capture so it never shows in the image.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { Capture, PickResult, Rect, Size } from "../messages";
import { overlay } from "./overlay-host";

/** A PNG with its pixel size. */
export interface Png {
	image: ImageContent;
	width: number;
	height: number;
}

/** Base64 of `bytes`, in slices small enough for `String.fromCharCode`'s argument limit. */
function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let start = 0; start < bytes.length; start += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
	}
	return btoa(binary);
}

async function decode(dataUrl: string): Promise<ImageBitmap> {
	return await createImageBitmap(await (await fetch(dataUrl)).blob());
}

/** PNG of the visible area of `windowId`'s active tab. */
export async function captureVisible(windowId: number): Promise<Png> {
	const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
	const bitmap = await decode(dataUrl);
	try {
		return {
			image: { type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/png" },
			width: bitmap.width,
			height: bitmap.height,
		};
	} finally {
		bitmap.close();
	}
}

/** Capture `windowId`'s active tab and crop it to `rect`, given in CSS pixels of a `viewport`-sized page. */
async function captureCropped(windowId: number, rect: Rect, viewport: Size): Promise<Png> {
	const bitmap = await decode(await chrome.tabs.captureVisibleTab(windowId, { format: "png" }));
	try {
		// Image pixels per CSS pixel; the device pixel ratio and zoom are both in it.
		const scaleX = bitmap.width / viewport.width;
		const scaleY = bitmap.height / viewport.height;
		const left = Math.max(0, Math.round(rect.x * scaleX));
		const top = Math.max(0, Math.round(rect.y * scaleY));
		const width = Math.max(1, Math.min(bitmap.width - left, Math.round(rect.width * scaleX)));
		const height = Math.max(1, Math.min(bitmap.height - top, Math.round(rect.height * scaleY)));
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("no 2d canvas in the service worker");
		context.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
		const blob = await canvas.convertToBlob({ type: "image/png" });
		return {
			image: { type: "image", data: toBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: "image/png" },
			width,
			height,
		};
	} finally {
		bitmap.close();
	}
}

/** Run `capture` with the tab's overlay hidden, restoring it afterwards. */
async function withOverlayHidden<T>(tabId: number, capture: () => Promise<T>): Promise<T> {
	// Only a running overlay can show in the image; hiding injects nothing where none runs.
	const hidden = await chrome.tabs
		.sendMessage(tabId, { omp: "overlay", op: "hide" }, { frameId: 0 })
		.then(() => true)
		.catch(() => false);
	try {
		return await capture();
	} finally {
		if (hidden) await chrome.tabs.sendMessage(tabId, { omp: "overlay", op: "show" }, { frameId: 0 }).catch(() => {});
	}
}

/** Capture `tabId`'s viewport, or the region or element the user picks in it; null when the pick is cancelled. */
export async function captureTab(tabId: number, mode: "viewport" | "region" | "element"): Promise<Capture | null> {
	const tab = await chrome.tabs.get(tabId);
	// Chrome captures only the active tab of a window.
	if (!tab.active) await chrome.tabs.update(tabId, { active: true });
	const pick =
		mode === "viewport" ? null : await overlay<PickResult | null>(tabId, { omp: "overlay", op: "pick", mode });
	if (mode !== "viewport" && !pick) return null;
	const png = await withOverlayHidden(tabId, () =>
		pick && pick.kind !== "viewport"
			? captureCropped(tab.windowId, pick.rect, pick.viewport)
			: captureVisible(tab.windowId),
	);
	return {
		...png,
		tabId,
		url: tab.url ?? tab.pendingUrl ?? "",
		...(pick?.kind === "element" ? { caption: pick.descriptor } : {}),
	};
}
