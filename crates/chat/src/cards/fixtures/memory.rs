use super::{CardFixture, FixtureState};

const RETAIN_ARGS: &str = r#"{"items":[{"content":"User prefers Bun over Node for all new scripts in this repo.","context":"Established while wiring up the gallery command tooling."},{"content":"The TUI renderers live in packages/coding-agent/src/tools/*-render.ts.","context":"Discovered during the gallery-fixtures task."}]}"#;
const RECALL_ARGS: &str = r#"{"query":"Which runtime does the user prefer for scripts?"}"#;
const RECALL_RESULT: &str = r#"{"query":"Which runtime does the user prefer for scripts?","items":[{"memory":{"id":"mem-4f2a","bank":"global","tier":"working","content":"User prefers Bun over Node for all new scripts in this repo.","source":"coding-agent-retain","session_id":"gallery","timestamp":"2026-09-04T12:00:00Z","importance":0.75,"veracity":"user","memory_type":"fact","metadata":{"context":"Established while wiring up the gallery command tooling."},"superseded_by":null},"score":0.92,"voice_scores":{"vector":0.32,"graph":0.25,"episodic":0.2,"working":0.15},"broadened":false},{"memory":{"id":"mem-9c81","bank":"global","tier":"working","content":"The TUI renderers live in packages/coding-agent/src/tools/*-render.ts.","source":"coding-agent-retain","session_id":"gallery","timestamp":"2026-09-04T11:00:00Z","importance":0.75,"veracity":"user","memory_type":"fact","metadata":{"context":"Discovered during the gallery-fixtures task."},"superseded_by":null},"score":0.78,"voice_scores":{"vector":0.28,"graph":0.2,"episodic":0.18,"working":0.12},"broadened":false}]}"#;
const REFLECT_ARGS: &str =
	r#"{"query":"What have we learned about the user's tooling preferences?"}"#;
const REFLECT_RESULT: &str = r#"{"answer":"The user consistently favors Bun as the runtime for scripts in this\nrepository, avoiding Node where possible. They also track the location\nof TUI renderers under packages/coding-agent/src/tools, suggesting an\ninterest in keeping rendering logic discoverable and well-organized.","recalled":2}"#;

pub(super) const FIXTURES: &[CardFixture] = &[
	CardFixture {
		tool:   "recall",
		title:  "Recall",
		states: [
			FixtureState {
				args:   r#"{"query":"bun vs node"}"#,
				update: None,
				result: None,
				fault:  None,
			},
			FixtureState { args: RECALL_ARGS, update: None, result: None, fault: None },
			FixtureState {
				args:   RECALL_ARGS,
				update: None,
				result: Some(RECALL_RESULT),
				fault:  None,
			},
			FixtureState {
				args:   RECALL_ARGS,
				update: None,
				result: None,
				fault:  Some(r#""Recall failed: vector index unavailable.""#),
			},
		],
	},
	CardFixture {
		tool:   "reflect",
		title:  "Reflect",
		states: [
			FixtureState {
				args:   r#"{"query":"what have we learned about the user's"}"#,
				update: None,
				result: None,
				fault:  None,
			},
			FixtureState { args: REFLECT_ARGS, update: None, result: None, fault: None },
			FixtureState {
				args:   REFLECT_ARGS,
				update: None,
				result: Some(REFLECT_RESULT),
				fault:  None,
			},
			FixtureState {
				args:   REFLECT_ARGS,
				update: None,
				result: None,
				fault:  Some(r#""Reflect failed: no memories matched the query.""#),
			},
		],
	},
	CardFixture {
		tool:   "retain",
		title:  "Retain",
		states: [
			FixtureState {
				args:   r#"{"items":[{"content":"User prefers Bun over Node for all new scripts in this repo."}]}"#,
				update: None,
				result: None,
				fault:  None,
			},
			FixtureState { args: RETAIN_ARGS, update: None, result: None, fault: None },
			FixtureState {
				args:   RETAIN_ARGS,
				update: None,
				result: Some(r#"{"ids":["mem-4f2a","mem-9c81"]}"#),
				fault:  None,
			},
			FixtureState {
				args:   RETAIN_ARGS,
				update: None,
				result: None,
				fault:  Some(r#""Retain failed: memory store is not initialized.""#),
			},
		],
	},
];
