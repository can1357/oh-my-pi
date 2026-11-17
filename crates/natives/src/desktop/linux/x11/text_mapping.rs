//! Session-owned scratch keycodes. Clients may translate queued keys long after
//! the sending request completes, so an idle binding stays live until eviction.
use std::{
	cell::Cell,
	collections::HashSet,
	sync::Arc,
	time::{Duration, Instant},
};

use x11rb::{
	protocol::{xinput::ConnectionExt as _, xproto::ConnectionExt as _},
	rust_connection::RustConnection,
};

use super::keymap::{Keymap, keysym_for_key};
use crate::desktop::{
	control,
	error::{CoreResult, DesktopError},
	keys::KeyName,
};

const REBIND_GRACE: Duration = Duration::from_millis(500);

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
	conn:                     Arc<RustConnection>,
	bound:                    Vec<Binding>,
	targets:                  Vec<MapTarget>,
	presses:                  Cell<u64>,
	/// While set, `bind` fails its keymap writes as a server rejecting them.
	#[cfg(test)]
	pub(super) reject_writes: bool,
}

impl TextMapping {
	pub(super) const fn new(conn: Arc<RustConnection>) -> Self {
		Self {
			conn,
			bound: Vec::new(),
			targets: Vec::new(),
			presses: Cell::new(0),
			#[cfg(test)]
			reject_writes: false,
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

	/// Chords and holds use only the user's layout, not our cached text rows.
	pub(super) fn hide(&self, map: &mut Keymap) {
		for binding in &self.bound {
			if binding.owns(map) {
				let width = usize::from(map.keysyms_per_keycode);
				let start = usize::from(binding.code - map.min_keycode) * width;
				map.keysyms[start..start + width].fill(0);
			}
		}
	}

	fn snapshots(&self, template: &Keymap) -> CoreResult<(Keymap, Option<Keymap>)> {
		let source = template.refresh(&self.conn)?;
		let other = if source.core_mapping && source.device.is_some() {
			Some(Keymap::core(&self.conn)?)
		} else if let Some(master) = source.master {
			Some(Keymap::device(&self.conn, master.into())?)
		} else {
			None
		};
		Ok((source, other))
	}

	fn available(&self, map: &Keymap, other: Option<&Keymap>) -> Vec<u8> {
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
				};
				(usable(map)
					&& map.modifier_mask(code) == 0
					&& other.is_none_or(|map| usable(map) && map.modifier_mask(code) == 0))
				.then_some(code)
			})
			.collect()
	}

	/// Keysyms the layout types on its own rows' first two levels; our rows
	/// do not count.
	fn natives(&self, map: &Keymap) -> HashSet<u32> {
		let width = usize::from(map.keysyms_per_keycode);
		if width == 0 {
			return HashSet::new();
		}
		map.keysyms
			.chunks_exact(width)
			.enumerate()
			.filter(|&(index, _)| {
				let code = usize::from(map.min_keycode) + index;
				!self
					.bound
					.iter()
					.any(|binding| usize::from(binding.code) == code && binding.owns(map))
			})
			.flat_map(|(_, row)| row.iter().take(2).copied())
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
			let available = self.available(&fresh, other.as_ref());
			let natives = self.natives(&fresh);
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
				self.targets.push(MapTarget {
					device: None,
					width:  other
						.as_ref()
						.map_or(fresh.keysyms_per_keycode, |map| map.keysyms_per_keycode),
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
			// Register before writing, and confirm only after: a rejected or
			// partial write can leave the row with the old keysym or the new.
			for &(code, symbol) in &writes {
				if let Some(binding) = self.bound.iter_mut().find(|binding| binding.code == code) {
					binding.attempted.push(symbol);
					binding.last_key.set(None);
				} else {
					self.bound.push(Binding {
						code,
						symbol: 0,
						attempted: vec![symbol],
						last_key: Cell::new(None),
					});
				}
			}
			let mut writes = writes;
			writes.sort_unstable_by_key(|&(code, _)| code);
			let mut buffer = Vec::new();
			for &target in &self.targets {
				#[cfg(test)]
				if self.reject_writes {
					return Err(failed("the test rejected this write"));
				}
				write_rows(&conn, target, &writes, &mut buffer)?;
			}
			let applied = if writes.is_empty() {
				fresh
			} else {
				fresh.refresh(&conn)?
			};
			if required
				.iter()
				.any(|&symbol| applied.lookup(symbol).is_none())
			{
				return Err(DesktopError::input_failed(
					"X11 device did not adopt the temporary text mapping; no input was sent",
				));
			}
			for &(code, symbol) in &writes {
				if let Some(binding) = self.bound.iter_mut().find(|binding| binding.code == code) {
					binding.symbol = symbol;
					binding.attempted.clear();
				}
			}
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
			let mut buffer = Vec::new();
			let mut failure = None;
			for &target in &self.targets {
				let map = match target.device {
					Some(device) => Keymap::device(&self.conn, device.into()),
					None => Keymap::core(&self.conn),
				};
				let result = map.and_then(|map| {
					let mut clear: Vec<_> = bound
						.iter()
						.filter(|binding| binding.owns(&map))
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
}
