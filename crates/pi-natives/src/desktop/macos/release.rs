//! What the input-release helper is told and what it releases.
//!
//! While an input request holds a key or button, the addon streams each press,
//! its prepared release event, and each release to a helper process
//! (`release_helper.rs`). When the stream ends with presses still open (the
//! process died, or a panic unwound the request), the helper posts those
//! releases itself. Both sides compile this file, so it uses only `std`.

/// Sent by the helper once it observes the user's input (after
/// [`Record::Observe`]), so presses on the shared HID route never race its
/// first observation.
pub(crate) const READY: u8 = 1;

/// How an event reached its target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Route {
	/// The HID event tap, shared with the user's own keyboard and mouse.
	Hid,
	/// The authenticated per-process keyboard route.
	Keyboard(i32),
	/// The per-process `SkyLight` pointer route.
	Routed(i32),
	/// The per-process `SkyLight` route, then the public per-process queue.
	Dual(i32),
}

/// What a press holds down: a virtual key code or a mouse button number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Input {
	Key(u16),
	Button(u8),
}

/// One message of the addon-to-helper stream.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Record {
	/// Presses will go to the shared HID route: start following what the user
	/// physically holds, then answer [`READY`].
	Observe,
	/// `input` went down on `route`; `event` is the serialized `CGEvent` that
	/// releases it.
	Press { id: u32, route: Route, input: Input, event: Vec<u8> },
	/// The release of press `id` moved, as a drag does.
	Update { id: u32, event: Vec<u8> },
	/// Press `id` was released.
	Release { id: u32 },
}

const OBSERVE: u8 = b'O';
const PRESS: u8 = b'P';
const UPDATE: u8 = b'U';
const RELEASE: u8 = b'R';

impl Record {
	pub(crate) fn encode(&self, out: &mut Vec<u8>) {
		match self {
			Self::Observe => out.push(OBSERVE),
			Self::Press { id, route, input, event } => {
				out.push(PRESS);
				out.extend_from_slice(&id.to_le_bytes());
				let (kind, pid) = match *route {
					Route::Hid => (0u8, 0),
					Route::Keyboard(pid) => (1, pid),
					Route::Routed(pid) => (2, pid),
					Route::Dual(pid) => (3, pid),
				};
				out.push(kind);
				out.extend_from_slice(&pid.to_le_bytes());
				let (kind, code) = match *input {
					Input::Key(code) => (0u8, code),
					Input::Button(number) => (1, u16::from(number)),
				};
				out.push(kind);
				out.extend_from_slice(&code.to_le_bytes());
				put_bytes(out, event);
			},
			Self::Update { id, event } => {
				out.push(UPDATE);
				out.extend_from_slice(&id.to_le_bytes());
				put_bytes(out, event);
			},
			Self::Release { id } => {
				out.push(RELEASE);
				out.extend_from_slice(&id.to_le_bytes());
			},
		}
	}

	/// The first complete record in `bytes` and its encoded length; `None`
	/// while it is incomplete. A malformed stream is an error.
	pub(crate) fn decode(bytes: &[u8]) -> Result<Option<(Self, usize)>, String> {
		let mut reader = Reader { bytes, at: 0 };
		let Some(tag) = reader.take::<1>() else {
			return Ok(None);
		};
		let record = match tag[0] {
			OBSERVE => Self::Observe,
			PRESS => {
				let Some((id, route, input, event)) = (|| {
					let id = u32::from_le_bytes(reader.take()?);
					let route = reader.take::<1>()?[0];
					let pid = i32::from_le_bytes(reader.take()?);
					let input = reader.take::<1>()?[0];
					let code = u16::from_le_bytes(reader.take()?);
					Some((id, (route, pid), (input, code), reader.bytes()?))
				})() else {
					return Ok(None);
				};
				let route = match route {
					(0, _) => Route::Hid,
					(1, pid) => Route::Keyboard(pid),
					(2, pid) => Route::Routed(pid),
					(3, pid) => Route::Dual(pid),
					(kind, _) => return Err(format!("unknown route {kind}")),
				};
				let input = match input {
					(0, code) => Input::Key(code),
					(1, number) => Input::Button(
						u8::try_from(number).map_err(|_| format!("button {number} out of range"))?,
					),
					(kind, _) => return Err(format!("unknown input {kind}")),
				};
				Self::Press { id, route, input, event }
			},
			UPDATE => {
				let Some((id, event)) =
					(|| Some((u32::from_le_bytes(reader.take()?), reader.bytes()?)))()
				else {
					return Ok(None);
				};
				Self::Update { id, event }
			},
			RELEASE => {
				let Some(id) = reader.take() else {
					return Ok(None);
				};
				Self::Release { id: u32::from_le_bytes(id) }
			},
			tag => return Err(format!("unknown record {tag}")),
		};
		Ok(Some((record, reader.at)))
	}
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
	out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
	out.extend_from_slice(bytes);
}

struct Reader<'a> {
	bytes: &'a [u8],
	at:    usize,
}

impl Reader<'_> {
	fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
		let value = self.bytes.get(self.at..self.at + N)?.try_into().ok()?;
		self.at += N;
		Some(value)
	}

	fn bytes(&mut self) -> Option<Vec<u8>> {
		let length = u32::from_le_bytes(self.take()?) as usize;
		let value = self.bytes.get(self.at..self.at + length)?.to_vec();
		self.at += length;
		Some(value)
	}
}

/// A press the helper still holds open, in press order.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Open {
	pub(crate) id:    u32,
	pub(crate) route: Route,
	pub(crate) input: Input,
	pub(crate) event: Vec<u8>,
}

/// Applies `record` to the open presses.
pub(crate) fn apply(open: &mut Vec<Open>, record: Record) {
	match record {
		Record::Observe => {},
		Record::Press { id, route, input, event } => open.push(Open { id, route, input, event }),
		Record::Update { id, event } => {
			if let Some(press) = open.iter_mut().find(|press| press.id == id) {
				press.event = event;
			}
		},
		Record::Release { id } => open.retain(|press| press.id != id),
	}
}

/// The keys and buttons the user physically holds, as observed on the HID
/// route.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct UserHolds {
	keys:    u128,
	buttons: u32,
}

impl UserHolds {
	pub(crate) const fn set(&mut self, input: Input, down: bool) {
		match input {
			Input::Key(code) if code < 128 => {
				let bit = 1u128 << code;
				self.keys = if down {
					self.keys | bit
				} else {
					self.keys & !bit
				};
			},
			Input::Button(number) if number < 32 => {
				let bit = 1u32 << number;
				self.buttons = if down {
					self.buttons | bit
				} else {
					self.buttons & !bit
				};
			},
			_ => {},
		}
	}

	/// Whether the user holds `input`, or for a modifier, the same modifier on
	/// either side: both sides share one modifier flag.
	pub(crate) fn holds(self, input: Input) -> bool {
		match input {
			Input::Key(code) => match modifier(code) {
				Some((_, sides)) => sides.iter().any(|&(code, _)| self.has(Input::Key(code))),
				None => self.has(input),
			},
			Input::Button(_) => self.has(input),
		}
	}

	/// Whether the user holds exactly `input`.
	pub(crate) const fn has(self, input: Input) -> bool {
		match input {
			Input::Key(code) => code < 128 && self.keys & (1 << code) != 0,
			Input::Button(number) => number < 32 && self.buttons & (1 << number) != 0,
		}
	}

	fn flags(self) -> u64 {
		MODIFIERS
			.iter()
			.filter(|(_, sides)| sides.iter().any(|&(code, _)| self.has(Input::Key(code))))
			.fold(0, |flags, (flag, _)| flags | flag)
	}
}

/// Device-independent flag, and the left and right virtual key codes with
/// their device-dependent flags, of each modifier a held key can carry.
const MODIFIERS: [(u64, [(u16, u64); 2]); 4] = [
	(0x40000, [(59, 0x1), (62, 0x2000)]), // control
	(0x80000, [(58, 0x20), (61, 0x40)]),  // option
	(0x20000, [(56, 0x2), (60, 0x4)]),    // shift
	(0x100000, [(55, 0x8), (54, 0x10)]),  // command
];
/// Every device-dependent modifier flag: hardware sets them, the addon never
/// does.
const DEVICE_FLAGS: u64 = 0x207f;

fn modifier(code: u16) -> Option<(u64, [(u16, u64); 2])> {
	MODIFIERS
		.into_iter()
		.find(|(_, sides)| sides.iter().any(|&(side, _)| side == code))
}

pub(crate) const KEY_DOWN: u32 = 10;
pub(crate) const KEY_UP: u32 = 11;
pub(crate) const FLAGS_CHANGED: u32 = 12;
/// Down, up and dragged event types of the left, right and other buttons.
const BUTTON_EVENTS: [[u32; 3]; 3] = [[1, 2, 6], [3, 4, 7], [25, 26, 27]];
/// Every key and button event type [`transition`] reads.
pub(crate) const TRANSITION_TYPES: [u32; 12] = [1, 2, 3, 4, 6, 7, 10, 11, 12, 25, 26, 27];

/// What an event does to the key or button it carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Transition {
	Press(Input),
	Release(Input),
	/// A held button moved: a drag.
	Move(Input),
}

/// Reads the transition of an event of type `kind` with key code `code`,
/// `flags` and mouse button number `button`. A modifier event says which way
/// it went through its flags: hardware sets each side's device-dependent
/// flag, the addon the shared one, and without either the modifier is up, as
/// apps read it. A key with no modifier flag of its own, such as Caps Lock,
/// toggles what `held` reports for it.
pub(crate) fn transition(
	kind: u32,
	code: u16,
	flags: u64,
	button: i64,
	held: impl FnOnce(Input) -> bool,
) -> Option<Transition> {
	for (number, [down, up, dragged]) in (0u8..).zip(BUTTON_EVENTS) {
		// Left and right have fixed numbers; other buttons carry theirs.
		let input = Input::Button(if number < 2 {
			number
		} else {
			u8::try_from(button).unwrap_or(u8::MAX)
		});
		match kind {
			kind if kind == down => return Some(Transition::Press(input)),
			kind if kind == up => return Some(Transition::Release(input)),
			kind if kind == dragged => return Some(Transition::Move(input)),
			_ => {},
		}
	}
	let key = Input::Key(code);
	match kind {
		KEY_DOWN => Some(Transition::Press(key)),
		KEY_UP => Some(Transition::Release(key)),
		FLAGS_CHANGED => {
			let side = modifier(code).and_then(|(flag, sides)| {
				let &(_, device) = sides.iter().find(|&&(side, _)| side == code)?;
				Some((flag, device))
			});
			let down = match side {
				Some((_, device)) if flags & DEVICE_FLAGS != 0 => flags & device != 0,
				Some((flag, _)) => flags & flag != 0,
				None => !held(key),
			};
			Some(if down {
				Transition::Press(key)
			} else {
				Transition::Release(key)
			})
		},
		_ => None,
	}
}

/// The event type that releases what an event of type `kind` holds: a key
/// down's key up, or a button down's or drag's button up. Modifier events
/// keep their type; their flags say which way they went.
pub(crate) fn release_type(kind: u32) -> u32 {
	match kind {
		KEY_DOWN => KEY_UP,
		kind => BUTTON_EVENTS
			.iter()
			.find(|[down, _, dragged]| kind == *down || kind == *dragged)
			.map_or(kind, |[_, up, _]| *up),
	}
}

/// What the helper does with one open press.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
	/// Post the press's release; a key release carries `flags`.
	Post { id: u32, flags: Option<u64> },
	/// Leave the press to the user, who holds the same key or button on the
	/// shared HID route: their own release ends it, and posting one would cut
	/// their hold short.
	Leave { id: u32 },
}

/// The releases of `open` (in press order), latest press first, as the
/// in-process cleanup posts them. Per-process routes reach only the target
/// and always release. A key release carries the modifiers still held on its
/// route, plus on the HID route the ones the user holds.
pub(crate) fn plan(open: &[Open], user: UserHolds) -> Vec<Step> {
	open
		.iter()
		.enumerate()
		.rev()
		.map(|(index, press)| {
			if press.route == Route::Hid && user.holds(press.input) {
				return Step::Leave { id: press.id };
			}
			let flags = matches!(press.input, Input::Key(_)).then(|| {
				let held = open[..index]
					.iter()
					.filter(|earlier| earlier.route == press.route)
					.filter_map(|earlier| match earlier.input {
						Input::Key(code) => modifier(code).map(|(flag, _)| flag),
						Input::Button(_) => None,
					})
					.fold(0, |flags, flag| flags | flag);
				if press.route == Route::Hid {
					held | user.flags()
				} else {
					held
				}
			});
			Step::Post { id: press.id, flags }
		})
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	const SHIFT: u16 = 56;
	const RIGHT_SHIFT: u16 = 60;
	const OPTION: u16 = 58;
	const A: u16 = 0;

	fn press(id: u32, route: Route, input: Input) -> Open {
		Open { id, route, input, event: vec![id as u8] }
	}

	fn holding(inputs: &[Input]) -> UserHolds {
		let mut user = UserHolds::default();
		for &input in inputs {
			user.set(input, true);
		}
		user
	}

	#[test]
	fn records_survive_the_stream_and_a_cut_tail_is_not_a_record() {
		let records = [
			Record::Observe,
			Record::Press {
				id:    7,
				route: Route::Keyboard(4321),
				input: Input::Key(SHIFT),
				event: vec![1, 2, 3],
			},
			Record::Press { id: 8, route: Route::Hid, input: Input::Button(2), event: vec![] },
			Record::Update { id: 8, event: vec![9; 300] },
			Record::Release { id: 7 },
		];
		let mut stream = Vec::new();
		for record in &records {
			record.encode(&mut stream);
		}
		let decode_all = |bytes: &[u8]| {
			let mut decoded = Vec::new();
			let mut at = 0;
			while let Some((record, length)) = Record::decode(&bytes[at..]).expect("valid stream") {
				decoded.push(record);
				at += length;
			}
			decoded
		};
		assert_eq!(decode_all(&stream), records);
		// A process killed mid-write leaves a partial record, which posted
		// nothing yet: presses are written before they are posted.
		assert_eq!(decode_all(&stream[..stream.len() - 1]), records[..4]);
		assert!(Record::decode(b"X").is_err());
	}

	#[test]
	fn open_presses_follow_presses_updates_and_releases() {
		let mut open = Vec::new();
		apply(&mut open, Record::Press {
			id:    1,
			route: Route::Hid,
			input: Input::Key(SHIFT),
			event: vec![1],
		});
		apply(&mut open, Record::Press {
			id:    2,
			route: Route::Dual(9),
			input: Input::Button(0),
			event: vec![2],
		});
		apply(&mut open, Record::Update { id: 2, event: vec![3] });
		apply(&mut open, Record::Release { id: 1 });
		assert_eq!(open, [Open {
			id:    2,
			route: Route::Dual(9),
			input: Input::Button(0),
			event: vec![3],
		}]);
	}

	#[test]
	fn releases_latest_first_with_the_modifiers_still_held() {
		let open = [
			press(1, Route::Keyboard(9), Input::Key(SHIFT)),
			press(2, Route::Keyboard(9), Input::Key(OPTION)),
			press(3, Route::Keyboard(9), Input::Key(A)),
			press(4, Route::Dual(9), Input::Button(0)),
		];
		assert_eq!(plan(&open, UserHolds::default()), [
			Step::Post { id: 4, flags: None },
			Step::Post { id: 3, flags: Some(0x20000 | 0x80000) },
			Step::Post { id: 2, flags: Some(0x20000) },
			Step::Post { id: 1, flags: Some(0) },
		]);
	}

	#[test]
	fn never_releases_on_the_hid_route_what_the_user_holds() {
		let open = [press(1, Route::Hid, Input::Key(SHIFT)), press(2, Route::Hid, Input::Button(0))];
		// Negative control: nobody else holds them, so both are released.
		assert_eq!(plan(&open, UserHolds::default()), [
			Step::Post { id: 2, flags: None },
			Step::Post { id: 1, flags: Some(0) },
		]);
		assert_eq!(plan(&open, holding(&[Input::Key(SHIFT), Input::Button(0)])), [
			Step::Leave { id: 2 },
			Step::Leave { id: 1 },
		]);
		// Either Shift key holds the one Shift flag.
		assert_eq!(plan(&open[..1], holding(&[Input::Key(RIGHT_SHIFT)])), [Step::Leave { id: 1 }]);
		// A different button of the user's is not the agent's.
		assert_eq!(plan(&open[1..], holding(&[Input::Button(1)])), [Step::Post {
			id:    2,
			flags: None,
		}]);
	}

	#[test]
	fn hid_releases_keep_the_users_other_modifiers() {
		let open = [press(1, Route::Hid, Input::Key(SHIFT))];
		assert_eq!(plan(&open, holding(&[Input::Key(OPTION)])), [Step::Post {
			id:    1,
			flags: Some(0x80000),
		}]);
	}

	#[test]
	fn per_process_releases_reach_only_the_target_and_ignore_the_user() {
		let open = [
			press(1, Route::Keyboard(9), Input::Key(SHIFT)),
			press(2, Route::Routed(9), Input::Button(0)),
		];
		assert_eq!(
			plan(&open, holding(&[Input::Key(SHIFT), Input::Key(OPTION), Input::Button(0)])),
			[Step::Post { id: 2, flags: None }, Step::Post { id: 1, flags: Some(0) },]
		);
	}

	#[test]
	fn the_user_letting_go_ends_the_hold() {
		let mut user = holding(&[Input::Key(SHIFT)]);
		user.set(Input::Key(SHIFT), false);
		assert!(!user.holds(Input::Key(SHIFT)));
		assert_eq!(plan(&[press(1, Route::Hid, Input::Key(SHIFT))], user), [Step::Post {
			id:    1,
			flags: Some(0),
		}]);
	}

	#[test]
	fn transitions_read_the_addons_and_the_users_modifier_events() {
		let released = |kind, code, flags| transition(kind, code, flags, 0, |_| true);
		let fresh = |kind, code, flags| transition(kind, code, flags, 0, |_| false);
		let shift = Input::Key(SHIFT);
		// The addon's own events carry only the shared flag.
		assert_eq!(fresh(FLAGS_CHANGED, SHIFT, 0x20000), Some(Transition::Press(shift)));
		assert_eq!(released(FLAGS_CHANGED, SHIFT, 0), Some(Transition::Release(shift)));
		// Releasing Shift while Option stays down still releases Shift.
		assert_eq!(released(FLAGS_CHANGED, SHIFT, 0x80000), Some(Transition::Release(shift)));
		// A modifier posted with no flags is up, even one not yet held: a
		// cancelled press's release is not a press.
		assert_eq!(fresh(FLAGS_CHANGED, SHIFT, 0), Some(Transition::Release(shift)));
		// Caps Lock has no modifier flag of its own, so it toggles.
		assert_eq!(fresh(FLAGS_CHANGED, 57, 0), Some(Transition::Press(Input::Key(57))));
		assert_eq!(released(FLAGS_CHANGED, 57, 0), Some(Transition::Release(Input::Key(57))));
		// Hardware: right Shift goes up while left Shift stays down, so the
		// shared flag is still set.
		assert_eq!(
			released(FLAGS_CHANGED, RIGHT_SHIFT, 0x20102),
			Some(Transition::Release(Input::Key(RIGHT_SHIFT)))
		);
		assert_eq!(released(FLAGS_CHANGED, SHIFT, 0x20102), Some(Transition::Press(shift)));
		assert_eq!(fresh(KEY_DOWN, A, 0), Some(Transition::Press(Input::Key(A))));
		assert_eq!(fresh(KEY_UP, A, 0), Some(Transition::Release(Input::Key(A))));
		assert_eq!(fresh(6, 0, 0), Some(Transition::Move(Input::Button(0))));
		assert_eq!(fresh(4, 0, 0), Some(Transition::Release(Input::Button(1))));
		assert_eq!(transition(25, 0, 0, 3, |_| false), Some(Transition::Press(Input::Button(3))));
		assert_eq!(fresh(5, 0, 0), None);
	}
}
