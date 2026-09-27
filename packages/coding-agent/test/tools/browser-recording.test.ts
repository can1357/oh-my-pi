import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { $which } from "@oh-my-pi/pi-utils/which";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const FFMPEG_AVAILABLE = Boolean($which("ffmpeg") && $which("ffprobe"));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-recording-"));
const session: ToolSession = {
	cwd: root,
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-recording-test" };

interface ProbeResult {
	streams?: Array<{
		codec_type?: string;
		codec_name?: string;
		width?: number;
		height?: number;
		avg_frame_rate?: string;
	}>;
	format?: { duration?: string };
}

interface StopResult {
	path: string;
	durationMs: number;
	frames: number;
	bytes: number;
	contactSheet?: string;
}

async function invoke(parameters: unknown) {
	return await prelude.invoke(parameters, context);
}

async function call(method: string, args: unknown[] = []) {
	return await invoke({ action: "call", name: "recording", chain: [{ method, args }] });
}

function valueFrom<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		throw new Error("browser returned invalid response details");
	}
	return (details as Record<string, unknown>).value as T;
}

async function value<T>(method: string, args: unknown[] = []): Promise<T> {
	return valueFrom<T>(await call(method, args));
}

async function probeVideo(filePath: string): Promise<ProbeResult> {
	const ffprobe = $which("ffprobe");
	if (!ffprobe) throw new Error("ffprobe disappeared after the test gate");
	const child = Bun.spawn(
		[
			ffprobe,
			"-v",
			"error",
			"-show_entries",
			"format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate",
			"-of",
			"json",
			filePath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`ffprobe failed: ${stderr}`);
	return JSON.parse(stdout) as ProbeResult;
}

const html = `<!doctype html><html><head><style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
body { display: grid; place-items: center; font: 64px system-ui; }
</style></head><body><output id="counter">0</output><script>
const started = performance.now();
function animate(now) {
  const elapsed = now - started;
  document.querySelector('#counter').textContent = String(Math.floor(elapsed / 50));
  document.body.style.background = 'hsl(' + Math.floor(elapsed / 5) % 360 + ' 80% 70%)';
  if (elapsed < 5000) requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
</script></body></html>`;

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE || !FFMPEG_AVAILABLE)("browser video recording", () => {
	it("records cursor-aware WebM and MP4 video, emits a changed-frame contact sheet, and names inactive-stop errors", async () => {
		await invoke({
			action: "open",
			name: "recording",
			url: `data:text/html,${encodeURIComponent(html)}`,
			viewport: { width: 480, height: 320 },
		});
		try {
			const started = await value<{ path: string; fps: number }>("recordStart", [
				"capture.webm",
				{ fps: 10, cursor: true, contactSheet: true, contactSheetThreshold: 0.02 },
			]);
			expect(started).toEqual({ path: path.join(root, "capture.webm"), fps: 10 });
			expect(await value("recording")).toMatchObject({ active: true, path: started.path, fps: 10 });

			const moved = await invoke({
				action: "run",
				name: "recording",
				code: `await page.mouse.move(121, 87);
await page.mouse.down();
await page.mouse.up();
await wait(1550);
const root = await page.$('#__omp_recording_cursor__');
if (!root) return { overlay: false };
const transform = await root.evaluate(el => el.shadowRoot?.querySelector('.pointer')?.style.transform ?? '');
return { overlay: true, transform };`,
			});
			expect(valueFrom<{ overlay: boolean; transform: string }>(moved)).toEqual({
				overlay: true,
				transform: "translate(121px, 87px)",
			});
			const aria = await value<string>("ariaSnapshot");
			expect(aria).not.toContain("OMP recording cursor overlay");

			const stoppedCall = await call("recordStop");
			const stopped = valueFrom<StopResult>(stoppedCall);
			expect(stopped).toMatchObject({ path: started.path, contactSheet: `${started.path}.contact.png` });
			expect(stopped.durationMs).toBeGreaterThanOrEqual(1_000);
			expect(stopped.frames).toBeGreaterThan(1);
			expect(stopped.bytes).toBeGreaterThan(0);
			expect(stoppedCall.content.some(block => block.type === "image")).toBe(true);
			expect(
				await value<boolean>("evaluate", ["document.getElementById('__omp_recording_cursor__') === null"]),
			).toBe(true);

			const webmProbe = await probeVideo(stopped.path);
			const webmStream = webmProbe.streams?.find(stream => stream.codec_type === "video");
			expect(webmStream?.codec_name === "vp9" || webmStream?.codec_name === "vp8").toBe(true);
			expect(Number.parseFloat(webmProbe.format?.duration ?? "0")).toBeGreaterThanOrEqual(1);
			expect(webmStream?.avg_frame_rate).toBe("10/1");

			const contactBytes = await fs.readFile(stopped.contactSheet!);
			const contact = await new Bun.Image(contactBytes).metadata();
			expect(contact.format).toBe("png");
			expect(contact.width % 320).toBe(0);
			expect(contact.height % 214).toBe(0);
			const columns = contact.width / 320;
			const rows = contact.height / 214;
			expect(columns).toBeGreaterThanOrEqual(1);
			expect(columns).toBeLessThanOrEqual(3);
			expect(rows).toBeGreaterThanOrEqual(1);
			expect(columns * rows).toBeLessThanOrEqual(12);

			let inactiveError: unknown;
			try {
				await call("recordStop");
			} catch (error) {
				inactiveError = error;
			}
			expect(inactiveError).toBeInstanceOf(Error);
			expect((inactiveError as Error).name).toBe("BrowserRecordingError");
			expect((inactiveError as Error).message).toContain("requires an active recording");

			const mp4Start = await value<{ path: string; fps: number }>("recordStart", ["capture.mp4", { fps: 10 }]);
			await invoke({ action: "run", name: "recording", code: "await wait(1550); return true" });
			const mp4Stop = await value<StopResult>("recordStop");
			expect(mp4Stop.path).toBe(mp4Start.path);
			const mp4Probe = await probeVideo(mp4Stop.path);
			const mp4Stream = mp4Probe.streams?.find(stream => stream.codec_type === "video");
			expect(mp4Stream?.codec_name).toBe("h264");
			expect(Number.parseFloat(mp4Probe.format?.duration ?? "0")).toBeGreaterThanOrEqual(1);
			expect(mp4Stream?.width && mp4Stream.width % 2).toBe(0);
			expect(mp4Stream?.height && mp4Stream.height % 2).toBe(0);

			const restartSource = await value<{ path: string; fps: number }>("recordStart", [
				"restart-source.webm",
				{ fps: 5 },
			]);
			await invoke({ action: "run", name: "recording", code: "await wait(1100); return true" });
			const restartTarget = await value<{ path: string; fps: number }>("recordRestart", [
				"close-finalized.webm",
				{ fps: 5 },
			]);
			expect(restartTarget).toEqual({ path: path.join(root, "close-finalized.webm"), fps: 5 });
			expect(
				Number.parseFloat((await probeVideo(restartSource.path)).format?.duration ?? "0"),
			).toBeGreaterThanOrEqual(0.8);
			expect(await value("recording")).toMatchObject({ active: true, path: restartTarget.path, fps: 5 });
			await invoke({ action: "run", name: "recording", code: "await wait(1100); return true" });
			await invoke({ action: "close", name: "recording" });
			expect(
				Number.parseFloat((await probeVideo(restartTarget.path)).format?.duration ?? "0"),
			).toBeGreaterThanOrEqual(0.8);
		} finally {
			await invoke({ action: "close", name: "recording", kill: true }).catch(() => undefined);
		}
	}, 45_000);
});
