use super::{CardFixture, FixtureState};

pub(super) const FIXTURES: &[CardFixture] = &[CardFixture {
	tool:   "context_gauge",
	title:  "Context Gauge",
	states: [
		FixtureState {
			args:   r#"{"percent":3,"label":"3% used — fresh session","model":"test-model","context":200000,"directory":"gallery"}"#,
			update: None,
			result: None,
			fault:  None,
		},
		FixtureState {
			args:   r#"{"percent":62,"label":"62% used — warning zone","model":"test-model","context":200000,"directory":"gallery"}"#,
			update: None,
			result: None,
			fault:  None,
		},
		FixtureState {
			args:   r#"{"percent":97,"label":"97% used — past compaction threshold","model":"test-model","context":200000,"directory":"gallery"}"#,
			update: None,
			result: Some("{}"),
			fault:  None,
		},
		FixtureState {
			args:   r#"{"percent":120,"label":"120% used — overflow: percent breaks past the window label in red","model":"test-model","context":200000,"directory":"gallery"}"#,
			update: None,
			result: None,
			fault:  None,
		},
	],
}];
