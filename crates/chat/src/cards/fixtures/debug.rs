use super::{CardFixture, FixtureState};

const ARGS: &str = r#"{"action":"stack_trace","levels":20}"#;
const RESULT: &str = r#"{"action":"stack_trace","session":"dbg-1","revision":2,"output":"FRAME\tNAME\tSOURCE\tLINE:COLUMN\n1000\tvalidate_token\tapp/server.py\t42:14\n1001\tauthenticate\tapp/server.py\t88:9\n1002\thandle_request\tapp/router.py\t153:20\n","data":{"reason":"breakpoint","session":{"id":"dbg-1","adapter":"debugpy","cwd":"/Users/dev/project","program":"./app/server.py","status":"stopped","pid":3184,"frame":{"id":1000,"name":"validate_token","instructionPointerReference":"0x00000001000034a8","source":{"path":"app/server.py"},"line":42,"column":14}},"stackFrames":[{"id":1000,"name":"validate_token","source":{"path":"app/server.py"},"line":42,"column":14},{"id":1001,"name":"authenticate","source":{"path":"app/server.py"},"line":88,"column":9},{"id":1002,"name":"handle_request","source":{"path":"app/router.py"},"line":153,"column":20},{"id":1003,"name":"dispatch","source":{"path":"app/router.py"},"line":97,"column":5},{"id":1004,"name":"<module>","source":{"path":"app/server.py"},"line":212,"column":1}]}}"#;

pub(super) const FIXTURES: &[CardFixture] = &[CardFixture {
	tool:   "debug",
	title:  "Debug",
	states: [
		FixtureState {
			args:   r#"{"action":"stack_trace"#,
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
			fault:  Some(r#""No active debug session. Launch or attach first.""#),
		},
	],
}];
