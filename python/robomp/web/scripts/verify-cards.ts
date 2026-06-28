#!/usr/bin/env bun
/**
 * Robomp Lifecycle Cards Verification Harness.
 * Drives headless Chrome to assert layout, contrast, interactions, and edge cases.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HTTPRequest } from "puppeteer-core";
import puppeteer from "puppeteer-core";
import type { StatusResponse } from "../src/types";

const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 } as const;

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

// Resolve a Chrome/Chromium binary. Walks the explicit path, PATH lookups via
// Bun.which, and well-known absolute locations; each candidate is confirmed
// with fs.stat so a directory or stale entry never wins.
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
  throw new Error("No Chrome/Chromium found. Pass --chrome <path> or set PUPPETEER_EXECUTABLE_PATH.");
}

const baseStatus: StatusResponse = {
  runtime: {
    bot_login: "robomp-bot",
    repo_allowlist: ["octo/widget"],
    max_concurrency: 1,
    model: "test-model",
    thinking_level: "low",
    uptime_seconds: 120,
  },
  event_counts: { queued: 0, running: 0, done: 0, failed: 0, skipped: 0 },
  issue_event_counts: { queued: 0, running: 0, done: 0, failed: 0, skipped: 0 },
  running_events: [],
  inflight: [],
  issues: [],
  recent_events: [],
};

const populatedStatus: StatusResponse = {
  runtime: {
    bot_login: "robomp-bot",
    repo_allowlist: ["octo/widget"],
    max_concurrency: 1,
    model: "test-model",
    thinking_level: "low",
    uptime_seconds: 120,
  },
  event_counts: { queued: 1, running: 1, done: 0, failed: 2, skipped: 0 },
  issue_event_counts: { queued: 1, running: 1, done: 0, failed: 2, skipped: 0 },
  running_events: [
    {
      delivery_id: "run-del-2",
      event_type: "issue_comment",
      repo: "octo/widget",
      issue_key: "octo/widget#2",
      received_at: "2026-06-18T00:00:00Z",
      started_at: "2026-06-18T00:01:00Z",
      attempts: 1,
      model: "claude-3-5",
      last_tool: "edit",
      last_tool_ts: "2026-06-18T00:01:10Z"
    },
    {
      delivery_id: "run-del-9",
      event_type: "issue_comment",
      repo: "octo/widget",
      issue_key: "octo/widget#9",
      received_at: "2026-06-18T00:00:00Z",
      started_at: null,
      attempts: 1,
      model: null,
      last_tool: null,
      last_tool_ts: null
    },
    {
      delivery_id: "run-del-5",
      event_type: "issue_comment",
      repo: "octo/widget",
      issue_key: null,
      received_at: "2026-06-18T00:00:00Z",
      started_at: "2026-06-18T00:01:00Z",
      attempts: 1,
      model: "claude-3-5",
      last_tool: "edit",
      last_tool_ts: null
    }
  ],
  inflight: ["octo/widget#2", "octo/widget#7"],
  issues: [
    {
      key: "octo/widget#1",
      repo: "octo/widget",
      number: 1,
      branch: null,
      pr_number: null,
      state: "fixing",
      classification: "bug",
      updated_at: "2026-06-18T00:00:00Z",
      latest_event: {
        delivery_id: "fail-del-1",
        event_type: "issues",
        state: "failed",
        attempts: 1,
        received_at: "2026-06-18T00:00:00Z",
        last_error: "triage failed error"
      }
    },
    {
      key: "octo/widget#2",
      repo: "octo/widget",
      number: 2,
      branch: "fix-branch",
      pr_number: 42,
      state: "reproducing",
      classification: "bug",
      updated_at: "2026-06-18T00:00:00Z",
      latest_event: {
        delivery_id: "run-del-2",
        event_type: "issue_comment",
        state: "running",
        attempts: 1,
        received_at: "2026-06-18T00:00:00Z",
        last_error: null
      }
    },
    {
      key: "octo/widget#3",
      repo: "octo/widget",
      number: 3,
      branch: null,
      pr_number: null,
      state: "new",
      classification: "bug",
      updated_at: "2026-06-18T00:00:00Z",
      latest_event: {
        delivery_id: "queued-del-3",
        event_type: "issues",
        state: "queued",
        attempts: 1,
        received_at: "2026-06-18T00:00:00Z",
        last_error: null
      }
    },
    {
      key: "octo/widget#4",
      repo: "octo/widget",
      number: 4,
      branch: null,
      pr_number: null,
      state: "new",
      classification: "bug",
      updated_at: "2026-06-18T00:00:00Z",
      latest_event: null
    },
    {
      key: "octo/widget#8",
      repo: "octo/widget",
      number: 8,
      branch: null,
      pr_number: null,
      state: "fixing",
      classification: "bug",
      updated_at: "2026-06-18T00:00:00Z",
      latest_event: {
        delivery_id: "fail-del-8",
        event_type: "issues",
        state: "failed",
        attempts: 1,
        received_at: "2026-06-18T00:00:00Z",
        last_error: null
      }
    },
    {
      key: "octo/widget#9",
      repo: "octo/widget",
      number: 9,
      branch: null,
      pr_number: null,
      state: "reproducing",
      classification: "bug",
      updated_at: "2026-06-18T00:00:00Z",
      latest_event: {
        delivery_id: "run-del-9",
        event_type: "issue_comment",
        state: "running",
        attempts: 1,
        received_at: "2026-06-18T00:00:00Z",
        last_error: null
      }
    },
    {
      key: "octo/widget#10",
      repo: "octo/widget",
      number: 10,
      branch: null,
      pr_number: null,
      state: "merged",
      classification: "bug",
      updated_at: "2026-06-18T00:02:00Z",
      latest_event: {
        delivery_id: "done-del",
        event_type: "issues",
        state: "done",
        attempts: 1,
        received_at: "2026-06-18T00:02:00Z",
        last_error: null
      }
    },
    {
      key: "octo/widget#11",
      repo: "octo/widget",
      number: 11,
      branch: null,
      pr_number: null,
      state: "reproducing",
      classification: "bug",
      updated_at: "2026-06-18T00:00:00Z",
      latest_event: {
        delivery_id: "latest-run-del-11",
        event_type: "issue_comment",
        state: "running",
        attempts: 1,
        received_at: "2026-06-18T00:00:00Z",
        last_error: null
      }
    }
  ],
  recent_events: [
    {
      delivery_id: "superseded-del",
      event_type: "issues",
      repo: "octo/widget",
      issue_key: "octo/widget#10",
      state: "failed",
      attempts: 1,
      received_at: "2026-06-18T00:00:00Z",
      last_error: "old error",
      issue_state: "merged"
    },
    {
      delivery_id: "fail-del-6",
      event_type: "issues",
      repo: "octo/widget",
      issue_key: null,
      state: "failed",
      attempts: 1,
      received_at: "2026-06-18T00:00:00Z",
      last_error: "orphan failed error",
      issue_state: null
    }
  ]
};

async function main(): Promise<void> {
  const outDir = path.resolve(import.meta.dir, "../verify-out/robomp-lifecycle-cards");
  await fs.mkdir(path.join(outDir, "shots"), { recursive: true });

  const chrome = await resolveChrome(undefined);
  console.log(`Chrome resolved: ${chrome}`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chrome,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ],
    defaultViewport: { ...VIEWPORT },
  });

  const page = await browser.newPage();
  await page.setRequestInterception(true);

  let statusMock: StatusResponse = baseStatus;
  let statusDelayMs = 0;
  let customIndexHtml: string | null = null;
  // When set, /api/trigger answers POSTs with an error status + detail body so
  // the retry-failure surface (e.g. the Activity status line) can be asserted.
  let triggerErrorDetail: string | null = null;

  // Intercept trigger / cancel requests for asserting later. Bodies are
  // narrowed to a record (or null) so property checks below stay type-safe
  // instead of reaching into `unknown`.
  const triggeredRequests: { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];

  page.on("request", async (req: HTTPRequest) => {
    const url = new URL(req.url());

    if (req.resourceType() === "document" && customIndexHtml !== null) {
      req.respond({
        status: 200,
        contentType: "text/html",
        body: customIndexHtml,
      });
      return;
    }

    if (url.pathname === "/api/status") {
      if (statusDelayMs > 0) {
        await Bun.sleep(statusDelayMs);
      }
      req.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(statusMock),
      });
    } else if (url.pathname === "/api/logs") {
      req.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entries: [], count: 0, limit: 400 }),
      });
    } else if (url.pathname === "/api/github/issues") {
      req.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ issues: [], errors: [], repos: ["octo/widget"], cache: { hit: false, fetched_at: 0 } }),
      });
    } else if (url.pathname === "/api/trigger" && req.method() === "POST") {
      const parsedBody: Record<string, unknown> | null = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : null;
      const deliveryId = parsedBody?.delivery_id;
      const mode = parsedBody?.mode;
      triggeredRequests.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers() as Record<string, string>,
        body: parsedBody,
      });
      if (triggerErrorDetail !== null) {
        req.respond({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: triggerErrorDetail }),
        });
      } else {
        req.respond({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            delivery: (typeof deliveryId === "string" && deliveryId) ? deliveryId : "manual-trigger",
            state: "queued",
            mode: (typeof mode === "string" && mode) ? mode : "triage",
          }),
        });
      }
    } else if (url.pathname === "/api/cancel" && req.method() === "POST") {
      const parsedBody: Record<string, unknown> | null = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : null;
      const deliveryId = parsedBody?.delivery_id;
      triggeredRequests.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers() as Record<string, string>,
        body: parsedBody,
      });
      req.respond({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          delivery: (typeof deliveryId === "string" && deliveryId) ? deliveryId : "cancel-trigger",
          fired: false,
          previous_state: "running",
        }),
      });
    } else {
      req.continue();
    }
  });

  const BASE_URL = "http://127.0.0.1:8099/";

  // 1. Skeleton state
  statusMock = baseStatus;
  statusDelayMs = 600;
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  
  // Wait a small frame but not full delay
  await Bun.sleep(100);
  const skeletonsCount = await page.evaluate(() => document.querySelectorAll(".rmp-card-skeleton").length);
  const cardsCount = await page.evaluate(() => document.querySelectorAll(".rmp-card").length);
  results.push({
    name: "skeleton-state",
    ok: skeletonsCount >= 2 && cardsCount === 0,
    detail: `Found ${skeletonsCount} skeletons and ${cardsCount} cards.`,
  });
  await page.screenshot({ path: path.join(outDir, "shots/skeleton.png") });

  statusDelayMs = 0; // reset delay

  // 2. Empty state + allowlist
  statusMock = {
    ...baseStatus,
    runtime: {
      ...baseStatus.runtime,
      repo_allowlist: ["octo/widget", "octo/robomp"],
    },
  };
  await page.goto(BASE_URL, { waitUntil: "networkidle0" });
  const emptyText = await page.evaluate(() => document.querySelector(".rmp-pipeline-empty")?.textContent ?? "");
  results.push({
    name: "empty-state-allowlist",
    ok: emptyText.includes("No active work") && emptyText.includes("watching octo/widget, octo/robomp"),
    detail: `Empty text: "${emptyText}"`,
  });
  await page.screenshot({ path: path.join(outDir, "shots/empty-dark.png") });

  // Helper for applying theme
  const applyTheme = async (themeName: "dark" | "light") => {
    await page.evaluate((theme) => {
      localStorage.setItem("omp-robomp-theme", theme);
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }, themeName);
    await page.reload({ waitUntil: "networkidle0" });
  };

  // 3. Populated state - Dark Theme
  statusMock = populatedStatus;
  await page.goto(BASE_URL, { waitUntil: "networkidle0" });
  await applyTheme("dark");

  const cards = await page.evaluate(() => {
    const elements = document.querySelectorAll(".rmp-card");
    return Array.from(elements).map((el) => {
      const key = el.querySelector(".rmp-card-id")?.textContent?.trim() ?? "";
      const bucket = el.getAttribute("data-bucket") ?? "";
      const errorText = el.querySelector(".rmp-card-error")?.textContent?.trim() ?? "";
      const actions = Array.from(el.querySelectorAll(".rmp-card-actions button")).map(b => b.textContent?.trim());
      const metaText = el.querySelector(".rmp-card-meta")?.textContent?.trim() ?? "";
      const text = el.textContent ?? "";
      const stepper = el.querySelector(".rmp-step") !== null;
      const currentStep = el.querySelector(".rmp-step-node[data-state='current']") !== null;
      const liveStep = el.querySelector(".rmp-step-node[data-live='true']") !== null;
      const failedStep = el.querySelector(".rmp-step-node[data-state='failed']") !== null;
      return { key, bucket, errorText, actions, metaText, text, stepper, currentStep, liveStep, failedStep };
    });
  });

  console.log("All resolved cards:", JSON.stringify(cards));
  const fullFailedCard = cards.find(c => c.key === "bugocto/widget#1");
  const runningCard = cards.find(c => c.key === "bugocto/widget#2");
  const inflightOnlyCard = cards.find(c => c.key === "issueocto/widget#7");
  const compactOrphanRunning = cards.find(c => c.key === "run-del-");
  const compactOrphanFailed = cards.find(c => c.key === "fail-del");
  const failedWithoutErr = cards.find(c => c.key === "bugocto/widget#8");
  const runningWithInvalidTs = cards.find(c => c.key === "bugocto/widget#9");
  const queuedCard = cards.find(c => c.key === "bugocto/widget#3");
  const activeCard = cards.find(c => c.key === "bugocto/widget#4");
  // Latest-event-only running: issue.latest_event is running but no matching
  // running_events row and not inflight (live === null, inflightOnly === false).
  const latestEventOnlyRunning = cards.find(c => c.key === "bugocto/widget#11");

  // Check failed full card
  results.push({
    name: "failed-full-card",
    ok: !!fullFailedCard && fullFailedCard.bucket === "failed" && fullFailedCard.errorText === "triage failed error" && fullFailedCard.actions.includes("retry"),
    detail: `Failed full card check: ${JSON.stringify(fullFailedCard)}`,
  });

  // Check running full card
  results.push({
    name: "running-full-card",
    ok: !!runningCard && runningCard.bucket === "running" && runningCard.metaText.includes("claude-3-5") && runningCard.metaText.includes("last action edit") && runningCard.actions.includes("cancel"),
    detail: `Running full card check: ${JSON.stringify(runningCard)}`,
  });

  // Check inflight-only card
  results.push({
    name: "inflight-only-card",
    ok: !!inflightOnlyCard && inflightOnlyCard.bucket === "running" && inflightOnlyCard.metaText.includes("held by pool") && inflightOnlyCard.actions.length === 0 && inflightOnlyCard.stepper && inflightOnlyCard.liveStep,
    detail: `Inflight-only card check: ${JSON.stringify(inflightOnlyCard)}`,
  });

  // Check compact orphan running
  results.push({
    name: "compact-orphan-running",
    ok: !!compactOrphanRunning && compactOrphanRunning.bucket === "running" && !compactOrphanRunning.stepper && compactOrphanRunning.actions.includes("cancel"),
    detail: `Compact orphan running check: ${JSON.stringify(compactOrphanRunning)}`,
  });

  // Check compact orphan failed
  results.push({
    name: "compact-orphan-failed",
    ok: !!compactOrphanFailed && compactOrphanFailed.bucket === "failed" && !compactOrphanFailed.stepper && compactOrphanFailed.actions.includes("retry"),
    detail: `Compact orphan failed check: ${JSON.stringify(compactOrphanFailed)}`,
  });

  // Check failed without error text
  results.push({
    name: "failed-without-error-text",
    ok: !!failedWithoutErr && failedWithoutErr.bucket === "failed" && failedWithoutErr.errorText === "" && failedWithoutErr.actions.includes("retry"),
    detail: `Failed without error text check: ${JSON.stringify(failedWithoutErr)}`,
  });

  // Check invalid/missing started_at on running item elapsed renders "—"
  results.push({
    name: "invalid-missing-started-at-elapsed",
    ok: !!runningWithInvalidTs && runningWithInvalidTs.metaText.includes("elapsed —"),
    detail: `Running with invalid ts check: ${JSON.stringify(runningWithInvalidTs)}`,
  });

  // Check queued full card — non-terminal issue whose latest event is queued.
  results.push({
    name: "queued-full-card",
    ok: !!queuedCard && queuedCard.bucket === "queued" && queuedCard.stepper && queuedCard.currentStep && queuedCard.actions.length === 0,
    detail: `Queued full card check: ${JSON.stringify(queuedCard)}`,
  });

  // Check active full card — non-terminal issue with no latest event yet.
  results.push({
    name: "active-full-card",
    ok: !!activeCard && activeCard.bucket === "active" && activeCard.stepper && activeCard.currentStep && activeCard.actions.length === 0,
    detail: `Active full card check: ${JSON.stringify(activeCard)}`,
  });

  // Latest-event-only running card — renders as running (latest_event state),
  // but with NO live row it must not expose cancel (nothing to kill) and must
  // not mark a lifecycle step live (no real subprocess heartbeat).
  results.push({
    name: "latest-event-only-running-no-cancel-no-live-step",
    ok: !!latestEventOnlyRunning &&
      latestEventOnlyRunning.bucket === "running" &&
      !latestEventOnlyRunning.actions.includes("cancel") &&
      latestEventOnlyRunning.stepper &&
      !latestEventOnlyRunning.liveStep,
    detail: `Latest-event-only running card check: ${JSON.stringify(latestEventOnlyRunning)}`,
  });

  // Failed cards must sort ahead of every other bucket: the first rendered
  // card is a failed card (DOM order mirrors buildWorkItems sort order).
  results.push({
    name: "failed-sorts-first",
    ok: cards.length > 0 && cards[0].bucket === "failed",
    detail: `First rendered card: ${JSON.stringify(cards[0] ?? null)}`,
  });

  // Stepper state indicators (existing data attributes, not invented):
  // the running card's current node is marked live; the failed card's
  // current node carries the failed state.
  results.push({
    name: "stepper-running-live-node",
    ok: !!runningCard && runningCard.currentStep && runningCard.liveStep,
    detail: `Running card stepper currentStep=${runningCard?.currentStep} liveStep=${runningCard?.liveStep}`,
  });
  results.push({
    name: "stepper-failed-node",
    ok: !!fullFailedCard && fullFailedCard.failedStep,
    detail: `Failed card stepper failedStep=${fullFailedCard?.failedStep}`,
  });

  // Check superseded + terminal exclusion against the rendered lifecycle-card
  // model above, not document.body. Activity stays mounted while hidden and may
  // legitimately contain historical terminal events.
  const terminalLeakKeys = cards
    .filter(
      (card) =>
        card.text.includes("superseded-del") ||
        card.text.includes("done-del") ||
        card.text.includes("octo/widget#10"),
    )
    .map((card) => card.key);
  results.push({
    name: "superseded-terminal-exclusion-visual",
    ok: terminalLeakKeys.length === 0,
    detail: `Terminal/superseded card keys: ${terminalLeakKeys.join(", ") || "none"}`,
  });
  const debugTextContrast = await page.evaluate(() => {
    const getLuminance = (str: string): number => {
      const s = str.trim().toLowerCase();
      if (s.startsWith("lab")) {
        const m = s.match(/lab\(([\d.]+)\s+([\d.-]+)\s+([\d.-]+)/);
        if (m) {
          const L = parseFloat(m[1]);
          return L > 8 ? Math.pow((L + 16) / 116, 3) : L / 903.3;
        }
      }
      const mRgb = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (mRgb) {
        const r = parseInt(mRgb[1]), g = parseInt(mRgb[2]), b = parseInt(mRgb[3]);
        const a = [r, g, b].map(v => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
      }
      return 0;
    };

    const getContrast = (c1: string, c2: string): number => {
      const lum1 = getLuminance(c1);
      const lum2 = getLuminance(c2);
      return (Math.max(lum1, lum2) + 0.05) / (Math.min(lum1, lum2) + 0.05);
    };

    const getBgColor = (el: Element, fallback = "lab(15 0 0)"): string => {
      let cur: Element | null = el;
      while (cur) {
        const bg = window.getComputedStyle(cur).backgroundColor;
        if (bg && bg !== "transparent" && !bg.includes("rgba(0, 0, 0, 0)")) {
          return bg;
        }
        cur = cur.parentElement;
      }
      return fallback;
    };

    const meta = document.querySelector(".rmp-card-meta");
    const label = document.querySelector(".rmp-step-label");
    const error = document.querySelector(".rmp-card-error");
    const pill = document.querySelector(".pill");

    const getElDetails = (el: Element | null) => {
      if (!el) return null;
      const fg = window.getComputedStyle(el).color;
      const bg = getBgColor(el);
      const ratio = getContrast(fg, bg);
      return {
        tag: el.tagName,
        class: el.className,
        text: el.textContent?.trim()?.slice(0, 30),
        fgStr: fg,
        bgStr: bg,
        ratio
      };
    };

    return {
      meta: getElDetails(meta),
      label: getElDetails(label),
      error: getElDetails(error),
      pill: getElDetails(pill),
    };
  });
  console.log("Contrast diagnostics (dark theme):", JSON.stringify(debugTextContrast, null, 2));

  // Contrast & structural checks (dark theme)
  const structuralCheck = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".rmp-card"));
    
    // borders and shadows
    const borderShadowOk = cards.every(el => {
      const style = window.getComputedStyle(el);
      const radius = style.borderRadius;
      const shadow = style.boxShadow;
      const bl = parseFloat(style.borderLeftWidth);
      const br = parseFloat(style.borderRightWidth);
      return radius === "8px" && (shadow === "none" || shadow.includes("0px 0px 0px") || shadow === "") && bl <= 1.05 && br <= 1.05;
    });

    const getLuminance = (str: string): number => {
      const s = str.trim().toLowerCase();
      if (s.startsWith("lab")) {
        const m = s.match(/lab\(([\d.]+)\s+([\d.-]+)\s+([\d.-]+)/);
        if (m) {
          const L = parseFloat(m[1]);
          return L > 8 ? Math.pow((L + 16) / 116, 3) : L / 903.3;
        }
      }
      const mRgb = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (mRgb) {
        const r = parseInt(mRgb[1]), g = parseInt(mRgb[2]), b = parseInt(mRgb[3]);
        const a = [r, g, b].map(v => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
      }
      return 0;
    };

    const getContrast = (c1: string, c2: string): number => {
      const lum1 = getLuminance(c1);
      const lum2 = getLuminance(c2);
      return (Math.max(lum1, lum2) + 0.05) / (Math.min(lum1, lum2) + 0.05);
    };

    const getBgColor = (el: Element): string => {
      let cur: Element | null = el;
      while (cur) {
        const bg = window.getComputedStyle(cur).backgroundColor;
        if (bg && bg !== "transparent" && !bg.includes("rgba(0, 0, 0, 0)")) {
          return bg;
        }
        cur = cur.parentElement;
      }
      return "lab(15 0 0)";
    };

    const metaElements = Array.from(document.querySelectorAll(".rmp-card-meta"));
    const labelElements = Array.from(document.querySelectorAll(".rmp-step-label"));
    const errorElements = Array.from(document.querySelectorAll(".rmp-card-error"));
    const pillElements = Array.from(document.querySelectorAll(".pill"));

    const textElements = [...metaElements, ...labelElements, ...errorElements];
    const textContrastOk = textElements.every(el => {
      const fg = window.getComputedStyle(el).color;
      const bg = getBgColor(el);
      const ratio = getContrast(fg, bg);
      return ratio >= 4.5;
    });

    const pillContrastOk = pillElements.every(el => {
      const fg = window.getComputedStyle(el).color;
      const bg = getBgColor(el);
      const ratio = getContrast(fg, bg);
      return ratio >= 3.0;
    });

    return { borderShadowOk, textContrastOk, pillContrastOk };
  });

  results.push({
    name: "dark-theme-structural",
    ok: structuralCheck.borderShadowOk,
    detail: "Computed borderRadius, boxShadow, and border widths match constraints.",
  });

  results.push({
    name: "dark-theme-text-contrast",
    ok: structuralCheck.textContrastOk,
    detail: "Text elements meta/label/error contrast ratio >= 4.5 against card backgrounds.",
  });

  results.push({
    name: "dark-theme-pill-contrast",
    ok: structuralCheck.pillContrastOk,
    detail: "Pill elements contrast ratio >= 3.0 against card backgrounds.",
  });

  await page.screenshot({ path: path.join(outDir, "shots/populated-dark-replay.png") });

  // 4. Populated state - Light Theme
  await applyTheme("light");

  const lightThemeChecks = await page.evaluate(() => {
    const getLuminance = (str: string): number => {
      const s = str.trim().toLowerCase();
      if (s.startsWith("lab")) {
        const m = s.match(/lab\(([\d.]+)\s+([\d.-]+)\s+([\d.-]+)/);
        if (m) {
          const L = parseFloat(m[1]);
          return L > 8 ? Math.pow((L + 16) / 116, 3) : L / 903.3;
        }
      }
      const mRgb = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (mRgb) {
        const r = parseInt(mRgb[1]), g = parseInt(mRgb[2]), b = parseInt(mRgb[3]);
        const a = [r, g, b].map(v => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
      }
      return 1.0;
    };

    const getContrast = (c1: string, c2: string): number => {
      const lum1 = getLuminance(c1);
      const lum2 = getLuminance(c2);
      return (Math.max(lum1, lum2) + 0.05) / (Math.min(lum1, lum2) + 0.05);
    };

    const getBgColor = (el: Element): string => {
      let cur: Element | null = el;
      while (cur) {
        const bg = window.getComputedStyle(cur).backgroundColor;
        if (bg && bg !== "transparent" && !bg.includes("rgba(0, 0, 0, 0)")) {
          return bg;
        }
        cur = cur.parentElement;
      }
      return "lab(100 0 0)";
    };

    const metaElements = Array.from(document.querySelectorAll(".rmp-card-meta"));
    const labelElements = Array.from(document.querySelectorAll(".rmp-step-label"));
    const errorElements = Array.from(document.querySelectorAll(".rmp-card-error"));
    const pillElements = Array.from(document.querySelectorAll(".pill"));

    const textElements = [...metaElements, ...labelElements, ...errorElements];
    const textContrastOk = textElements.every(el => {
      const fg = window.getComputedStyle(el).color;
      const bg = getBgColor(el);
      const ratio = getContrast(fg, bg);
      return ratio >= 4.5;
    });

    const pillContrastOk = pillElements.every(el => {
      const fg = window.getComputedStyle(el).color;
      const bg = getBgColor(el);
      const ratio = getContrast(fg, bg);
      return ratio >= 3.0;
    });

    return { textContrastOk, pillContrastOk };
  });

  results.push({
    name: "light-theme-text-contrast",
    ok: lightThemeChecks.textContrastOk,
    detail: "Light theme: text elements meta/label/error contrast ratio >= 4.5.",
  });

  results.push({
    name: "light-theme-pill-contrast",
    ok: lightThemeChecks.pillContrastOk,
    detail: "Light theme: pill elements contrast ratio >= 3.0.",
  });

  await page.screenshot({ path: path.join(outDir, "shots/populated-light-replay.png") });

  // 5. Read-only pass
  // Fetch the real index.html from server, and replace the robomp-config script tag
  const resp = await fetch(BASE_URL);
  let html = await resp.text();
  html = html.replace(
    /<script id="robomp-config" type="application\/json">[^<]*<\/script>/,
    '<script id="robomp-config" type="application/json">{"replayEnabled":false,"replayToken":""}</script>'
  );
  customIndexHtml = html;

  // Reload page to parse with read-only config
  await page.goto(BASE_URL, { waitUntil: "networkidle0" });
  await applyTheme("dark");

  const readonly = await page.evaluate(() => {
    const bar = document.querySelector(".rmp-trigger-bar");
    return {
      chipText: bar?.querySelector(".rmp-readonly-chip")?.textContent?.trim() ?? "",
      barInputs: document.querySelectorAll(".rmp-trigger-bar input").length,
      barButtons: document.querySelectorAll(".rmp-trigger-bar button").length,
      cardActionButtons: document.querySelectorAll(".rmp-card-actions button").length,
      cardActionWrappers: document.querySelectorAll(".rmp-card-actions").length,
    };
  });

  results.push({
    name: "readonly-actions-disabled",
    ok:
      readonly.chipText.includes("trigger disabled · read-only") &&
      readonly.barInputs === 0 &&
      readonly.barButtons === 0 &&
      readonly.cardActionButtons === 0 &&
      readonly.cardActionWrappers === 0,
    detail: `Trigger-bar chip: "${readonly.chipText}". Trigger-bar inputs: ${readonly.barInputs}, buttons: ${readonly.barButtons}. Card action buttons: ${readonly.cardActionButtons}, wrappers: ${readonly.cardActionWrappers}.`,
  });

  await page.screenshot({ path: path.join(outDir, "shots/populated-dark-readonly.png") });

  customIndexHtml = null; // restore index intercept

  // 6. Responsive check
  await page.setViewport({ width: 380, height: 720 });
  await page.goto(BASE_URL, { waitUntil: "networkidle0" });
  await applyTheme("dark");

  const responsiveOk = await page.evaluate(() => {
    const grid = document.querySelector(".rmp-card-grid");
    if (!grid) return false;
    const cards = Array.from(document.querySelectorAll(".rmp-card"));

    // Single column: every card fits within the grid's content width. A card
    // wider than the grid (allowing 1px sub-pixel rounding) means it broke out
    // of the column and must fail.
    const gridWidth = grid.getBoundingClientRect().width;
    const allCardsWithinGrid = cards.every(c => {
      const cardWidth = c.getBoundingClientRect().width;
      return cardWidth <= gridWidth + 1;
    });

    // Content doesn't overflow card container.
    const noCardOverflow = cards.every(c => {
      return c.scrollWidth <= c.clientWidth + 1;
    });

    // The page itself must not scroll horizontally: document and body content
    // width stay within their client width (1px tolerance for rounding).
    const docEl = document.documentElement;
    const noPageOverflow =
      docEl.scrollWidth <= docEl.clientWidth + 1 &&
      document.body.scrollWidth <= document.body.clientWidth + 1;

    return allCardsWithinGrid && noCardOverflow && noPageOverflow;
  });
  const debugResponsive = await page.evaluate(() => {
    const grid = document.querySelector(".rmp-card-grid");
    const cards = Array.from(document.querySelectorAll(".rmp-card"));
    const docEl = document.documentElement;
    return {
      gridWidth: grid ? grid.getBoundingClientRect().width : 0,
      maxCardWidth: cards.reduce((m, c) => Math.max(m, c.getBoundingClientRect().width), 0),
      docScrollWidth: docEl.scrollWidth,
      docClientWidth: docEl.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
    };
  });
  console.log("Debug responsive widths:", JSON.stringify(debugResponsive));
  results.push({
    name: "responsive-single-column-no-overflow",
    ok: responsiveOk,
    detail: `At width 380: every card fits within the grid and neither cards nor the page scroll horizontally. Grid: ${debugResponsive.gridWidth}, maxCard: ${debugResponsive.maxCardWidth}, doc: ${debugResponsive.docScrollWidth}/${debugResponsive.docClientWidth}, body: ${debugResponsive.bodyScrollWidth}/${debugResponsive.bodyClientWidth}`,
  });

  await page.screenshot({ path: path.join(outDir, "shots/responsive-dark.png") });

  // Restore viewport
  await page.setViewport({ ...VIEWPORT });

  // 7. Reduced motion check.
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

  // 7a. Skeleton phase — delay the status response so the loading skeleton is
  //     actually on screen, then assert its pulse animation is suppressed
  //     WHILE skeleton elements exist (the old check ran after data loaded, so
  //     no skeleton was present and the assertion was vacuous).
  statusMock = baseStatus;
  statusDelayMs = 600;
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await Bun.sleep(150); // inside the delay window: skeleton still rendered
  const reducedSkeleton = await page.evaluate(() => {
    const skeletons = Array.from(document.querySelectorAll(".rmp-card-skeleton"));
    return {
      count: skeletons.length,
      allDisabled: skeletons.every((el) => window.getComputedStyle(el).animationName === "none"),
    };
  });
  statusDelayMs = 0;
  results.push({
    name: "reduced-motion-skeleton-animation-disabled",
    ok: reducedSkeleton.count >= 2 && reducedSkeleton.allDisabled,
    detail: `Skeletons present: ${reducedSkeleton.count}, all animations disabled: ${reducedSkeleton.allDisabled}`,
  });

  // 7b. Populated phase — once cards render, the live stepper node and card
  //     element exist; assert their animation/transition are suppressed too.
  statusMock = populatedStatus;
  await page.goto(BASE_URL, { waitUntil: "networkidle0" });
  const reducedPopulated = await page.evaluate(() => {
    const liveStepNode = document.querySelector(".rmp-step-node[data-live='true']");
    const nodeStyle = liveStepNode ? window.getComputedStyle(liveStepNode).animationName : "none";
    const card = document.querySelector(".rmp-card");
    const cardTransition = card ? window.getComputedStyle(card).transition : "none";
    return {
      liveNodePresent: liveStepNode !== null,
      nodeAnimationOff: nodeStyle === "none" || nodeStyle === "",
      cardTransitionOff: cardTransition.includes("none") || cardTransition === "all 0s" || cardTransition === "",
    };
  });
  results.push({
    name: "reduced-motion-node-and-card-animations-disabled",
    ok: reducedPopulated.liveNodePresent && reducedPopulated.nodeAnimationOff && reducedPopulated.cardTransitionOff,
    detail: `Live node present: ${reducedPopulated.liveNodePresent}, node animation off: ${reducedPopulated.nodeAnimationOff}, card transition off: ${reducedPopulated.cardTransitionOff}`,
  });

  // Restore media features
  await page.emulateMediaFeatures([]);

  // 8. Interactions (clicks).
  // Serve a replay-enabled index with a KNOWN token so every privileged
  // request carries an auditable `X-Robomp-Replay-Token: trigger-secret`
  // header, independent of whatever token the live server was started with.
  const REPLAY_TOKEN = "trigger-secret";
  const replayResp = await fetch(BASE_URL);
  const replayHtml = (await replayResp.text()).replace(
    /<script id="robomp-config" type="application\/json">[^<]*<\/script>/,
    `<script id="robomp-config" type="application/json">{"replayEnabled":true,"replayToken":"${REPLAY_TOKEN}"}</script>`,
  );
  customIndexHtml = replayHtml;
  statusMock = populatedStatus;
  await page.goto(BASE_URL, { waitUntil: "networkidle0" });
  await applyTheme("dark");

  // A. Retry click — exactly one POST /api/trigger {mode:"retry", delivery_id}
  //    carrying the replay token.
  triggeredRequests.length = 0;
  await page.evaluate(() => {
    const btn = document.querySelector(".rmp-card[data-bucket='failed'] button") as HTMLElement | null;
    btn?.click();
  });
  await Bun.sleep(100); // wait for request and state update
  const retryReqs = triggeredRequests.filter(
    (r) => r.url.endsWith("/api/trigger") && r.body?.mode === "retry" && r.body?.delivery_id === "fail-del-1",
  );
  const statusTextA = await page.evaluate(() => document.querySelector(".rmp-trigger-bar-status")?.textContent ?? "");
  results.push({
    name: "interaction-retry-click",
    ok: retryReqs.length === 1 && retryReqs[0].headers["x-robomp-replay-token"] === REPLAY_TOKEN && statusTextA.includes("queued retry: fail-del-1"),
    detail: `Matching retry requests: ${retryReqs.length}, token: "${retryReqs[0]?.headers["x-robomp-replay-token"] ?? ""}". Status text: "${statusTextA}"`,
  });

  // B. Cancel click (confirm accepted) — exactly one POST /api/cancel
  //    {delivery_id} carrying the replay token.
  triggeredRequests.length = 0;
  await page.evaluate(() => {
    window.confirm = () => true;
    const card = Array.from(document.querySelectorAll(".rmp-card")).find(c => c.querySelector(".rmp-card-id")?.textContent?.includes("octo/widget#2"));
    const btn = card?.querySelector("button.danger") as HTMLElement | null;
    btn?.click();
  });
  await Bun.sleep(100);
  const cancelReqs = triggeredRequests.filter(
    (r) => r.url.endsWith("/api/cancel") && r.body?.delivery_id === "run-del-2",
  );
  const statusTextB = await page.evaluate(() => document.querySelector(".rmp-trigger-bar-status")?.textContent ?? "");
  results.push({
    name: "interaction-cancel-click-accepted",
    ok: cancelReqs.length === 1 && cancelReqs[0].headers["x-robomp-replay-token"] === REPLAY_TOKEN && statusTextB.includes("cancel signaled: run-del- (fired=false)"),
    detail: `Matching cancel requests: ${cancelReqs.length}, token: "${cancelReqs[0]?.headers["x-robomp-replay-token"] ?? ""}". Status text: "${statusTextB}"`,
  });

  // C. Cancel click (confirm dismissed) — verbatim confirm gate suppresses the
  //    request entirely; assert zero /api/cancel requests fire.
  triggeredRequests.length = 0;
  await page.evaluate(() => {
    window.confirm = () => false;
    const card = Array.from(document.querySelectorAll(".rmp-card")).find(c => c.querySelector(".rmp-card-id")?.textContent?.includes("octo/widget#2"));
    const btn = card?.querySelector("button.danger") as HTMLElement | null;
    btn?.click();
  });
  await Bun.sleep(100);
  const dismissedCancelReqs = triggeredRequests.filter((r) => r.url.endsWith("/api/cancel"));
  results.push({
    name: "interaction-cancel-click-dismissed",
    ok: dismissedCancelReqs.length === 0,
    detail: `Cancel requests fired after dismissal: ${dismissedCancelReqs.length}`,
  });

  // D. Trigger bar triage click — exactly one POST /api/trigger
  //    {mode:"triage", issue} carrying the replay token.
  triggeredRequests.length = 0;
  await page.type(".rmp-trigger-bar input", "octo/widget#5");
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll(".rmp-trigger-bar button"));
    const triageBtn = btns.find(b => b.textContent?.trim() === "triage");
    triageBtn?.click();
  });
  await Bun.sleep(100);
  const triageReqs = triggeredRequests.filter(
    (r) => r.url.endsWith("/api/trigger") && r.body?.mode === "triage" && r.body?.issue === "octo/widget#5",
  );
  results.push({
    name: "trigger-bar-triage-click",
    ok: triageReqs.length === 1 && triageReqs[0].headers["x-robomp-replay-token"] === REPLAY_TOKEN,
    detail: `Matching triage requests: ${triageReqs.length}, token: "${triageReqs[0]?.headers["x-robomp-replay-token"] ?? ""}"`,
  });

  // E. Trigger bar retry latest click — exactly one POST /api/trigger
  //    {mode:"retry", issue} carrying the replay token.
  triggeredRequests.length = 0;
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll(".rmp-trigger-bar button"));
    const retryBtn = btns.find(b => b.textContent?.trim() === "retry latest");
    retryBtn?.click();
  });
  await Bun.sleep(100);
  const retryLatestReqs = triggeredRequests.filter(
    (r) => r.url.endsWith("/api/trigger") && r.body?.mode === "retry" && r.body?.issue === "octo/widget#5",
  );
  results.push({
    name: "trigger-bar-retry-latest-click",
    ok: retryLatestReqs.length === 1 && retryLatestReqs[0].headers["x-robomp-replay-token"] === REPLAY_TOKEN,
    detail: `Matching retry-latest requests: ${retryLatestReqs.length}, token: "${retryLatestReqs[0]?.headers["x-robomp-replay-token"] ?? ""}"`,
  });

  // F. Trigger bar Enter key — Enter in the input triages; exactly one POST
  //    /api/trigger {mode:"triage", issue} carrying the replay token.
  triggeredRequests.length = 0;
  await page.focus(".rmp-trigger-bar input");
  await page.keyboard.press("Enter");
  await Bun.sleep(100);
  const enterReqs = triggeredRequests.filter(
    (r) => r.url.endsWith("/api/trigger") && r.body?.mode === "triage" && r.body?.issue === "octo/widget#5",
  );
  results.push({
    name: "trigger-bar-enter-press",
    ok: enterReqs.length === 1 && enterReqs[0].headers["x-robomp-replay-token"] === REPLAY_TOKEN,
    detail: `Matching enter requests: ${enterReqs.length}, token: "${enterReqs[0]?.headers["x-robomp-replay-token"] ?? ""}"`,
  });

  // G. Activity-view retry failure — switching to Activity and retrying a
  //    failed event must surface the trigger error WHERE the button was
  //    clicked (the Trigger bar lives only on Operations/Triage). Force
  //    /api/trigger to error, click the Activity events-table retry button,
  //    and assert .rmp-activity-status shows the error with role="alert" and
  //    that exactly one trigger request fired carrying the replay token.
  triggeredRequests.length = 0;
  const ACTIVITY_ERROR_DETAIL = "forced retry failure";
  triggerErrorDetail = ACTIVITY_ERROR_DETAIL;
  // Switch to the Activity view via the nav rail.
  await page.evaluate(() => {
    const navBtn = Array.from(document.querySelectorAll(".rmp-nav-item")).find(
      (b) => b.querySelector(".rmp-nav-item-label")?.textContent?.trim() === "Activity",
    ) as HTMLElement | null;
    navBtn?.click();
  });
  await Bun.sleep(100); // let the view flip to display:flex
  // Click the first retry button in the Activity events table (Events is the
  // only `table.t` consumer, so this is unambiguous).
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("table.t button")).find(
      (b) => b.textContent?.trim() === "retry",
    ) as HTMLElement | null;
    btn?.click();
  });
  await Bun.sleep(100); // wait for the failed trigger round-trip + state update
  const activityStatus = await page.evaluate(() => {
    const el = document.querySelector(".rmp-activity-status");
    if (!el) return null;
    return {
      text: el.textContent?.trim() ?? "",
      role: el.getAttribute("role") ?? "",
      // offsetParent is null when an ancestor is display:none — proves the
      // status is actually visible inside the active Activity view.
      visible: (el as HTMLElement).offsetParent !== null,
    };
  });
  const activityRetryReqs = triggeredRequests.filter(
    (r) => r.url.endsWith("/api/trigger") && r.body?.mode === "retry",
  );
  triggerErrorDetail = null; // reset so later passes see the normal 202
  results.push({
    name: "activity-retry-error-visible",
    ok:
      !!activityStatus &&
      activityStatus.visible &&
      activityStatus.role === "alert" &&
      activityStatus.text.includes(ACTIVITY_ERROR_DETAIL) &&
      activityRetryReqs.length === 1 &&
      activityRetryReqs[0].headers["x-robomp-replay-token"] === REPLAY_TOKEN,
    detail: `Activity status: ${JSON.stringify(activityStatus)}. Retry requests: ${activityRetryReqs.length}, token: "${activityRetryReqs[0]?.headers["x-robomp-replay-token"] ?? ""}"`,
  });
  await page.screenshot({ path: path.join(outDir, "shots/activity-retry-error.png") });

  customIndexHtml = null; // restore real-index interception

  // Cleanup browser
  await browser.close();

  // Print results
  console.log("\n--- Verification checks summary ---");
  let allPass = true;
  for (const r of results) {
    const status = r.ok ? "PASS" : "FAIL";
    console.log(`[${status}] ${r.name}: ${r.detail}`);
    if (!r.ok) allPass = false;
  }

  // Write report
  const summaryJson = {
    generatedAt: new Date().toISOString(),
    pass: allPass,
    checks: results.map(r => ({ name: r.name, ok: r.ok, detail: r.detail })),
  };
  await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(summaryJson, null, 2), "utf-8");
  console.log(`\nReport written to ${path.join(outDir, "report.json")}`);

  process.exitCode = allPass ? 0 : 1;
}

main().catch(err => {
  console.error("Verification harness crashed:", err);
  process.exit(1);
});
