#!/usr/bin/env bun

import * as path from "node:path";
import { main } from "../src/tb/cli";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const args = [
	"--jobs-dir",
	Bun.env.TB_JOBS_DIR ?? path.join(REPO_ROOT, "runs", "tb-floor"),
	"--concurrency",
	Bun.env.TB_CONCURRENCY ?? "20",
	"--openrouter-variant",
	Bun.env.TB_OPENROUTER_VARIANT ?? "floor",
];

if (Bun.env.TB_DATASET) args.push("--dataset", Bun.env.TB_DATASET);
if (Bun.env.TB_BUDGET_USD) args.push("--budget", Bun.env.TB_BUDGET_USD);
if (Bun.env.TB_ATTEMPTS) args.push("--attempts", Bun.env.TB_ATTEMPTS);
if (Bun.env.TB_FOREVER === "1") args.push("--forever");
args.push(...process.argv.slice(2));

await main(args);
