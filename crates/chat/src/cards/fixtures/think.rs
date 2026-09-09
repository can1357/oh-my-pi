use super::{CardFixture, FixtureState};

const ARGS: &str = r#"{"thoughts":"The retry loop re-reads the config after every failure, which explains the doubled latency. Cache the parsed config outside the loop, then re-check the invalidation path."}"#;

pub(super) const FIXTURES: &[CardFixture] = &[CardFixture {
	tool:   "think",
	title:  "Think",
	states: [
		FixtureState {
			args:   r#"{"thoughts":"The retry loop re-reads the config after every failure, which explains the doubled latency."#,
			update: None,
			result: None,
			fault:  None,
		},
		FixtureState { args: ARGS, update: None, result: None, fault: None },
		FixtureState { args: ARGS, update: None, result: Some("{}"), fault: None },
		FixtureState {
			args:   ARGS,
			update: None,
			result: None,
			fault:  Some(r#""Tool execution failed""#),
		},
	],
}];
