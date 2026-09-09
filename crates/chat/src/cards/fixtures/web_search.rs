use super::{CardFixture, FixtureState};

const ARGS: &str = r#"{"query":"Bun vs Node.js performance benchmarks 2026","recency":"month","limit":4,"provider":"perplexity"}"#;
const RESULT: &str = r#"{"response":{
	"engine":"perplexity","auth_mode":"api_key",
	"answer":"Bun continues to outperform Node.js on raw HTTP throughput and cold-start<br>\ntime thanks to its JavaScriptCore engine and native-Zig runtime, while<br>\nNode.js retains an edge in ecosystem maturity and long-term stability.<br>\nFor script-heavy workflows Bun's faster startup is the decisive factor.",
	"search_queries":["bun vs node.js performance benchmarks 2026","bun http throughput vs node"],
	"sources":[
		{"title":"Bun 1.2 Benchmarks: HTTP, SQLite, and Startup Time","url":"https://bun.sh/blog/bun-v1.2-benchmarks","snippet":"Bun serves roughly 2.5x the requests per second of Node.js on a simple HTTP server and starts in under 10ms.","age_seconds":1036800,"author":"The Bun Team"},
		{"title":"Node.js vs Bun: A 2026 Performance Deep Dive","url":"https://blog.platformatic.dev/nodejs-vs-bun-2026","snippet":"Across CPU-bound workloads the gap narrows, but Bun's faster module resolution keeps cold starts ahead.","age_seconds":259200,"author":"Matteo Collina"},
		{"title":"Real-world API latency: Bun, Deno, and Node compared","url":"https://www.theregister.com/2026/05/18/js_runtime_latency/","snippet":"Under sustained load p99 latencies converge, suggesting runtime choice matters less for steady-state services.","age_seconds":1641600},
		{"title":"Why we migrated our CLI tooling from Node to Bun","url":"https://engineering.example.com/posts/bun-cli-migration","snippet":"Startup dropped from 180ms to 22ms, shaving seconds off every developer command invocation.","age_seconds":2332800,"author":"Dana Whitfield"}
	],
	"citations":[{"url":"https://bun.sh/blog/bun-v1.2-benchmarks","title":"Bun 1.2 Benchmarks","cited_text":"Bun serves roughly 2.5x the requests per second of Node.js"}],
	"usage":{"input_tokens":312,"output_tokens":248,"total_tokens":560,"server_tools":{"web_search_requests":2}}
}}"#;
const ERROR: &str = r#"{"kind":"search","provider":"perplexity","category":"rate_limited","code":"resource_exhausted","status":429}"#;

pub(super) const FIXTURES: &[CardFixture] = &[CardFixture {
	tool:   "web_search",
	title:  "Web Search",
	states: [
		FixtureState {
			args:   r#"{"query":"bun vs node performance"}"#,
			update: None,
			result: None,
			fault:  None,
		},
		FixtureState { args: ARGS, update: None, result: None, fault: None },
		FixtureState { args: ARGS, update: None, result: Some(RESULT), fault: None },
		FixtureState { args: ARGS, update: None, result: None, fault: Some(ERROR) },
	],
}];
