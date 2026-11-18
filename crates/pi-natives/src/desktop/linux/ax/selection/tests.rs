use std::sync::{Arc, Mutex};

use atspi::zbus::{Guid, connection::Builder as ConnectionBuilder, fdo, interface};

use super::*;
use crate::desktop::text_range::SelectPart;

const PEER: &str = ":1.7";
const ELEMENT: &str = "/text";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Write {
	Add(i32, i32),
	Replace(i32, i32, i32),
	Caret(i32),
}

#[derive(Clone, Copy, Debug, Default)]
enum Response {
	#[default]
	Apply,
	Reject,
	Ignore,
	Clamp,
	InvalidRange,
	KeepSelection,
	ChangeText,
	ChangeFocus,
	ChangeFocusDuringReadback,
	UnreadableFocus,
	Deferred,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
	BeforeWrite,
	Write,
	Readback,
}

struct PeerState {
	value:           String,
	toolkit:         &'static str,
	interfaces:      bool,
	role:            Option<Role>,
	enabled:         bool,
	defunct:         bool,
	focused:         bool,
	caret:           i32,
	selection:       Option<(i32, i32)>,
	selection_count: Option<i32>,
	count:           Option<i32>,
	changing_count:  bool,
	count_reads:     usize,
	text_reads:      usize,
	response:        Response,
	pending:         Option<Write>,
	pending_reads:   usize,
	writes:          Vec<Write>,
	forbidden:       Vec<&'static str>,
	stop:            Option<Stage>,
	cancel:          Option<control::CancellationSource>,
}

impl PeerState {
	fn new(value: &str, toolkit: &'static str) -> Self {
		Self {
			value: value.to_owned(),
			toolkit,
			interfaces: true,
			role: Some(Role::Text),
			enabled: true,
			defunct: false,
			focused: false,
			caret: 0,
			selection: None,
			selection_count: None,
			count: None,
			changing_count: false,
			count_reads: 0,
			text_reads: 0,
			response: Response::Apply,
			pending: None,
			pending_reads: 0,
			writes: Vec::new(),
			forbidden: Vec::new(),
			stop: None,
			cancel: None,
		}
	}

	fn length(&self) -> i32 {
		if self.toolkit.eq_ignore_ascii_case("qt") {
			self.value.encode_utf16().count() as i32
		} else {
			self.value.chars().count() as i32
		}
	}

	fn apply(&mut self, write: Write) {
		match write {
			Write::Add(start, end) | Write::Replace(_, start, end) => {
				self.selection = Some((start, end));
				self.caret = end;
			},
			Write::Caret(offset) => {
				self.selection = None;
				self.caret = offset;
			},
		}
	}
}

#[derive(Clone)]
struct Peer(Arc<Mutex<PeerState>>);

impl Peer {
	async fn pause(&self, stage: Stage) {
		let (stop, cancel) = {
			let state = self.0.lock().unwrap();
			(state.stop == Some(stage), state.cancel.clone())
		};
		if stop {
			if let Some(cancel) = cancel {
				cancel.cancel();
			}
			std::future::pending::<()>().await;
		}
	}

	async fn write(&self, write: Write) -> bool {
		self.0.lock().unwrap().writes.push(write);
		self.pause(Stage::Write).await;
		let mut state = self.0.lock().unwrap();
		match state.response {
			Response::Reject => return false,
			Response::Ignore => return true,
			Response::Deferred => {
				state.pending = Some(write);
				state.pending_reads = 2;
				return true;
			},
			_ => {},
		}
		let previous = state.selection;
		state.apply(write);
		match state.response {
			Response::Clamp => {
				if let Some((start, end)) = state.selection {
					state.selection = Some((start, end - 1));
				}
			},
			Response::InvalidRange => state.selection = Some((-1, 999)),
			Response::KeepSelection => state.selection = previous,
			Response::ChangeText => state.value.push('!'),
			Response::ChangeFocus => state.focused = !state.focused,
			_ => {},
		}
		true
	}

	fn forbidden(&self, call: &'static str) -> bool {
		self.0.lock().unwrap().forbidden.push(call);
		false
	}
}

struct Accessible(Peer);

#[interface(name = "org.a11y.atspi.Accessible")]
impl Accessible {
	fn get_interfaces(&self) -> Vec<&str> {
		if self.0.0.lock().unwrap().interfaces {
			vec!["org.a11y.atspi.Accessible", "org.a11y.atspi.Text"]
		} else {
			vec!["org.a11y.atspi.Accessible"]
		}
	}

	async fn get_role(&self) -> fdo::Result<u32> {
		self.0.pause(Stage::BeforeWrite).await;
		self
			.0
			.0
			.lock()
			.unwrap()
			.role
			.map(|role| role as u32)
			.ok_or_else(|| fdo::Error::Failed("role unavailable".to_owned()))
	}

	fn get_application(&self) -> ObjectRefOwned {
		ObjectRefOwned::from_static_str_unchecked(PEER, "/app")
	}

	async fn get_state(&self) -> fdo::Result<Vec<u32>> {
		let written = !self.0.0.lock().unwrap().writes.is_empty();
		if written {
			self.0.pause(Stage::Readback).await;
		}
		let state = self.0.0.lock().unwrap();
		if written && matches!(state.response, Response::UnreadableFocus) {
			return Err(fdo::Error::Failed("state unavailable".to_owned()));
		}
		let mut flags = 0u64;
		if state.enabled {
			flags |= State::Enabled as u64;
		}
		if state.defunct {
			flags |= State::Defunct as u64;
		}
		if state.focused {
			flags |= State::Focused as u64;
		}
		Ok(vec![flags as u32, (flags >> 32) as u32])
	}
}

struct Application(Peer);

#[interface(name = "org.a11y.atspi.Application")]
impl Application {
	#[zbus(property)]
	fn toolkit_name(&self) -> fdo::Result<String> {
		let toolkit = self.0.0.lock().unwrap().toolkit;
		if toolkit.is_empty() {
			Err(fdo::Error::Failed("toolkit unavailable".to_owned()))
		} else {
			Ok(toolkit.to_owned())
		}
	}

	#[zbus(property)]
	fn version(&self) -> &str {
		"fixture"
	}

	#[zbus(property)]
	fn uncached_only(&self) -> fdo::Result<bool> {
		self.0.forbidden("Application.GetAll");
		Err(fdo::Error::NotSupported("GetAll is unsafe for this application".to_owned()))
	}
}

struct Text(Peer);

#[interface(name = "org.a11y.atspi.Text")]
impl Text {
	#[zbus(property)]
	fn character_count(&self) -> i32 {
		let mut state = self.0.0.lock().unwrap();
		state.count_reads += 1;
		let count = state.count.unwrap_or_else(|| state.length());
		count + i32::from(state.changing_count && state.count_reads % 2 == 0)
	}

	#[zbus(property)]
	fn caret_offset(&self) -> i32 {
		self.0.0.lock().unwrap().caret
	}

	#[zbus(property)]
	fn uncached_only(&self) -> fdo::Result<bool> {
		self.0.forbidden("Text.GetAll");
		Err(fdo::Error::NotSupported("GetAll is unsafe for this application".to_owned()))
	}

	fn get_text(&self, start: i32, end: i32) -> String {
		let mut state = self.0.0.lock().unwrap();
		state.text_reads += 1;
		if state.text_reads > 1 && matches!(state.response, Response::ChangeFocusDuringReadback) {
			state.focused = true;
		}
		let qt = state.toolkit.eq_ignore_ascii_case("qt");
		let mut offset = 0i32;
		state
			.value
			.chars()
			.filter(|character| {
				let here = offset;
				offset += if qt { character.len_utf16() as i32 } else { 1 };
				here >= start && (end < 0 || here < end)
			})
			.collect()
	}

	fn get_n_selections(&self) -> i32 {
		let mut state = self.0.0.lock().unwrap();
		if state.pending_reads > 0 {
			state.pending_reads -= 1;
			if state.pending_reads == 0 {
				if let Some(write) = state.pending.take() {
					state.apply(write);
				}
			}
		}
		state
			.selection_count
			.unwrap_or_else(|| i32::from(state.selection.is_some()))
	}

	fn get_selection(&self, selection: i32) -> fdo::Result<(i32, i32)> {
		if selection != 0 {
			return Err(fdo::Error::InvalidArgs("only selection zero exists".to_owned()));
		}
		self
			.0
			.0
			.lock()
			.unwrap()
			.selection
			.ok_or_else(|| fdo::Error::InvalidArgs("no selection".to_owned()))
	}

	async fn add_selection(&self, start: i32, end: i32) -> bool {
		self.0.write(Write::Add(start, end)).await
	}

	async fn set_selection(&self, selection: i32, start: i32, end: i32) -> bool {
		self.0.write(Write::Replace(selection, start, end)).await
	}

	async fn set_caret_offset(&self, offset: i32) -> bool {
		self.0.write(Write::Caret(offset)).await
	}
}

struct Editable(Peer);

#[interface(name = "org.a11y.atspi.EditableText")]
impl Editable {
	fn set_text_contents(&self, _text: &str) -> bool {
		self.0.forbidden("SetTextContents")
	}

	fn insert_text(&self, _position: i32, _text: &str, _length: i32) -> bool {
		self.0.forbidden("InsertText")
	}

	fn delete_text(&self, _start: i32, _end: i32) -> bool {
		self.0.forbidden("DeleteText")
	}
}

struct Component(Peer);

#[interface(name = "org.a11y.atspi.Component")]
impl Component {
	fn grab_focus(&self) -> bool {
		self.0.forbidden("GrabFocus")
	}
}

struct Action(Peer);

#[interface(name = "org.a11y.atspi.Action")]
impl Action {
	fn do_action(&self, _index: i32) -> bool {
		self.0.forbidden("DoAction")
	}
}

struct Fixture {
	_server: Connection,
	ax:      AtSpiAx,
	peer:    Peer,
}

impl Fixture {
	fn new(state: PeerState) -> Self {
		let peer = Peer(Arc::new(Mutex::new(state)));
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let (server, connection) = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let server = ConnectionBuilder::unix_stream(server)
				.server(Guid::generate())
				.unwrap()
				.p2p()
				.serve_at(ELEMENT, Accessible(peer.clone()))
				.unwrap()
				.serve_at(ELEMENT, Text(peer.clone()))
				.unwrap()
				.serve_at(ELEMENT, Editable(peer.clone()))
				.unwrap()
				.serve_at(ELEMENT, Component(peer.clone()))
				.unwrap()
				.serve_at(ELEMENT, Action(peer.clone()))
				.unwrap()
				.serve_at("/app", Application(peer.clone()))
				.unwrap();
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			tokio::try_join!(server.build(), client).unwrap()
		});
		Self {
			_server: server,
			ax: AtSpiAx {
				rt,
				connection,
				reply_timeout: Duration::from_secs(2),
				native: None,
				frames: FrameCache::default(),
			},
			peer,
		}
	}

	fn select(&mut self, request: &TextSelectRequest) -> CoreResult<AxTextSelection> {
		let element = AxHandle::AtSpi(ObjectRefOwned::from_static_str_unchecked(PEER, ELEMENT));
		self.ax.select_text(&element, request)
	}

	fn writes(&self) -> Vec<Write> {
		let state = self.peer.0.lock().unwrap();
		assert!(state.forbidden.is_empty(), "forbidden operations: {:?}", state.forbidden);
		state.writes.clone()
	}
}

fn request(text: &str) -> TextSelectRequest {
	TextSelectRequest { text: text.to_owned(), ..TextSelectRequest::default() }
}

#[test]
fn selects_unicode_in_gtk_and_qt_units_without_editability_or_focus_changes() {
	for (toolkit, end) in [("GTK", 4), ("qT", 5)] {
		for focused in [false, true] {
			let mut state = PeerState::new("A🦀e\u{301} Z", toolkit);
			state.focused = focused;
			let mut fixture = Fixture::new(state);
			let selected = fixture.select(&request("🦀e\u{301}")).unwrap();
			assert_eq!(
				(selected.start, selected.length, selected.text.as_str()),
				(1, 4, "🦀e\u{301}")
			);
			assert_eq!(selected.focused, focused);
			assert_eq!(fixture.writes(), [Write::Add(1, end)]);
			let state = fixture.peer.0.lock().unwrap();
			assert_eq!(state.value, "A🦀e\u{301} Z");
			assert_eq!(state.focused, focused);
		}
	}
}

#[test]
fn replaces_one_selection_and_accepts_reversed_exact_readback_without_a_write() {
	for selection in [(0, 1), (4, 1)] {
		let mut state = PeerState::new("A🦀e\u{301} Z", "gtk");
		state.selection = Some(selection);
		let mut fixture = Fixture::new(state);
		let selected = fixture.select(&request("🦀e\u{301}")).unwrap();
		assert_eq!((selected.start, selected.length), (1, 4));
		assert_eq!(selected.text, "🦀e\u{301}");
		if selection == (0, 1) {
			assert_eq!(fixture.writes(), [Write::Replace(0, 1, 4)]);
		} else {
			assert!(fixture.writes().is_empty());
		}
	}
}

#[test]
fn places_start_end_and_empty_contextual_carets() {
	for (part, native, public) in [(SelectPart::Start, 1, 1), (SelectPart::End, 4, 5)] {
		let mut state = PeerState::new("A🦀e\u{301} Z", "gtk");
		state.selection = Some((0, 1));
		let mut fixture = Fixture::new(state);
		let selected = fixture
			.select(&TextSelectRequest { part, ..request("🦀e\u{301}") })
			.unwrap();
		assert_eq!((selected.start, selected.length, selected.text.as_str()), (public, 0, ""));
		assert_eq!(fixture.writes(), [Write::Caret(native)]);
		assert_eq!(fixture.peer.0.lock().unwrap().selection, None);
	}
	let mut fixture = Fixture::new(PeerState::new("a🦀b", "qt"));
	let selected = fixture
		.select(&TextSelectRequest {
			prefix: "a🦀".to_owned(),
			suffix: "b".to_owned(),
			..request("")
		})
		.unwrap();
	assert_eq!((selected.start, selected.length, selected.text.as_str()), (3, 0, ""));
	assert_eq!(fixture.writes(), [Write::Caret(3)]);
}

#[test]
fn matches_full_values_and_rejects_a_duplicate_beyond_the_display_limit() {
	let padding = "x".repeat(16_400);
	let mut fixture = Fixture::new(PeerState::new(&format!("{padding}needle"), "gtk"));
	let selected = fixture.select(&request("needle")).unwrap();
	assert_eq!((selected.start, selected.length, selected.text.as_str()), (16_400, 6, "needle"));
	assert_eq!(fixture.writes(), [Write::Add(16_400, 16_406)]);

	let mut fixture = Fixture::new(PeerState::new(&format!("needle{padding}needle"), "gtk"));
	assert!(fixture.select(&request("needle")).is_err());
	assert!(fixture.writes().is_empty());
}

#[test]
fn refuses_inconsistent_text_counts_before_mutation() {
	let mut hidden = PeerState::new("😀ab", "gtk");
	hidden.count = Some(4); // GTK counts an invisible buffer character; 4 is also the visible UTF-16 length.
	let mut negative = PeerState::new("abc", "gtk");
	negative.count = Some(-1);
	let mut changing = PeerState::new("abc", "gtk");
	changing.changing_count = true;
	let mut qt_scalar_count = PeerState::new("😀ab", "qt");
	qt_scalar_count.count = Some(3);
	for state in [hidden, negative, changing, qt_scalar_count] {
		let mut fixture = Fixture::new(state);
		assert_eq!(fixture.select(&request("a")).unwrap_err().code, ErrorCode::AxFailed);
		assert!(fixture.writes().is_empty());
	}
}

#[test]
fn refuses_unsafe_or_unreadable_elements_without_reading_passwords() {
	for case in 0..7 {
		let mut state = PeerState::new("abc", "gtk");
		match case {
			0 => state.interfaces = false,
			1 => state.role = Some(Role::PasswordText),
			2 => state.role = None,
			3 => state.toolkit = "unknown",
			4 => state.toolkit = "",
			5 => state.enabled = false,
			6 => state.defunct = true,
			_ => unreachable!(),
		}
		let mut fixture = Fixture::new(state);
		assert!(fixture.select(&request("a")).is_err(), "case {case}");
		assert!(fixture.writes().is_empty(), "case {case}");
		assert_eq!(fixture.peer.0.lock().unwrap().text_reads, 0, "case {case}");
	}
	let mut fixture = Fixture::new(PeerState::new("●●●", "qt"));
	assert!(fixture.select(&request("●")).is_err());
	assert!(fixture.writes().is_empty());
}

#[test]
fn preserves_multiple_and_invalid_existing_selections() {
	for case in 0..6 {
		let mut state = PeerState::new("a🦀b", "qt");
		match case {
			0 => state.selection_count = Some(2),
			1 => state.selection_count = Some(-1),
			2 => state.selection = Some((-1, 1)),
			3 => state.selection = Some((0, 99)),
			4 => state.selection = Some((1, 2)), // Splits the crab's surrogate pair.
			5 => state.caret = -1,
			_ => unreachable!(),
		}
		let mut fixture = Fixture::new(state);
		assert!(fixture.select(&request("b")).is_err(), "case {case}");
		assert!(fixture.writes().is_empty(), "case {case}");
	}
}

#[test]
fn refuses_false_or_unverified_setter_replies_without_retrying_mutation() {
	for response in [
		Response::Reject,
		Response::Ignore,
		Response::Clamp,
		Response::InvalidRange,
		Response::ChangeText,
		Response::ChangeFocus,
		Response::UnreadableFocus,
	] {
		let mut state = PeerState::new("abc", "gtk");
		state.response = response;
		let mut fixture = Fixture::new(state);
		assert_eq!(
			fixture.select(&request("bc")).unwrap_err().code,
			ErrorCode::AxUnconfirmed,
			"response {response:?}"
		);
		assert_eq!(fixture.writes(), [Write::Add(1, 3)], "response {response:?}");
	}
}

#[test]
fn a_caret_under_a_surviving_selection_is_not_confirmed() {
	let mut state = PeerState::new("abc", "gtk");
	state.selection = Some((0, 2));
	state.response = Response::KeepSelection;
	let mut fixture = Fixture::new(state);
	assert_eq!(
		fixture
			.select(&TextSelectRequest { part: SelectPart::End, ..request("b") })
			.unwrap_err()
			.code,
		ErrorCode::AxUnconfirmed
	);
	assert_eq!(fixture.writes(), [Write::Caret(2)]);
	assert_eq!(fixture.peer.0.lock().unwrap().selection, Some((0, 2)));
}

#[test]
fn waits_for_readback_without_sending_the_selection_again() {
	let mut state = PeerState::new("abc", "gtk");
	state.response = Response::Deferred;
	let mut fixture = Fixture::new(state);
	let selected = fixture.select(&request("bc")).unwrap();
	assert_eq!((selected.start, selected.length, selected.text.as_str()), (1, 2, "bc"));
	assert_eq!(fixture.writes(), [Write::Add(1, 3)]);
}

#[test]
fn detects_focus_changes_during_final_text_readback() {
	for already_selected in [false, true] {
		let mut state = PeerState::new("abc", "gtk");
		state.response = Response::ChangeFocusDuringReadback;
		state.selection = already_selected.then_some((1, 3));
		let mut fixture = Fixture::new(state);
		let expected = if already_selected {
			ErrorCode::AxFailed
		} else {
			ErrorCode::AxUnconfirmed
		};
		assert_eq!(fixture.select(&request("bc")).unwrap_err().code, expected);
		if already_selected {
			assert!(fixture.writes().is_empty());
		} else {
			assert_eq!(fixture.writes(), [Write::Add(1, 3)]);
		}
		assert!(fixture.peer.0.lock().unwrap().focused);
	}
}

#[test]
fn cancellation_and_timeout_preserve_whether_a_write_might_have_landed() {
	for stage in [Stage::BeforeWrite, Stage::Write, Stage::Readback] {
		for cancelled in [false, true] {
			let source = control::CancellationSource::default();
			let mut state = PeerState::new("abc", "gtk");
			state.stop = Some(stage);
			state.cancel = cancelled.then(|| source.clone());
			let mut fixture = Fixture::new(state);
			fixture.ax.reply_timeout = Duration::from_millis(200);
			let result =
				control::with_token_for_test(&source.token(), || fixture.select(&request("bc")));
			let expected = if stage != Stage::BeforeWrite {
				ErrorCode::AxUnconfirmed
			} else if cancelled {
				ErrorCode::Cancelled
			} else {
				ErrorCode::Timeout
			};
			assert_eq!(result.unwrap_err().code, expected, "stage {stage:?}, cancelled {cancelled}");
			if stage == Stage::BeforeWrite {
				assert!(fixture.writes().is_empty());
			} else {
				assert_eq!(fixture.writes(), [Write::Add(1, 3)]);
			}
		}
	}
}
