//! Session-owned scratch keycodes. Clients may translate queued keys long after
//! the sending request completes, so an idle binding stays live until eviction.
//! Each mapping marks its rows on the root window, so other sessions on the
//! display neither type through them nor take them while their owner lives.
use std::{
	cell::Cell,
	collections::HashSet,
	sync::Arc,
	time::{Duration, Instant},
};

use x11rb::{
	connection::Connection as _,
	errors::ReplyError,
	protocol::{
		xinput::ConnectionExt as _,
		xproto::{AtomEnum, ConnectionExt as _, CreateWindowAux, PropMode, WindowClass},
	},
	rust_connection::RustConnection,
	wrapper::ConnectionExt as _,
};

use super::keymap::{Keymap, keysym_for_key};
use crate::desktop::{
	control,
	error::{CoreResult, DesktopError},
	keys::KeyName,
};

const REBIND_GRACE: Duration = Duration::from_millis(500);
/// Root window property listing the core keymap rows every mapping bound as
/// CARDINAL triples (owner window, keycode, keysym); the owner window lives
/// as long as the owner's X connection. MPX device maps are their pair's own
/// and are not marked.
const MARKS: &[u8] = b"_OMP_TEXT_KEYCODES";
/// Marks read at most; any after these are ignored.
const MAX_MARKS: u32 = 1024;

/// A row another text mapping bound; stale once its owner window is gone.
#[derive(Clone, Copy)]
struct Mark {
	owner:  u32,
	code:   u8,
	symbol: u32,
	live:   bool,
}

struct Binding {
	code:      u8,
	/// The keysym a confirmed write left in the row; 0 before the first.
	symbol:    u32,
	/// Keysyms written but not confirmed: until one is, the row may hold any
	/// of them or `symbol`, and all count as ours.
	attempted: Vec<u32>,
	last_key:  Cell<Option<Instant>>,
}

impl Binding {
	/// Whether `map` shows this row holding a keysym we wrote.
	fn owns(&self, map: &Keymap) -> bool {
		(self.symbol != 0 && row_matches(map, self.code, self.symbol))
			|| self
				.attempted
				.iter()
				.any(|&symbol| row_matches(map, self.code, symbol))
	}

	/// Whether the row is confirmed to type `symbol`.
	const fn holds(&self, symbol: u32) -> bool {
		self.attempted.is_empty() && self.symbol == symbol
	}
}

#[derive(Clone, Copy)]
struct MapTarget {
	device: Option<u8>,
	width:  u8,
}

pub(super) struct TextMapping {
	conn:    Arc<RustConnection>,
	bound:   Vec<Binding>,
	targets: Vec<MapTarget>,
	presses: Cell<u64>,
	/// The `MARKS` atom, 0 until interned.
	atom:    Cell<u32>,
	/// The window naming this mapping in its marks, created on first bind.
	window:  Option<u32>,
}

impl TextMapping {
	pub(super) const fn new(conn: Arc<RustConnection>) -> Self {
		Self {
			conn,
			bound: Vec::new(),
			targets: Vec::new(),
			presses: Cell::new(0),
			atom: Cell::new(0),
			window: None,
		}
	}

	pub(super) const fn presses(&self) -> u64 {
		self.presses.get()
	}

	pub(super) fn pressed(&self, code: u8) {
		self.presses.set(self.presses.get().wrapping_add(1));
		if let Some(binding) = self.bound.iter().find(|binding| binding.code == code) {
			binding.last_key.set(Some(Instant::now()));
		}
	}

	/// Chords and holds use only the user's layout, not our cached text rows
	/// or another session's. Rereads `map` with the marks under one grab, so
	/// a row bound or released between the two reads is not misread.
	pub(super) fn hide(&self, map: &mut Keymap) -> CoreResult<()> {
		if !map.core_mapping {
			self.hide_rows(map, &[], true);
			return Ok(());
		}
		let _grab = ServerGrab::new(&self.conn)?;
		let (fresh, other) = self.snapshots(map)?;
		let marks = self.marks()?;
		refuse_split(&fresh, other.as_ref(), &marks)?;
		*map = fresh;
		self.hide_rows(map, &marks, true);
		Ok(())
	}

	/// Clears the rows that `marks` match in `map`, and with `own` this
	/// mapping's rows. Without `own` a row we hold stays: `bind` dropped the
	/// rows live owners claim, so a mark on one of ours is dead or obsolete.
	fn hide_rows(&self, map: &mut Keymap, marks: &[Mark], own: bool) {
		let ours: Vec<u8> = self
			.bound
			.iter()
			.filter(|binding| binding.owns(map))
			.map(|binding| binding.code)
			.collect();
		let mut codes: Vec<u8> = marks
			.iter()
			.filter(|mark| {
				row_matches(map, mark.code, mark.symbol) && (own || !ours.contains(&mark.code))
			})
			.map(|mark| mark.code)
			.collect();
		if own {
			codes.extend(ours);
		}
		let width = usize::from(map.keysyms_per_keycode);
		for code in codes {
			let start = usize::from(code - map.min_keycode) * width;
			map.keysyms[start..start + width].fill(0);
		}
	}

	fn atom(&self) -> CoreResult<u32> {
		if self.atom.get() == 0 {
			let reply = self
				.conn
				.intern_atom(false, MARKS)
				.map_err(failed)?
				.reply()
				.map_err(failed)?;
			self.atom.set(reply.atom);
		}
		Ok(self.atom.get())
	}

	/// Other mappings' marks, each owner window asked whether it still exists.
	fn marks(&self) -> CoreResult<Vec<Mark>> {
		let reply = self
			.conn
			.get_property(false, root(&self.conn), self.atom()?, AtomEnum::CARDINAL, 0, MAX_MARKS * 3)
			.map_err(failed)?
			.reply()
			.map_err(failed)?;
		let values: Vec<u32> = reply.value32().into_iter().flatten().collect();
		let mut marks: Vec<Mark> = values
			.as_chunks::<3>()
			.0
			.iter()
			.filter(|&&[owner, ..]| Some(owner) != self.window)
			.filter_map(|&[owner, code, symbol]| {
				Some(Mark { owner, code: u8::try_from(code).ok()?, symbol, live: true })
			})
			.collect();
		let mut owners: Vec<u32> = marks.iter().map(|mark| mark.owner).collect();
		owners.sort_unstable();
		owners.dedup();
		let cookies = owners
			.iter()
			.map(|&owner| self.conn.get_geometry(owner))
			.collect::<Result<Vec<_>, _>>()
			.map_err(failed)?;
		let mut dead = Vec::new();
		for (owner, cookie) in owners.into_iter().zip(cookies) {
			match cookie.reply() {
				Ok(_) => {},
				Err(ReplyError::X11Error(_)) => dead.push(owner),
				Err(error) => return Err(failed(error)),
			}
		}
		for mark in &mut marks {
			mark.live = !dead.contains(&mark.owner);
		}
		Ok(marks)
	}

	/// The unmapped window naming this mapping in its marks; the server
	/// destroys it with our connection, which makes the marks stale.
	fn window(&mut self) -> CoreResult<u32> {
		if let Some(window) = self.window {
			return Ok(window);
		}
		let window = self.conn.generate_id().map_err(failed)?;
		self
			.conn
			.create_window(
				0,
				window,
				root(&self.conn),
				0,
				0,
				1,
				1,
				0,
				WindowClass::INPUT_ONLY,
				0,
				&CreateWindowAux::new(),
			)
			.map_err(failed)?
			.check()
			.map_err(failed)?;
		Ok(*self.window.insert(window))
	}

	/// Replaces the marks with the live ones of other mappings and this
	/// mapping's rows under every keysym they may hold; ours come first, so a
	/// reader's `MAX_MARKS` cut drops another owner's before ours. Another
	/// owner's mark on a row in `taken` is dropped: that row was empty, ours
	/// or stale when we took it.
	fn publish(&self, window: u32, others: &[Mark], taken: &[(u8, u32)]) -> CoreResult<()> {
		let mut values = Vec::new();
		for binding in &self.bound {
			let held = (binding.symbol != 0).then_some(binding.symbol);
			for symbol in held.into_iter().chain(binding.attempted.iter().copied()) {
				values.extend([window, u32::from(binding.code), symbol]);
			}
		}
		for mark in others
			.iter()
			.filter(|mark| mark.live && !taken.iter().any(|&(code, _)| code == mark.code))
		{
			values.extend([mark.owner, u32::from(mark.code), mark.symbol]);
		}
		self
			.conn
			.change_property32(
				PropMode::REPLACE,
				root(&self.conn),
				self.atom()?,
				AtomEnum::CARDINAL,
				&values,
			)
			.map_err(failed)?
			.check()
			.map_err(failed)
	}

	/// The map `template` names, fresh, and the other map a write reaches: a
	/// core write also rewrites the `XTest` keyboard, whose map can differ
	/// from the core one after a device switch; an MPX keyboard's goes to its
	/// master.
	fn snapshots(&self, template: &Keymap) -> CoreResult<(Keymap, Option<Keymap>)> {
		let source = template.refresh(&self.conn)?;
		let other = if source.core_mapping && source.device.is_some() {
			Some(Keymap::core(&self.conn)?)
		} else if source.core_mapping {
			Some(Keymap::xtest(&self.conn)?)
		} else if let Some(master) = source.master {
			Some(Keymap::device(&self.conn, master.into())?)
		} else {
			None
		};
		Ok((source, other))
	}

	/// Rows this text may write: empty, ours, or holding a dead owner's mark.
	fn available(&self, map: &Keymap, other: Option<&Keymap>, marks: &[Mark]) -> Vec<u8> {
		let width = usize::from(map.keysyms_per_keycode);
		if width == 0 {
			return Vec::new();
		}
		map.keysyms
			.chunks_exact(width)
			.enumerate()
			.rev()
			.filter_map(|(index, _)| {
				let code = map.min_keycode.checked_add(u8::try_from(index).ok()?)?;
				let usable = |map: &Keymap| {
					map.empty_row(code)
						|| self
							.bound
							.iter()
							.any(|binding| binding.code == code && binding.owns(map))
						|| marks.iter().any(|mark| {
							!mark.live && mark.code == code && row_matches(map, code, mark.symbol)
						})
				};
				(usable(map)
					&& map.modifier_mask(code) == 0
					&& other.is_none_or(|map| usable(map) && map.modifier_mask(code) == 0))
				.then_some(code)
			})
			.collect()
	}

	/// Keysyms the layout types on its own rows' first two levels; rows a
	/// text mapping bound, ours or marked by another, do not count.
	fn natives(&self, map: &Keymap, marks: &[Mark]) -> HashSet<u32> {
		let mut layout = map.clone();
		self.hide_rows(&mut layout, marks, true);
		layout
			.keysyms
			.chunks_exact(usize::from(layout.keysyms_per_keycode).max(1))
			.flat_map(|row| row.iter().take(2).copied())
			.collect()
	}

	/// Binds every character of `text` outside the layout, or refuses the whole
	/// text before any key when they outnumber the spare rows: rebinding a row
	/// mid-text would make a receiver that reads late translate the earlier
	/// keys through the new keysym. Waits outside `GrabServer`, so the target
	/// can consume old keys; the text is read before the grab.
	pub(super) fn bind(&mut self, map: &mut Keymap, text: &str) -> CoreResult<()> {
		let symbols = symbols(text);
		loop {
			control::check()?;
			let conn = Arc::clone(&self.conn);
			let grab = ServerGrab::new(&conn)?;
			let (fresh, other) = self.snapshots(map)?;
			let marks = if fresh.core_mapping {
				self.marks()?
			} else {
				Vec::new()
			};
			// Only marked rows need both maps to agree: candidates must be free
			// in both, and a row of ours either map lost is bound again.
			refuse_split(&fresh, other.as_ref(), &marks)?;
			// A row of ours another session marked after a reload cleared it is
			// that session's now, so it is neither reused nor available as ours.
			self
				.bound
				.retain(|binding| !claimed(&marks, &fresh, binding.code));
			let available = self.available(&fresh, other.as_ref(), &marks);
			let natives = self.natives(&fresh, &marks);
			let required: Vec<u32> = symbols
				.iter()
				.copied()
				.filter(|symbol| !natives.contains(symbol))
				.collect();
			if required.len() > available.len() {
				return Err(no_rows(required.len(), available.len()));
			}
			// Another client (`setxkbmap`) may have cleared a row we bound.
			let current = |code, symbol| {
				row_matches(&fresh, code, symbol)
					&& other
						.as_ref()
						.is_none_or(|other| row_matches(other, code, symbol))
			};
			let writes = assignments(&required, &available, &self.bound, current);
			let until = writes
				.iter()
				.filter_map(|&(code, _)| {
					self
						.bound
						.iter()
						.find(|binding| binding.code == code)
						.and_then(|binding| binding.last_key.get())
				})
				.map(|last| last + REBIND_GRACE)
				.max();
			// Only a row an earlier call used can be this recent; the wait comes
			// before this text's first key, under the caller's input lease.
			if let Some(until) = until
				&& let Some(wait) = until.checked_duration_since(Instant::now())
			{
				drop(grab);
				control::wait(wait)?;
				continue;
			}
			self.targets.clear();
			if fresh.core_mapping {
				let core = if fresh.device.is_some() {
					other.as_ref()
				} else {
					Some(&fresh)
				};
				self.targets.push(MapTarget {
					device: None,
					width:  core.map_or(fresh.keysyms_per_keycode, |map| map.keysyms_per_keycode),
				});
			} else {
				self
					.targets
					.push(MapTarget { device: fresh.device, width: fresh.keysyms_per_keycode });
				if let Some(master) = fresh.master {
					self.targets.push(MapTarget {
						device: Some(master),
						width:  other.as_ref().expect("master map").keysyms_per_keycode,
					});
				}
			}
			register(&mut self.bound, &writes);
			let mut writes = writes;
			writes.sort_unstable_by_key(|&(code, _)| code);
			if fresh.core_mapping && !writes.is_empty() {
				// Marked before writing, so no session can see the row unmarked.
				let window = self.window()?;
				self.publish(window, &marks, &writes)?;
			}
			let mut buffer = Vec::new();
			for &target in &self.targets {
				write_rows(&conn, target, &writes, &mut buffer)?;
			}
			let mut applied = if writes.is_empty() {
				fresh
			} else {
				fresh.refresh(&conn)?
			};
			// The text types only through the layout's rows and ours.
			self.hide_rows(&mut applied, &marks, false);
			if required
				.iter()
				.any(|&symbol| applied.lookup(symbol).is_none())
			{
				return Err(DesktopError::input_failed(
					"X11 device did not adopt the temporary text mapping; no input was sent",
				));
			}
			confirm(&mut self.bound, &writes);
			*map = applied;
			return Ok(());
		}
	}

	/// Explicit close consumes ownership even on failure, so Drop cannot retry.
	pub(super) fn finish(&mut self) -> CoreResult<()> {
		let bound = std::mem::take(&mut self.bound);
		if bound.is_empty() {
			return Ok(());
		}
		if let Some(until) = bound
			.iter()
			.filter_map(|binding| binding.last_key.get())
			.map(|last| last + REBIND_GRACE)
			.max()
			&& let Some(wait) = until.checked_duration_since(Instant::now())
		{
			std::thread::sleep(wait);
		}
		let result = (|| {
			let _grab = ServerGrab::new(&self.conn)?;
			// A row a live owner marked is its row, even holding our keysym.
			let marks = if self.window.is_some() {
				self.marks()?
			} else {
				Vec::new()
			};
			let mut buffer = Vec::new();
			let mut failure = None;
			// A core write reaches the `XTest` keyboard too, so it clears only the
			// rows both maps show as ours; while only one does, our marks stay.
			let mut split = false;
			for &target in &self.targets {
				let maps = match target.device {
					Some(device) => Keymap::device(&self.conn, device.into()).map(|map| (map, None)),
					None => Keymap::core(&self.conn)
						.and_then(|core| Ok((core, Some(Keymap::xtest(&self.conn)?)))),
				};
				let result = maps.and_then(|(map, other)| {
					let mut clear: Vec<_> = bound
						.iter()
						.filter(|binding| {
							let both = other.as_ref().is_none_or(|other| binding.owns(other));
							split |= other.is_some() && binding.owns(&map) != both;
							both && binding.owns(&map) && !claimed(&marks, &map, binding.code)
						})
						.map(|binding| (binding.code, 0))
						.collect();
					clear.sort_unstable_by_key(|&(code, _)| code);
					write_rows(
						&self.conn,
						MapTarget { width: map.keysyms_per_keycode, ..target },
						&clear,
						&mut buffer,
					)
				});
				if let Err(error) = result {
					failure = Some(error);
				}
			}
			// Rows that may still hold our keysyms stay marked until our
			// connection closes.
			if failure.is_none()
				&& !split
				&& let Some(window) = self.window
			{
				failure = self.publish(window, &marks, &[]).err();
			}
			failure.map_or(Ok(()), Err)
		})();
		result.map_err(|error: DesktopError| {
			DesktopError::input_failed(format!(
				"{}failed to restore temporary X11 text keymap: {}",
				if self.presses.get() == 0 {
					""
				} else {
					"the text was sent; "
				},
				error.message
			))
		})
	}
}

impl Drop for TextMapping {
	fn drop(&mut self) {
		let _ = self.finish();
	}
}

/// Registers `writes` before they are sent: until [`confirm`], a rebound row
/// counts as ours under the keysym it held and the one being written, since a
/// rejected or partial write can leave either.
fn register(bound: &mut Vec<Binding>, writes: &[(u8, u32)]) {
	for &(code, symbol) in writes {
		if let Some(binding) = bound.iter_mut().find(|binding| binding.code == code) {
			binding.attempted.push(symbol);
			binding.last_key.set(None);
		} else {
			bound.push(Binding {
				code,
				symbol: 0,
				attempted: vec![symbol],
				last_key: Cell::new(None),
			});
		}
	}
}

fn confirm(bound: &mut [Binding], writes: &[(u8, u32)]) {
	for &(code, symbol) in writes {
		if let Some(binding) = bound.iter_mut().find(|binding| binding.code == code) {
			binding.symbol = symbol;
			binding.attempted.clear();
		}
	}
}

/// Every session's marks live on the first screen's root window: the
/// keyboard mapping is the display's, not a screen's.
fn root(conn: &RustConnection) -> u32 {
	conn.setup().roots[0].root
}

fn symbols(text: &str) -> Vec<u32> {
	let mut seen = HashSet::new();
	text
		.chars()
		.map(|ch| keysym_for_key(KeyName::Char(ch)))
		.filter(|&symbol| seen.insert(symbol))
		.collect()
}

/// Rows to write for `required`. A binding is reused only where `current`
/// shows its row still holding the keysym, so a row another client cleared
/// is written again.
fn assignments(
	required: &[u32],
	available: &[u8],
	bound: &[Binding],
	current: impl Fn(u8, u32) -> bool,
) -> Vec<(u8, u32)> {
	let reusable = |binding: &Binding, symbol| {
		binding.holds(symbol) && available.contains(&binding.code) && current(binding.code, symbol)
	};
	let mut result = Vec::new();
	let protected: Vec<_> = required
		.iter()
		.filter_map(|symbol| {
			bound
				.iter()
				.find(|binding| reusable(binding, *symbol))
				.map(|binding| binding.code)
		})
		.collect();
	for &symbol in required {
		if bound.iter().any(|binding| reusable(binding, symbol)) {
			continue;
		}
		let free = available.iter().copied().find(|code| {
			!bound.iter().any(|binding| binding.code == *code)
				&& !result.iter().any(|&(candidate, _)| candidate == *code)
		});
		let code = free
			.or_else(|| {
				bound
					.iter()
					.filter(|binding| {
						available.contains(&binding.code)
							&& !protected.contains(&binding.code)
							&& !result
								.iter()
								.any(|&(candidate, _)| candidate == binding.code)
					})
					.min_by_key(|binding| binding.last_key.get())
					.map(|binding| binding.code)
			})
			.expect("segment fits available rows");
		result.push((code, symbol));
	}
	result
}

fn no_rows(needed: usize, available: usize) -> DesktopError {
	DesktopError::input_failed(format!(
		"X11 text needs {needed} spare keycodes for characters outside the keyboard layout, but \
		 only {available} are free; no input was sent. Send at most {available} distinct such \
		 characters per call, or if a killed input tool left temporary mappings, reset the layout \
		 with setxkbmap and retry"
	))
}

/// Whether a live owner's mark shows `code` as its row in `map`: such a
/// claim beats our having bound the row earlier.
fn claimed(marks: &[Mark], map: &Keymap, code: u8) -> bool {
	marks
		.iter()
		.any(|mark| mark.live && mark.code == code && row_matches(map, code, mark.symbol))
}

/// Refuses, with nothing sent, while the core and `XTest` maps disagree on a
/// row another live session marked: a core write reaches both, and which one
/// a receiver reads follows the keyboard that typed last.
fn refuse_split(map: &Keymap, other: Option<&Keymap>, marks: &[Mark]) -> CoreResult<()> {
	let Some(other) = other else { return Ok(()) };
	let Some(mark) = marks.iter().find(|mark| {
		mark.live
			&& row_matches(map, mark.code, mark.symbol) != row_matches(other, mark.code, mark.symbol)
	}) else {
		return Ok(());
	};
	Err(DesktopError::input_failed(format!(
		"the core and XTest keymaps disagree on keycode {}, a row another omp session's text uses; \
		 no input was sent. Retry after the layout settles, or reload it with setxkbmap",
		mark.code
	)))
}

// XKB canonicalizes redundant levels to NoSymbol padding.
fn row_matches(map: &Keymap, code: u8, symbol: u32) -> bool {
	let width = usize::from(map.keysyms_per_keycode);
	code
		.checked_sub(map.min_keycode)
		.and_then(|index| {
			map.keysyms
				.get(usize::from(index) * width..(usize::from(index) + 1) * width)
		})
		.is_some_and(|row| {
			row.first() == Some(&symbol) && row.iter().all(|&value| value == 0 || value == symbol)
		})
}

struct ServerGrab<'a>(&'a RustConnection);
impl<'a> ServerGrab<'a> {
	fn new(conn: &'a RustConnection) -> CoreResult<Self> {
		conn
			.grab_server()
			.map_err(failed)?
			.check()
			.map_err(failed)?;
		Ok(Self(conn))
	}
}
impl Drop for ServerGrab<'_> {
	fn drop(&mut self) {
		if let Ok(cookie) = self.0.ungrab_server() {
			let _ = cookie.check();
		}
	}
}

fn write_rows(
	conn: &RustConnection,
	target: MapTarget,
	rows: &[(u8, u32)],
	buffer: &mut Vec<u32>,
) -> CoreResult<()> {
	let mut start = 0;
	while start < rows.len() {
		let mut end = start + 1;
		while end < rows.len() && rows[end - 1].0.checked_add(1) == Some(rows[end].0) {
			end += 1;
		}
		buffer.clear();
		for &(_, symbol) in &rows[start..end] {
			buffer.resize(buffer.len() + usize::from(target.width), symbol);
		}
		let count = u8::try_from(end - start).expect("keycode range fits u8");
		if let Some(device) = target.device {
			conn
				.xinput_change_device_key_mapping(device, rows[start].0, target.width, count, buffer)
				.map_err(failed)?
				.check()
				.map_err(failed)?;
		} else {
			conn
				.change_keyboard_mapping(count, rows[start].0, target.width, buffer)
				.map_err(failed)?
				.check()
				.map_err(failed)?;
		}
		start = end;
	}
	Ok(())
}

fn failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("X11 text mapping: {error}"))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn eviction_keeps_the_symbols_a_text_needs() {
		let start = Instant::now();
		let bound = [
			Binding {
				code:      255,
				symbol:    1,
				attempted: Vec::new(),
				last_key:  Cell::new(Some(start)),
			},
			Binding {
				code:      254,
				symbol:    2,
				attempted: Vec::new(),
				last_key:  Cell::new(Some(start + Duration::from_secs(1))),
			},
			Binding {
				code:      253,
				symbol:    3,
				attempted: Vec::new(),
				last_key:  Cell::new(Some(start + Duration::from_secs(2))),
			},
		];
		assert_eq!(assignments(&[1, 4], &[255, 254, 253], &bound, |_, _| true), [(254, 4)]);
	}

	#[test]
	fn a_rebound_row_is_ours_under_either_keysym_until_its_write_is_confirmed() {
		let (old, new) = (0xe9, 0xf6);
		let row = |symbol| Keymap::new(255, 2, vec![symbol, 0], Vec::new());
		let mut bound = vec![Binding {
			code:      255,
			symbol:    old,
			attempted: Vec::new(),
			last_key:  Cell::new(None),
		}];
		register(&mut bound, &[(255, new)]);
		// A rejected or partial write leaves either keysym; both are restored.
		assert!(bound[0].owns(&row(old)) && bound[0].owns(&row(new)));
		assert!(!bound[0].holds(new));
		confirm(&mut bound, &[(255, new)]);
		assert!(bound[0].holds(new) && !bound[0].owns(&row(old)));
	}
}
