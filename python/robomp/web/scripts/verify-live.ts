import * as fs from "node:fs/promises";
import * as path from "node:path";
import puppeteer from "puppeteer-core";

const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 } as const;

async function resolveChrome(explicit: string | undefined): Promise<string> {
  const candidates: string[] = [];
  const fromEnv = explicit ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROME_PATH;
  if (fromEnv) candidates.push(fromEnv);
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]) {
    const found = Bun.which(name);
    if (found) candidates.push(found);
  }
  candidates.push(
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // not present — try the next candidate
    }
  }
  throw new Error("No Chrome found.");
}

async function main(): Promise<void> {
  const outDir = path.resolve(import.meta.dir, "../verify-out/robomp-lifecycle-cards");
  await fs.mkdir(outDir, { recursive: true });

  const chrome = await resolveChrome(undefined);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chrome,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { ...VIEWPORT }
  });

  const page = await browser.newPage();
  const BASE_URL = "http://127.0.0.1:8099/";
  // The server at BASE_URL must be serving a FRESHLY built bundle (run
  // `bun run build` immediately before launching it); this script intentionally
  // performs no build step of its own.

  // Load page, set dark theme, reload
  await page.goto(BASE_URL, { waitUntil: "networkidle0" });
  await page.evaluate(() => {
    localStorage.setItem("omp-robomp-theme", "dark");
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await page.reload({ waitUntil: "networkidle0" });

  // 5c. Assertions on the seeded cards
  const cards = await page.evaluate(() => {
    const elements = document.querySelectorAll(".rmp-card");
    return Array.from(elements).map((el) => {
      const key = el.querySelector(".rmp-card-id")?.textContent?.trim() ?? "";
      const bucket = el.getAttribute("data-bucket") ?? "";
      const metaText = el.querySelector(".rmp-card-meta")?.textContent?.trim() ?? "";
      return { key, bucket, metaText };
    });
  });

  console.log("Seeded cards:", JSON.stringify(cards));

  const runningCard = cards.find(c => c.key.includes("widget#2"));
  const mergedCard = cards.find(c => c.key.includes("widget#4"));

  // Failed cards sort ahead of everything: the FIRST rendered card must be the
  // seeded failed issue (widget#1), not merely present somewhere in the grid.
  const failedSortedFirst = cards.length > 0 && cards[0].bucket === "failed" && cards[0].key.includes("widget#1");
  const runningCardCorrect = runningCard !== undefined && runningCard.bucket === "running" && runningCard.metaText.includes("claude-3-5-sonnet") && runningCard.metaText.includes("last action edit") && runningCard.metaText.includes("elapsed");
  const mergedExcluded = mergedCard === undefined;

  console.log(`Failed sorted first: ${failedSortedFirst}`);
  console.log(`Running card correct: ${runningCardCorrect}`);
  console.log(`Merged excluded: ${mergedExcluded}`);

  if (!failedSortedFirst || !runningCardCorrect || !mergedExcluded) {
    throw new Error("Seeded cards visual checks failed.");
  }

  await page.screenshot({ path: path.join(outDir, "live-dark.png") });
  console.log(`Live dark screenshot written to ${path.join(outDir, "live-dark.png")}`);

  // 5d. Real retry round-trip — capture the actual /api/trigger response and
  // assert the HTTP contract (202 + body) and the rendered status line BEFORE
  // confirming the DB transition, mirroring the cancel path below.
  const retryResponsePromise = page.waitForResponse(
    (resp) => new URL(resp.url()).pathname === "/api/trigger" && resp.request().method() === "POST",
    { timeout: 5000 },
  );
  // Trigger retry on widget#1 (the failed card).
  await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll(".rmp-card")).find(c => c.querySelector(".rmp-card-id")?.textContent?.includes("octo/widget#1"));
    const btn = card?.querySelector("button") as HTMLElement | null;
    btn?.click();
  });
  const retryResponse = await retryResponsePromise;
  const retryStatus = retryResponse.status();
  const retryBody = await retryResponse.json() as { delivery: string; state: string; mode: string };
  console.log(`Live retry response: ${retryStatus}`, JSON.stringify(retryBody));

  // Let the SPA render the status line from the response, then read it.
  await Bun.sleep(500);
  const retryStatusText = await page.evaluate(() => document.querySelector(".rmp-trigger-bar-status")?.textContent ?? "");
  console.log("Live retry status text:", retryStatusText);

  const retryContractOk =
    retryStatus === 202 &&
    retryBody.delivery === "seeded-fail-1" &&
    retryBody.state === "queued" &&
    retryBody.mode === "retry" &&
    retryStatusText.includes("queued retry");
  if (!retryContractOk) {
    throw new Error("Retry round-trip did not meet the live contract (HTTP 202 + body + status line).");
  }

  // Poll GET http://127.0.0.1:8099/events?limit=50 to confirm the DB transition.
  const eventsResp = await fetch("http://127.0.0.1:8099/events?limit=50");
  const eventsData = await eventsResp.json() as { events: { delivery_id: string; state: string }[] };
  const retryEvent = eventsData.events.find(e => e.delivery_id === "seeded-fail-1");
  console.log("Seeded failed retry event state:", retryEvent?.state);

  const retryOk = retryEvent !== undefined && retryEvent.state !== "failed";
  if (!retryOk) {
    throw new Error("Retry state transition did not happen in the live DB.");
  }

  // 5e. Real cancel round-trip — capture the actual /api/cancel response and
  // assert the HTTP contract (202 + body), not just the rendered status line.
  const cancelResponsePromise = page.waitForResponse(
    (resp) => new URL(resp.url()).pathname === "/api/cancel" && resp.request().method() === "POST",
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    window.confirm = () => true;
    const card = Array.from(document.querySelectorAll(".rmp-card")).find(c => c.querySelector(".rmp-card-id")?.textContent?.includes("octo/widget#2"));
    const btn = card?.querySelector("button.danger") as HTMLElement | null;
    btn?.click();
  });
  const cancelResponse = await cancelResponsePromise;
  const cancelStatus = cancelResponse.status();
  const cancelBody = await cancelResponse.json() as { delivery: string; fired: boolean; previous_state: string };
  console.log(`Live cancel response: ${cancelStatus}`, JSON.stringify(cancelBody));

  // Let the SPA render the status line from the response, then read it.
  await Bun.sleep(500);
  const statusText = await page.evaluate(() => document.querySelector(".rmp-trigger-bar-status")?.textContent ?? "");
  console.log("Live cancel status text:", statusText);

  const cancelOk =
    cancelStatus === 202 &&
    cancelBody.delivery === "seeded-run-2" &&
    cancelBody.fired === false &&
    cancelBody.previous_state === "running" &&
    statusText.includes("cancel signaled: seeded-r (fired=false)");
  if (!cancelOk) {
    throw new Error("Cancel round-trip did not meet the live contract (HTTP 202 + body + status line).");
  }

  console.log("Live capstone round-trip checks PASS!");

  await browser.close();
}

main().catch(err => {
  console.error("Live verification crashed:", err);
  process.exit(1);
});
