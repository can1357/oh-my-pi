use super::{CardFixture, FixtureState};

/// Both devices take an exact `proposal_id` and one `reason` argument
/// (`envd::devices_host` `proposal_schema`); the settled payload carries the
/// same transaction identity.
const fn states(streaming: &'static str, args: &'static str) -> [FixtureState; 4] {
	[
		FixtureState { args: streaming, update: None, result: None, fault: None },
		FixtureState { args, update: None, result: None, fault: None },
		FixtureState {
			args,
			update: None,
			result: Some(r#"{"id":"pending-action:ast_edit:7","payload":{}}"#),
			fault: None,
		},
		FixtureState { args, update: None, result: None, fault: Some(r#""Tool execution failed""#) },
	]
}

pub(super) const FIXTURES: &[CardFixture] = &[
	CardFixture {
		tool:   "resolve",
		title:  "",
		states: states(
			r#"{"proposal_id":"pending-action:ast_edit:7","reason":"The rename touches only"#,
			r#"{"proposal_id":"pending-action:ast_edit:7","reason":"The rename touches only tokens.ts and matches the request."}"#,
		),
	},
	CardFixture {
		tool:   "reject",
		title:  "",
		states: states(
			r#"{"proposal_id":"pending-action:ast_edit:7","reason":"The patch would also"#,
			r#"{"proposal_id":"pending-action:ast_edit:7","reason":"The patch would also delete the migration script."}"#,
		),
	},
];
