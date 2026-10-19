//! Character → virtual key lookup on the current keyboard layout, so typed
//! text reaches applications that read a key event's key code rather than
//! the Unicode text it carries.

use std::{
	collections::HashMap,
	process::{Command, Stdio},
	sync::Arc,
	time::{Duration, Instant},
};

use parking_lot::Mutex;

use super::super::{
	control,
	error::{CoreResult, DesktopError},
	native_helper::HelperDirectory,
};

/// A key, with the modifiers held around it, that types one character.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Keystroke {
	pub code:   u16,
	pub shift:  bool,
	pub option: bool,
}

pub(super) struct Keymap {
	strokes: HashMap<char, Keystroke>,
}

/// Virtual key codes of Return and Tab, which are the same on every layout;
/// the layout maps them to control characters.
const RETURN: u16 = 36;
const TAB: u16 = 48;
/// Highest virtual key code a keyboard layout defines.
const MAX_KEY_CODE: u16 = 127;
/// `UCKeyTranslate` modifier bits (`EventModifiers` shifted right by 8).
const SHIFT_STATE: u32 = 0x02;
const OPTION_STATE: u32 = 0x08;
const KEY_ACTION_DOWN: u16 = 0;

/// Writes the current layout's keyboard type and `uchr` data to a file.
const HELPER: &[u8] = include_bytes!(env!("OMP_KEYMAP_DARWIN_HELPER"));
/// The helper's exit status for a layout without Unicode key layout data.
const NO_LAYOUT_DATA: i32 = 3;
const HELPER_TIMEOUT: Duration = Duration::from_secs(5);
const HELPER_POLL: Duration = Duration::from_millis(2);
/// How long a read keyboard layout is reused: typing in quick succession
/// skips the helper, and a layout switch takes effect within this.
const KEYMAP_TTL: Duration = Duration::from_secs(10);

/// When the current layout was last read, and its map.
type CachedKeymap = Mutex<Option<(Instant, Option<Arc<Keymap>>)>>;

static CURRENT: CachedKeymap = Mutex::new(None);

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
	fn UCKeyTranslate(
		layout: *const u8,
		code: u16,
		action: u16,
		modifiers: u32,
		keyboard_type: u32,
		options: u32,
		dead_key_state: *mut u32,
		capacity: usize,
		length: *mut usize,
		characters: *mut u16,
	) -> i32;
}

impl Keymap {
	/// The map of the current keyboard layout, read at most once per
	/// `KEYMAP_TTL`; `None` when the layout publishes no Unicode key layout
	/// data.
	pub(super) fn current() -> CoreResult<Option<Arc<Self>>> {
		cached(&CURRENT, Instant::now(), Self::read)
	}

	/// Text Input Sources asserts that it runs on the main queue, which the
	/// desktop worker thread is not, so a helper process reads the layout.
	fn read() -> CoreResult<Option<Self>> {
		let Some((keyboard_type, layout)) = current_layout()? else {
			return Ok(None);
		};
		Ok(Some(Self::build(|code, modifiers| {
			// Dead-key processing stays on, so a dead key yields no character and
			// never maps: posted alone it would accent the next character instead.
			let mut dead_key_state = 0;
			let mut characters = [0u16; 4];
			let mut length = 0;
			// SAFETY: `layout` holds the layout's `uchr` data for the whole call,
			// and every out-pointer is valid for the stated capacity.
			let status = unsafe {
				UCKeyTranslate(
					layout.as_ptr().cast::<u8>(),
					code,
					KEY_ACTION_DOWN,
					modifiers,
					keyboard_type,
					0,
					&raw mut dead_key_state,
					characters.len(),
					&raw mut length,
					characters.as_mut_ptr(),
				)
			};
			(status == 0)
				.then(|| single_char(&characters[..length.min(characters.len())]))
				.flatten()
		})))
	}

	/// Keeps, per character, the first key that types it, trying no
	/// modifiers, then Shift, Option and Shift-Option, and main keys before
	/// the keypad, whose digits and operators repeat the main row.
	fn build(translate: impl Fn(u16, u32) -> Option<char>) -> Self {
		let codes = (0..=MAX_KEY_CODE)
			.filter(|&code| !is_keypad(code))
			.chain((0..=MAX_KEY_CODE).filter(|&code| is_keypad(code)));
		let mut strokes = HashMap::new();
		for (shift, option) in [(false, false), (true, false), (false, true), (true, true)] {
			let state = if shift { SHIFT_STATE } else { 0 } | if option { OPTION_STATE } else { 0 };
			for code in codes.clone() {
				if let Some(character) = translate(code, state) {
					strokes
						.entry(character)
						.or_insert(Keystroke { code, shift, option });
				}
			}
		}
		for (character, code) in [('\r', RETURN), ('\n', RETURN), ('\t', TAB)] {
			strokes.insert(character, Keystroke { code, shift: false, option: false });
		}
		Self { strokes }
	}

	pub(super) fn stroke(&self, character: char) -> Option<Keystroke> {
		self.strokes.get(&character).copied()
	}
}

/// `slot`'s map while it is younger than `KEYMAP_TTL` at `now`, otherwise a
/// new one from `read`. A failed read, cancellation included, is returned and
/// not kept, so the next call reads again.
fn cached(
	slot: &CachedKeymap,
	now: Instant,
	read: impl FnOnce() -> CoreResult<Option<Keymap>>,
) -> CoreResult<Option<Arc<Keymap>>> {
	let mut slot = slot.lock();
	if let Some((read_at, keymap)) = &*slot
		&& now.saturating_duration_since(*read_at) < KEYMAP_TTL
	{
		return Ok(keymap.clone());
	}
	let keymap = read()?.map(Arc::new);
	*slot = Some((now, keymap.clone()));
	Ok(keymap)
}

/// The current layout's keyboard type and `uchr` data, read by the helper;
/// `None` when the layout has no Unicode key layout data. The data is kept in
/// 4-byte words because `UCKeyTranslate` reads aligned table fields.
fn current_layout() -> CoreResult<Option<(u32, Vec<u32>)>> {
	let failed = |error: &dyn std::fmt::Display| {
		DesktopError::input_failed(format!("cannot read the keyboard layout: {error}"))
	};
	let directory = HelperDirectory::create("omp-keymap")?;
	let executable = directory.write("omp-keymap-helper", HELPER, 0o700)?;
	let output = directory.write("layout", &[], 0o600)?;
	let mut child = Command::new(executable)
		.arg(&output)
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.map_err(|error| failed(&error))?;
	let deadline = Instant::now() + HELPER_TIMEOUT;
	let status = loop {
		let polled = control::check().and_then(|()| {
			if Instant::now() >= deadline {
				return Err(DesktopError::timeout("the keyboard layout helper did not finish"));
			}
			child.try_wait().map_err(|error| failed(&error))
		});
		match polled {
			Ok(Some(status)) => break status,
			Ok(None) => std::thread::sleep(HELPER_POLL),
			Err(error) => {
				let _ = child.kill();
				let _ = child.wait();
				return Err(error);
			},
		}
	};
	match status.code() {
		Some(0) => {},
		Some(NO_LAYOUT_DATA) => return Ok(None),
		_ => return Err(failed(&format!("helper exited with {status}"))),
	}
	let bytes = std::fs::read(&output).map_err(|error| failed(&error))?;
	let (Some(header), Some(data)) = (bytes.get(..4), bytes.get(4..)) else {
		return Err(failed(&"helper output is truncated"));
	};
	let keyboard_type = u32::from_le_bytes(header.try_into().expect("four header bytes"));
	let mut layout = vec![0u32; data.len().div_ceil(4)];
	for (word, chunk) in layout.iter_mut().zip(data.chunks(4)) {
		let mut bytes = [0u8; 4];
		bytes[..chunk.len()].copy_from_slice(chunk);
		*word = u32::from_ne_bytes(bytes);
	}
	Ok(Some((keyboard_type, layout)))
}

const fn is_keypad(code: u16) -> bool {
	matches!(code, 65 | 67 | 69 | 71 | 75 | 76 | 78 | 81..=89 | 91 | 92)
}

/// The one printable character `units` spell, if they spell exactly one.
fn single_char(units: &[u16]) -> Option<char> {
	let mut characters = char::decode_utf16(units.iter().copied());
	match (characters.next(), characters.next()) {
		(Some(Ok(character)), None) if !character.is_control() => Some(character),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::desktop::error::ErrorCode;

	/// Key 0 types `q`/`Q`/`@`, key 1 types `é` only with Shift-Option, keypad
	/// 83 and main 18 both type `1`, and Return yields a control character.
	fn translate(code: u16, state: u32) -> Option<char> {
		match (code, state) {
			(0, 0) => Some('q'),
			(0, SHIFT_STATE) => Some('Q'),
			(0, OPTION_STATE) => Some('@'),
			(1, 0) => Some('e'),
			(1, 0x0a) => Some('é'),
			(18 | 83, 0) => Some('1'),
			(83, SHIFT_STATE) => Some('+'),
			(RETURN, _) => single_char(&[0x0d]),
			_ => None,
		}
	}

	#[test]
	fn characters_map_to_the_layouts_keys_with_their_modifiers() {
		let keymap = Keymap::build(translate);
		let stroke = |code, shift, option| Some(Keystroke { code, shift, option });
		assert_eq!(keymap.stroke('q'), stroke(0, false, false));
		assert_eq!(keymap.stroke('Q'), stroke(0, true, false));
		assert_eq!(keymap.stroke('@'), stroke(0, false, true));
		assert_eq!(keymap.stroke('é'), stroke(1, true, true));
		// The main row wins over the keypad; a keypad-only character still maps.
		assert_eq!(keymap.stroke('1'), stroke(18, false, false));
		assert_eq!(keymap.stroke('+'), stroke(83, true, false));
		// Return and Tab come from fixed codes, not the layout's control
		// characters.
		assert_eq!(keymap.stroke('\n'), stroke(RETURN, false, false));
		assert_eq!(keymap.stroke('\r'), stroke(RETURN, false, false));
		assert_eq!(keymap.stroke('\t'), stroke(TAB, false, false));
		assert_eq!(keymap.stroke('😀'), None);
	}

	#[test]
	fn only_one_printable_character_counts_as_typed() {
		// A dead key yields nothing, a control key a control character, and a
		// ligature key several characters: none of them types one character.
		assert_eq!(single_char(&[]), None);
		assert_eq!(single_char(&[0x0d]), None);
		assert_eq!(single_char(&[0x61, 0x62]), None);
		assert_eq!(single_char(&[0xd800]), None);
		assert_eq!(single_char(&[0x61]), Some('a'));
		assert_eq!(single_char(&[0xd83d, 0xde00]), Some('😀'));
	}

	#[test]
	fn current_layout_types_space_on_the_space_bar() {
		// Every layout types a space with the space bar, whatever its letters.
		// The lookup runs off the main thread, as on the desktop worker.
		let keymap = std::thread::spawn(Keymap::current)
			.join()
			.expect("keymap thread")
			.expect("keyboard layout helper");
		// A session without a keyboard layout (no Aqua login) has nothing to map.
		let Some(keymap) = keymap else {
			return;
		};
		assert_eq!(keymap.stroke(' '), Some(Keystroke { code: 49, shift: false, option: false }));
	}

	#[test]
	fn layout_is_reused_until_it_ages_out_and_a_failed_read_is_not_kept() {
		let slot = CachedKeymap::default();
		let reads = std::cell::Cell::new(0);
		let read = || {
			reads.set(reads.get() + 1);
			Ok(Some(Keymap::build(translate)))
		};
		let start = Instant::now();
		cached(&slot, start, read).unwrap();
		let reused = cached(&slot, start + KEYMAP_TTL / 2, || panic!("read within the TTL")).unwrap();
		assert_eq!(
			reused.unwrap().stroke('q'),
			Some(Keystroke { code: 0, shift: false, option: false })
		);
		cached(&slot, start + KEYMAP_TTL, read).unwrap();
		assert_eq!(reads.get(), 2);
		// A cancelled read reaches the caller, and the next call reads again.
		let later = start + KEYMAP_TTL * 2;
		let cancelled = cached(&slot, later, || Err(DesktopError::cancelled("cancelled")));
		assert_eq!(cancelled.err().map(|error| error.code), Some(ErrorCode::Cancelled));
		cached(&slot, later, read).unwrap();
		assert_eq!(reads.get(), 3);
	}
}
