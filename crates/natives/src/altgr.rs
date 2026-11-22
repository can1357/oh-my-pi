//! Recover `AltGr` text that Windows console hosts drop under the kitty
//! keyboard protocol.
//!
//! The kitty encoder shipped in Windows Terminal / `OpenConsole` before
//! microsoft/terminal#20052 reports AltGr+key as Alt (or Ctrl+Alt) plus the
//! layout's *unmodified* base key, without the produced text: Hungarian
//! AltGr+F arrives as `CSI 102;3u` instead of `[`. The byte stream is then
//! indistinguishable from a real Alt+F shortcut, so the character is lost and
//! the chord fires `alt+f` bindings instead.
//!
//! Recovery reads two pieces of local state the bytes lack:
//!  - whether Right Alt (`AltGr`) is physically held, via `GetAsyncKeyState`;
//!  - what the active keyboard layout's `AltGr` layer produces for the base
//!    key, via `ToUnicodeEx`.
//!
//! Layouts without an `AltGr` layer (US, UK, ...) resolve to an empty table
//! once and short-circuit every later event. The per-layout table is built once
//! and cached; it is rebuilt only when the foreground window reports a
//! different layout handle.
//!
//! Known limitation: `AltGr` keys that produce a dead key on the active layout
//! have no table entry (`ToUnicodeEx` reports them as pending composition, not
//! text), so those chords keep reaching Alt bindings.

use napi_derive::napi;

/// Translate a kitty CSI-u Alt/Ctrl+Alt chord into the text `AltGr` produced
/// on the active keyboard layout; `null` when the sequence is not an `AltGr`
/// keystroke there, and always off Windows.
///
/// Only meaningful on native Windows `ConPTY` hosts with the kitty protocol
/// active: other hosts report the produced text themselves.
#[napi(js_name = "translateWindowsAltGrSequence")]
pub fn translate_windows_altgr_sequence(data: String) -> Option<String> {
	#[cfg(windows)]
	{
		win32::translate_live(&data)
	}
	#[cfg(not(windows))]
	{
		drop(data);
		None
	}
}

/// The chord decoder, apart from the desktop it reads.
#[cfg(any(windows, test))]
mod chord {
	use std::{
		collections::HashMap,
		time::{Duration, Instant},
	};

	use crate::keys::parse_kitty_sequence_bytes;

	const KITTY_MOD_SHIFT: u32 = 1;
	const KITTY_MOD_ALT: u32 = 2;
	const KITTY_MOD_CTRL: u32 = 4;
	const KITTY_LOCK_MASK: u32 = 64 | 128;
	/// Kitty event type of a key release.
	const KITTY_EVENT_RELEASE: u32 = 3;

	/// How long an observed Right Alt press keeps counting as held. Key state
	/// is sampled at processing time, and one stdin read can carry several
	/// queued `AltGr` repeats that are dispatched synchronously after the key
	/// is released; the latch keeps that tail typing text. Far shorter than any
	/// release-then-Left-Alt chord a person can press.
	pub(super) const RIGHT_ALT_LATCH: Duration = Duration::from_millis(30);

	/// `AltGr` layer of one keyboard layout: `(base codepoint, shift)` →
	/// produced text. Keys are the lowercased unmodified character of each
	/// virtual key — the same "base key" the kitty encoder reports.
	pub(super) type AltGrLayer = HashMap<(u32, bool), String>;

	/// Local keyboard state the translator reads; a trait so tests need no live
	/// desktop.
	pub(super) trait AltGrHost {
		/// `AltGr` layer of the layout that produced the keystroke.
		fn active_layer(&mut self) -> &AltGrLayer;
		/// Whether Right Alt (`AltGr`) is held, or was within the last
		/// [`RIGHT_ALT_LATCH`].
		fn is_right_alt_down(&mut self, now: Instant) -> bool;
	}

	/// Keeps an observed Right Alt press counting as held for
	/// [`RIGHT_ALT_LATCH`].
	#[derive(Clone, Copy, Debug, Default)]
	pub(super) struct RightAltLatch {
		last_seen_down: Option<Instant>,
	}

	impl RightAltLatch {
		/// Record the raw key state sampled at `now`; returns the latched state.
		pub(super) fn observe(&mut self, down_now: bool, now: Instant) -> bool {
			if down_now {
				self.last_seen_down = Some(now);
				return true;
			}
			self
				.last_seen_down
				.is_some_and(|seen| now.saturating_duration_since(seen) <= RIGHT_ALT_LATCH)
		}
	}

	/// Translate a kitty CSI-u Alt/Ctrl+Alt chord into the text `AltGr`
	/// produced on `host`'s layout, or `None` when it is not an `AltGr`
	/// keystroke there.
	pub(super) fn translate(data: &str, now: Instant, host: &mut impl AltGrHost) -> Option<String> {
		if !data.ends_with('u') {
			return None;
		}
		let parsed = parse_kitty_sequence_bytes(data.as_bytes())?;
		if parsed.event_type == Some(KITTY_EVENT_RELEASE) {
			return None;
		}
		let modifier = parsed.modifier & !KITTY_LOCK_MASK;
		// AltGr surfaces as Alt (fake LeftCtrl filtered) or Ctrl+Alt, optionally
		// with Shift.
		if modifier & KITTY_MOD_ALT == 0
			|| modifier & !(KITTY_MOD_ALT | KITTY_MOD_CTRL | KITTY_MOD_SHIFT) != 0
		{
			return None;
		}
		// Functional keys (kitty PUA range) and C0 controls never carry AltGr
		// text.
		if parsed.codepoint < 0x20 || (0xe000..=0xf8ff).contains(&parsed.codepoint) {
			return None;
		}
		// Table keys are lowercased base characters; normalize hosts that report
		// uppercase.
		let base = char::from_u32(u32::try_from(parsed.codepoint).ok()?)?
			.to_lowercase()
			.next()?;
		// Layouts without an AltGr layer (US, UK, ...) stop here: Alt chords stay
		// shortcuts.
		let text = host
			.active_layer()
			.get(&(u32::from(base), modifier & KITTY_MOD_SHIFT != 0))?
			.clone();
		// Left Alt+key shares the exact bytes; only a held Right Alt means AltGr.
		host.is_right_alt_down(now).then_some(text)
	}
}

#[cfg(windows)]
mod win32 {
	use std::{ptr, sync::LazyLock, time::Instant};

	use parking_lot::Mutex;
	use windows_sys::Win32::UI::{
		Input::KeyboardAndMouse::{
			GetAsyncKeyState, GetKeyboardLayout, HKL, MapVirtualKeyExW, ToUnicodeEx,
		},
		WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
	};

	use super::chord::{AltGrHost, AltGrLayer, RightAltLatch, translate};

	const VK_SHIFT: u32 = 0x10;
	const VK_CONTROL: u32 = 0x11;
	const VK_MENU: u32 = 0x12;
	const VK_LSHIFT: u32 = 0xa0;
	const VK_LCONTROL: u32 = 0xa2;
	const VK_RMENU: u32 = 0xa5;
	const MAPVK_VK_TO_VSC: u32 = 0;
	/// `ToUnicodeEx` flag: do not change the kernel keyboard state (keeps
	/// pending dead keys intact).
	const TOUNICODE_NO_STATE_CHANGE: u32 = 0x4;

	const ALT_GR: &[u32] = &[VK_CONTROL, VK_LCONTROL, VK_MENU, VK_RMENU];
	const ALT_GR_SHIFT: &[u32] = &[VK_CONTROL, VK_LCONTROL, VK_MENU, VK_RMENU, VK_SHIFT, VK_LSHIFT];

	/// The live desktop, with the layer and latch every call shares.
	static HOST: LazyLock<Mutex<Win32AltGrHost>> = LazyLock::new(Mutex::default);

	/// [`translate`] against the live desktop.
	pub(super) fn translate_live(data: &str) -> Option<String> {
		translate(data, Instant::now(), &mut *HOST.lock())
	}

	fn is_printable_text(text: &str) -> bool {
		!text.is_empty()
			&& text.chars().all(|scalar| {
				!(scalar < ' ' || scalar == '\x7f' || ('\u{80}'..='\u{9f}').contains(&scalar))
			})
	}

	/// Text `vk` produces on layout `hkl` with exactly `modifiers` held.
	fn translate_key(vk: u32, scan: u32, modifiers: &[u32], hkl: HKL) -> Option<String> {
		let mut key_state = [0u8; 256];
		for &modifier in modifiers {
			key_state[modifier as usize] = 0x80;
		}
		let mut buffer = [0u16; 8];
		// SAFETY: `key_state` is the 256-byte array `ToUnicodeEx` reads,
		// `buffer` is writable for the code units passed alongside it, and both
		// outlive the call.
		let count = unsafe {
			ToUnicodeEx(
				vk,
				scan,
				key_state.as_ptr(),
				buffer.as_mut_ptr(),
				i32::try_from(buffer.len()).unwrap_or(i32::MAX),
				TOUNICODE_NO_STATE_CHANGE,
				hkl,
			)
		};
		// Negative = dead key; zero = no translation.
		let count = usize::try_from(count).ok().filter(|&count| count > 0)?;
		let text = String::from_utf16_lossy(buffer.get(..count)?);
		is_printable_text(&text).then_some(text)
	}

	/// Enumerate the layout's `AltGr` layer. Keys are the lowercased unmodified
	/// character of each virtual key — the same "base key" the kitty encoder
	/// reports.
	pub(super) fn build_altgr_layer(hkl: HKL) -> AltGrLayer {
		let mut layer = AltGrLayer::new();
		for vk in 0x20..=0xfe_u32 {
			// Skip Windows/menu keys and the sided modifiers: they have no text
			// layer.
			if (0x5b..=0x5f).contains(&vk) || (VK_LSHIFT..=VK_RMENU).contains(&vk) {
				continue;
			}
			// SAFETY: plain value arguments; `hkl` is a layout handle the system
			// returned.
			let scan = unsafe { MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, hkl) };
			if scan == 0 {
				continue;
			}
			let Some(base) = translate_key(vk, scan, &[], hkl)
				.and_then(|base| base.chars().next())
				.and_then(|first| first.to_lowercase().next())
			else {
				continue;
			};
			for shift in [false, true] {
				let key = (u32::from(base), shift);
				if layer.contains_key(&key) {
					continue;
				}
				let modifiers = if shift { ALT_GR_SHIFT } else { ALT_GR };
				if let Some(produced) = translate_key(vk, scan, modifiers, hkl) {
					layer.insert(key, produced);
				}
			}
		}
		layer
	}

	/// The live desktop: the foreground window's layout plus the Right Alt key
	/// state.
	#[derive(Default)]
	struct Win32AltGrHost {
		/// Layout handle (`HKL` address) the cached layer was built for.
		layout: Option<usize>,
		layer:  AltGrLayer,
		latch:  RightAltLatch,
	}

	impl AltGrHost for Win32AltGrHost {
		fn active_layer(&mut self) -> &AltGrLayer {
			// The console process has no window of its own; the layout that
			// produced the keystroke belongs to the terminal window that currently
			// holds focus.
			// SAFETY: these calls take no pointers besides the optional process-id
			// out parameter, which may be null.
			let hkl = unsafe {
				let window = GetForegroundWindow();
				let thread = if window.is_null() {
					0
				} else {
					GetWindowThreadProcessId(window, ptr::null_mut())
				};
				GetKeyboardLayout(thread)
			};
			let layout = hkl.addr();
			if self.layout != Some(layout) {
				self.layer = if hkl.is_null() {
					AltGrLayer::new()
				} else {
					build_altgr_layer(hkl)
				};
				self.layout = Some(layout);
			}
			&self.layer
		}

		fn is_right_alt_down(&mut self, now: Instant) -> bool {
			// SAFETY: `GetAsyncKeyState` takes a virtual-key code by value.
			let state = unsafe { GetAsyncKeyState(VK_RMENU.cast_signed()) };
			// The most significant bit is set while the key is down.
			self.latch.observe(state < 0, now)
		}
	}
}

#[cfg(test)]
mod tests {
	use std::time::{Duration, Instant};

	use super::chord::{AltGrHost, AltGrLayer, RIGHT_ALT_LATCH, RightAltLatch, translate};

	struct FakeHost {
		layer:          AltGrLayer,
		right_alt_down: bool,
	}

	impl AltGrHost for FakeHost {
		fn active_layer(&mut self) -> &AltGrLayer {
			&self.layer
		}

		fn is_right_alt_down(&mut self, _now: Instant) -> bool {
			self.right_alt_down
		}
	}

	/// Hungarian `AltGr` layer subset, keyed by the base key as the kitty
	/// encoder reports it.
	fn hungarian_layer() -> AltGrLayer {
		[('f', "["), ('g', "]"), ('b', "{"), ('n', "}"), ('q', "\\")]
			.into_iter()
			.map(|(base, text)| ((u32::from(base), false), text.to_owned()))
			.collect()
	}

	fn translated(data: &str, layer: AltGrLayer, right_alt_down: bool) -> Option<String> {
		translate(data, Instant::now(), &mut FakeHost { layer, right_alt_down })
	}

	fn alt_gr(data: &str) -> Option<String> {
		translated(data, hungarian_layer(), true)
	}

	#[test]
	fn recovers_altgr_text_that_the_console_host_reported_as_an_alt_or_ctrl_alt_chord() {
		assert_eq!(alt_gr("\x1b[102;3u").as_deref(), Some("["));
		assert_eq!(alt_gr("\x1b[103;7u").as_deref(), Some("]"));
		assert_eq!(alt_gr("\x1b[98;3u").as_deref(), Some("{"));
		assert_eq!(alt_gr("\x1b[110;3u").as_deref(), Some("}"));
		// Caps/Num Lock bits do not hide the chord.
		assert_eq!(alt_gr("\x1b[102;131u").as_deref(), Some("["));
		// Hosts that report the base key uppercase (Caps Lock) still hit the
		// lowercased table.
		assert_eq!(alt_gr("\x1b[70;3u").as_deref(), Some("["));
	}

	#[test]
	fn keeps_left_alt_chords_as_shortcuts_when_right_alt_is_not_held() {
		assert_eq!(translated("\x1b[102;3u", hungarian_layer(), false), None);
	}

	#[test]
	fn keeps_alt_chords_as_shortcuts_on_layouts_without_an_altgr_layer() {
		assert_eq!(translated("\x1b[102;3u", AltGrLayer::new(), true), None);
	}

	#[test]
	fn ignores_keys_modifiers_and_events_that_never_carry_altgr_text() {
		assert_eq!(alt_gr("\x1b[104;3u"), None); // h: no AltGr mapping
		assert_eq!(alt_gr("\x1b[102;5u"), None); // Ctrl only
		assert_eq!(alt_gr("\x1b[102;11u"), None); // Super+Alt
		assert_eq!(alt_gr("\x1b[102;3:3u"), None); // release
		assert_eq!(alt_gr("\x1b[102;4u"), None); // Shift layer unmapped here
		assert_eq!(alt_gr("\x1b[1;3A"), None); // Alt+Up
	}

	#[test]
	fn latch_keeps_a_just_released_right_alt_observed_through_a_batch() {
		let mut latch = RightAltLatch::default();
		let pressed = Instant::now();
		assert!(latch.observe(true, pressed));
		// Key released while queued repeats from the same stdin read are still
		// being dispatched.
		let released = pressed + Duration::from_millis(1);
		assert!(latch.observe(false, released));
		assert!(!latch.observe(false, released + RIGHT_ALT_LATCH));
	}

	#[test]
	fn latch_never_reports_a_right_alt_press_it_has_not_observed() {
		assert!(!RightAltLatch::default().observe(false, Instant::now()));
	}

	#[cfg(windows)]
	mod layouts {
		use windows_sys::Win32::UI::Input::KeyboardAndMouse::{HKL, LoadKeyboardLayoutW};

		use super::super::win32::build_altgr_layer;

		/// `KLF_NOTELLSHELL`: load without announcing the layout to the shell.
		const KLF_NOTELLSHELL: u32 = 0x80;

		fn load(klid: &str) -> HKL {
			let name: Vec<u16> = klid.encode_utf16().chain([0]).collect();
			// SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the
			// call.
			let hkl = unsafe { LoadKeyboardLayoutW(name.as_ptr(), KLF_NOTELLSHELL) };
			assert!(!hkl.is_null(), "keyboard layout {klid} unavailable");
			hkl
		}

		#[test]
		fn maps_the_hungarian_altgr_layer_by_base_key() {
			let layer = build_altgr_layer(load("0000040E"));
			let produced = |base: char| layer.get(&(u32::from(base), false)).map(String::as_str);
			assert_eq!(produced('f'), Some("["));
			assert_eq!(produced('g'), Some("]"));
			assert_eq!(produced('b'), Some("{"));
			assert_eq!(produced('n'), Some("}"));
		}

		#[test]
		fn reports_an_empty_layer_for_us_english() {
			assert!(build_altgr_layer(load("00000409")).is_empty());
		}
	}
}
