use super::{CardFixture, FixtureState};

const ARGS: &str = r#"{"tool":"lsp","report":"Rename returned no edit for an exported symbol that has 12 references"}"#;

const STATES: [FixtureState; 4] = [
	FixtureState { args: r#"{"tool":"lsp"#, update: None, result: None, fault: None },
	FixtureState { args: ARGS, update: None, result: None, fault: None },
	FixtureState {
		args:   ARGS,
		update: None,
		result: Some(r#"{"note":"Noted, thanks!"}"#),
		fault:  None,
	},
	FixtureState {
		args:   ARGS,
		update: None,
		result: None,
		fault:  Some(r#""Could not record the report: issue tracker unreachable""#),
	},
];

pub(super) const FIXTURES: &[CardFixture] = &[
	CardFixture { tool: "report_issue", title: "Report Tool Issue", states: STATES },
	CardFixture { tool: "report_tool_issue", title: "Report Tool Issue", states: STATES },
];
