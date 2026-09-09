//! Gallery fixtures for agent coordination, goals, and checklists.

use super::{CardFixture, FixtureState};

const fn states(
	streaming_args: &'static str,
	args: &'static str,
	update: Option<&'static str>,
	result: &'static str,
	failed_args: &'static str,
	failed_result: Option<&'static str>,
	fault: Option<&'static str>,
) -> [FixtureState; 4] {
	[
		FixtureState { args: streaming_args, update: None, result: None, fault: None },
		FixtureState { args, update, result: None, fault: None },
		FixtureState { args, update, result: Some(result), fault: None },
		FixtureState { args: failed_args, update: None, result: failed_result, fault },
	]
}

const TASK_ARGS: &str = r#"{"agent":"task","name":"AuthLoader","task":"Read packages/server/src/auth/session.ts and middleware.ts, then document the session-cookie validation flow and any TODOs."}"#;
const TASK_RESULT: &str = r#"{"total_duration_ms":48200,"requests":6,"results":[{"job":"AuthLoader","description":"Load auth middleware","assignment":"Read packages/server/src/auth/session.ts and middleware.ts, then document the session-cookie validation flow and any TODOs.","exit":0,"wall_ms":41900,"requests":6,"context_tokens":23100,"context_window":200000,"cost":0.12,"output":"Session validation runs in middleware.ts:42 via verifySessionCookie().\nCookies are HMAC-signed (SHA-256) and checked against the session store.\nTODO at session.ts:88 — sliding-expiration refresh is stubbed."}]}"#;
const TASK_FAILED: &str = r#"{"total_duration_ms":9800,"requests":3,"results":[{"job":"RateLimiter","description":"Audit rate limiter","assignment":"Inspect packages/server/src/auth/rate-limit.ts. Confirm the 429 path sets Retry-After and report gaps.","exit":1,"wall_ms":9800,"requests":3,"context_tokens":6400,"context_window":200000,"cost":0.10,"error":"Subagent exited 1: target file packages/server/src/auth/rate-limit.ts does not exist."}]}"#;
const HUB_START_ARGS: &str = r#"{"op":"start","name":"web","application":"bun","args":["run","dev"],"ready":{"log":"Local:.*http","port":5173,"timeout":30}}"#;
const HUB_LOGS_ARGS: &str =
	r#"{"op":"logs","name":"comp-debug","lines":100,"follow":true,"cursor":233512,"timeout":30}"#;
const HUB_SEND_ARGS: &str = r#"{"op":"send","to":"AuthLoader","message":"Are you still touching src/server/auth.ts? I need to add a 401 path.","await":true}"#;
const HUB_WAIT_ARGS: &str = r#"{"op":"wait","from":"AuthLoader","timeoutMs":60000}"#;
const HUB_JOBS_ARGS: &str = r#"{"op":"wait","ids":["job_a1","job_b2","job_c3"]}"#;
const TODO_ARGS: &str = r#"{"op":"init","list":[{"phase":"Foundation","items":["Scaffold crate","Wire workspace"]},{"phase":"Auth","items":["Port credential store","Wire OAuth providers"]}]}"#;
const TODO_RESULT: &str = r#"{"phases":[{"phase":"Foundation","items":[{"text":"Scaffold crate","status":"pending"},{"text":"Wire workspace","status":"pending"}]},{"phase":"Auth","items":[{"text":"Port credential store","status":"pending"},{"text":"Wire OAuth providers","status":"pending"}]}],"rendered":""}"#;
const GOAL_ARGS: &str = r#"{"op":"create","objective":"Ship the auth hardening pass: per-account rate limits and sliding session expiry.","token_budget":500000}"#;

pub(super) const FIXTURES: &[CardFixture] = &[
	CardFixture {
		tool:   "task",
		title:  "Task",
		states: states(
			r#"{"agent":"task","name":"AuthLoader","task":"Read packages/server/src/auth/*.ts and summarize the session-cookie"#,
			TASK_ARGS,
			Some(
				r#"{"job":"AuthLoader","seq":2,"status":"running","intent":"Documenting session-cookie flow"}"#,
			),
			TASK_RESULT,
			TASK_ARGS,
			Some(TASK_FAILED),
			None,
		),
	},
	CardFixture {
		tool:   "hub",
		title:  "",
		states: states(
			"{",
			"{}",
			None,
			r#"{"detail":"hub completed"}"#,
			"{}",
			None,
			Some(r#"{"message":"operation failed"}"#),
		),
	},
	CardFixture {
		tool:   "hub_start",
		title:  "Hub start",
		states: states(
			r#"{"op":"start","name":"web"#,
			HUB_START_ARGS,
			None,
			r#"{"kind":"start","name":"web","command":"bun run dev","detail":"· ready","pid":51234,"wall_ms":2100,"text":"log matched: Local:   http://localhost:5173/"}"#,
			HUB_START_ARGS,
			None,
			Some(r#"{"message":"start requires application"}"#),
		),
	},
	CardFixture {
		tool:   "hub_logs",
		title:  "Hub logs",
		states: states(
			HUB_LOGS_ARGS,
			HUB_LOGS_ARGS,
			None,
			r#"{"logs":{"name":"comp-debug","detail":"ready · cursor 233797","text":"Breakpoint 1: 3 locations.\n(lldb) run\nProcess 726 launched: '/tmp/compiler'\nframe #0: 0x0000000100012f80 compiler`parse_expression\n(lldb)"}}"#,
			HUB_LOGS_ARGS,
			None,
			Some(r#"{"message":"No daemon named web"}"#),
		),
	},
	CardFixture {
		tool:   "hub_send",
		title:  "Hub send",
		states: states(
			r#"{"op":"send","to":"AuthLoader","message":"Are you still touching"#,
			HUB_SEND_ARGS,
			None,
			r#"{"sent":{"to":"AuthLoader","kind":"revived","text":"Done with auth.ts — go ahead, just rebase past my session-store rename.","ts":1787961600000}}"#,
			r#"{"op":"send","to":"RateLimiter","message":"Are you still touching src/server/auth.ts? I need to add a 401 path.","await":true}"#,
			None,
			Some(r#"{"message":"unknown agent \"RateLimiter\""}"#),
		),
	},
	CardFixture {
		tool:   "hub_wait",
		title:  "Hub wait",
		states: states(
			r#"{"op":"wait","from":"AuthLoader"#,
			HUB_WAIT_ARGS,
			None,
			r#"{"inbox":[{"from":"AuthLoader","text":"session-store rename is merged; auth.ts is yours.","ts":1787961600000}]}"#,
			HUB_WAIT_ARGS,
			None,
			Some(r#"{"message":"operation failed"}"#),
		),
	},
	CardFixture {
		tool:   "hub_inbox",
		title:  "Hub inbox",
		states: states(
			r#"{"op":"inbox"#,
			r#"{"op":"inbox","peek":true}"#,
			None,
			r#"{"inbox":[{"from":"AuthLoader","text":"hub table reads unreadCount — ping me when the bus lands.","ts":1787961360000,"age_ms":240000},{"from":"RateLimiter","text":"bus is in; receipts carry outcome.","ts":1787961540000,"age_ms":60000,"kind":"reply"}]}"#,
			r#"{"op":"inbox","peek":true}"#,
			None,
			Some(r#"{"message":"IRC inbox failed: message store unavailable."}"#),
		),
	},
	CardFixture {
		tool:   "hub_list",
		title:  "Hub peers",
		states: states(
			r#"{"op":"list"#,
			r#"{"op":"list"}"#,
			None,
			r#"{"peers":[{"id":"AuthLoader","status":"idle","kind":"task sub","detail":"· of Main","ts":1787961480000,"age_ms":120000},{"id":"RateLimiter","status":"parked","kind":"task sub","detail":"· of Main","unread":2,"ts":1787960880000,"age_ms":720000}]}"#,
			r#"{"op":"list"}"#,
			None,
			Some(r#"{"message":"IRC list failed: agent hub is unavailable."}"#),
		),
	},
	CardFixture {
		tool:   "hub_jobs",
		title:  "Hub jobs",
		states: states(
			r#"{"op":"wait","ids":["job_a1"#,
			HUB_JOBS_ARGS,
			None,
			r#"{"jobs":[{"id":"job_c3","status":"failed","kind":"bash","label":"bunx biome check packages/server/src/auth","wall_ms":4100,"text":"biome: 2 errors in tokens.ts — noUnusedVariables, useConst"},{"id":"job_b2","status":"completed","kind":"task","label":"Migrate rate limiter to a sliding window","wall_ms":96000,"text":"Rewrote rate-limit.ts to a token-bucket; added per-account keys."},{"id":"job_a1","status":"completed","kind":"bash","label":"bun test packages/server/test/auth.test.ts","wall_ms":18400,"text":"42 pass, 0 fail (18.4s)"}]}"#,
			HUB_JOBS_ARGS,
			Some(
				r#"{"jobs":[{"id":"job_d4","status":"failed","kind":"task","label":"Refactor the session store to Redis","wall_ms":52300,"text":"Subagent exited 1: Redis connection string is missing."}]}"#,
			),
			None,
		),
	},
	CardFixture {
		tool:   "goal",
		title:  "Goal",
		states: states(
			r#"{"op":"create","objective":"Ship the auth hardening"#,
			GOAL_ARGS,
			None,
			r#"{"op":"create","remainingTokens":451800,"completionBudgetReport":null,"goal":{"id":"goal_8f2a","objective":"Ship the auth hardening pass: per-account rate limits and sliding session expiry.","status":"active","tokenBudget":500000,"tokensUsed":48200,"timeUsedSeconds":312,"createdAt":1749200000000,"updatedAt":1749200312000}}"#,
			GOAL_ARGS,
			None,
			Some(r#""Goal tool failed: objective is required when op=create.""#),
		),
	},
	CardFixture {
		tool:   "todo",
		title:  "Todo",
		states: states(
			r#"{"op":"init","list":[{"phase":"Foundation","items":["Scaffold crate"#,
			TODO_ARGS,
			None,
			TODO_RESULT,
			TODO_ARGS,
			None,
			Some(r#""Unknown phase 'Auth' — initialize the list first""#),
		),
	},
];
