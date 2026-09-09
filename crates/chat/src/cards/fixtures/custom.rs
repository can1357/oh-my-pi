use super::{CardFixture, FixtureState};

const ARGS: &str = r#"{"query":"weather in Tokyo","units":"metric"}"#;

pub(super) const FIXTURES: &[CardFixture] = &[CardFixture {
	tool:   "custom",
	title:  "Custom Tool",
	states: [
		FixtureState { args: r#"{"query":"weather"}"#, update: None, result: None, fault: None },
		FixtureState { args: ARGS, update: None, result: None, fault: None },
		FixtureState {
			args:   ARGS,
			update: None,
			result: Some(r#""Tokyo: 22°C, partly cloudy, humidity 64%.""#),
			fault:  None,
		},
		FixtureState {
			args:   ARGS,
			update: None,
			result: None,
			fault:  Some(r#""Upstream provider returned 503 Service Unavailable""#),
		},
	],
}];
