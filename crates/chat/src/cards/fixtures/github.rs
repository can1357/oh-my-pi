use super::{CardFixture, FixtureState};

const ARGS: &str = r#"{"op":"search_prs","query":"is:open review-requested:@me sort:updated","repo":"oh-my-pi/pi"}"#;
const RESULT: &str = r##"{"output":"#1842  feat(tui): virtualized scrollback for tool output     openyou · 2h ago   +312 -47\n#1839  fix(agent): retry stream on transient 529             dvir   · 5h ago   +18 -4\n#1830  refactor(edit): unify hashline + ast_edit previews    mira   · 1d ago   +540 -210\n#1817  docs: document gallery fixtures contract             leo    · 2d ago   +96 -0\n\n4 open pull requests requesting your review"}"##;

pub(super) const FIXTURES: &[CardFixture] = &[CardFixture {
	tool:   "github",
	title:  "GitHub",
	states: [
		FixtureState {
			args:   r#"{"op":"search_prs","query":"is:open author:@me"}"#,
			update: None,
			result: None,
			fault:  None,
		},
		FixtureState { args: ARGS, update: None, result: None, fault: None },
		FixtureState { args: ARGS, update: None, result: Some(RESULT), fault: None },
		FixtureState {
			args:   ARGS,
			update: None,
			result: None,
			fault:  Some(
				r#""gh: Could not resolve to a Repository with the name 'oh-my-pi/pi'. (HTTP 404)""#,
			),
		},
	],
}];
