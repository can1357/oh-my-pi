//! Session-owned scratch keycodes. Clients may translate queued keys long after
//! the sending request completes, so an idle binding stays live until eviction.
use std::{
	cell::Cell,
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
	code:     u8,
	symbol:   u32,
	last_key: Cell<Option<Instant>>,
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
}

impl TextMapping {
	pub(super) const fn new(conn: Arc<RustConnection>) -> Self {
		Self { conn, bound: Vec::new(), targets: Vec::new(), presses: Cell::new(0) }
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
			if row_matches(map, binding.code, binding.symbol) {
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
							.any(|binding| binding.code == code && row_matches(map, code, binding.symbol))
				};
				(usable(map)
					&& map.modifier_mask(code) == 0
					&& other.is_none_or(|map| usable(map) && map.modifier_mask(code) == 0))
				.then_some(code)
			})
			.collect()
	}

	fn native(&self, map: &Keymap, symbol: u32) -> bool {
		let width = usize::from(map.keysyms_per_keycode);
		width != 0
			&& map
				.keysyms
				.chunks_exact(width)
				.enumerate()
				.any(|(index, row)| {
					let code = usize::from(map.min_keycode) + index;
					row.iter().take(2).any(|&candidate| candidate == symbol)
						&& !self.bound.iter().any(|binding| {
							usize::from(binding.code) == code
								&& row_matches(map, binding.code, binding.symbol)
						})
				})
	}

	pub(super) fn plan<'a>(&self, map: &mut Keymap, text: &'a str) -> CoreResult<Vec<&'a str>> {
		let conn = Arc::clone(&self.conn);
		let _grab = ServerGrab::new(&conn)?;
		let (fresh, other) = self.snapshots(map)?;
		let capacity = self.available(&fresh, other.as_ref()).len();
		let result = segments(text, capacity, |symbol| !self.native(&fresh, symbol));
		*map = fresh;
		result
	}

	/// Wait outside `GrabServer`: the target must be able to consume old keys.
	pub(super) fn bind(&mut self, map: &mut Keymap, text: &str) -> CoreResult<()> {
		loop {
			control::check()?;
			let conn = Arc::clone(&self.conn);
			let grab = ServerGrab::new(&conn)?;
			let (fresh, other) = self.snapshots(map)?;
			let available = self.available(&fresh, other.as_ref());
			let required = symbols(text, |symbol| !self.native(&fresh, symbol));
			if required.len() > available.len() {
				return Err(no_rows(required.len(), available.len()));
			}
			let writes = assignments(&required, &available, &self.bound);
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
			// Register before writing: a failed round trip may have changed X.
			for &(code, symbol) in &writes {
				if let Some(binding) = self.bound.iter_mut().find(|binding| binding.code == code) {
					binding.symbol = symbol;
					binding.last_key.set(None);
				} else {
					self
						.bound
						.push(Binding { code, symbol, last_key: Cell::new(None) });
				}
			}
			let mut writes = writes;
			writes.sort_unstable_by_key(|&(code, _)| code);
			let mut buffer = Vec::new();
			for &target in &self.targets {
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
					"X11 device did not adopt the temporary text mapping; no further input was sent",
				));
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
						.filter(|binding| row_matches(&map, binding.code, binding.symbol))
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

fn symbols(text: &str, mut dynamic: impl FnMut(u32) -> bool) -> Vec<u32> {
	let mut result = Vec::new();
	for ch in text.chars() {
		let symbol = keysym_for_key(KeyName::Char(ch));
		if dynamic(symbol) && !result.contains(&symbol) {
			result.push(symbol);
		}
	}
	result
}

fn segments(
	text: &str,
	capacity: usize,
	mut dynamic: impl FnMut(u32) -> bool,
) -> CoreResult<Vec<&str>> {
	let mut result = Vec::new();
	let mut required = Vec::new();
	let mut start = 0;
	for (index, ch) in text.char_indices() {
		control::check()?;
		let symbol = keysym_for_key(KeyName::Char(ch));
		if dynamic(symbol) && !required.contains(&symbol) {
			if capacity == 0 {
				return Err(no_rows(1, 0));
			}
			if required.len() == capacity {
				result.push(&text[start..index]);
				start = index;
				required.clear();
			}
			required.push(symbol);
		}
	}
	if start < text.len() {
		result.push(&text[start..]);
	}
	Ok(result)
}

fn assignments(required: &[u32], available: &[u8], bound: &[Binding]) -> Vec<(u8, u32)> {
	let mut result = Vec::new();
	let protected: Vec<_> = required
		.iter()
		.filter_map(|symbol| {
			bound
				.iter()
				.find(|binding| binding.symbol == *symbol && available.contains(&binding.code))
				.map(|binding| binding.code)
		})
		.collect();
	for &symbol in required {
		if bound
			.iter()
			.any(|binding| binding.symbol == symbol && available.contains(&binding.code))
		{
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
		"X11 text needs {needed} spare keycodes but only {available} empty rows are available; no \
		 further input was sent. If a killed input tool left temporary mappings, reset the layout \
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
	fn segmentation_preserves_text_and_eviction_keeps_current_symbols() {
		let text = "αβαγδ";
		assert_eq!(segments(text, 2, |_| true).unwrap(), ["αβα", "γδ"]);
		let start = Instant::now();
		let bound = [
			Binding { code: 255, symbol: 1, last_key: Cell::new(Some(start)) },
			Binding {
				code:     254,
				symbol:   2,
				last_key: Cell::new(Some(start + Duration::from_secs(1))),
			},
			Binding {
				code:     253,
				symbol:   3,
				last_key: Cell::new(Some(start + Duration::from_secs(2))),
			},
		];
		assert_eq!(assignments(&[1, 4], &[255, 254, 253], &bound), [(254, 4)]);
	}

	#[test]
	fn no_empty_rows_refuses_before_a_segment_is_emitted() {
		let error = segments("é", 0, |_| true).unwrap_err();
		assert!(error.message.contains("only 0"));
		assert!(error.message.contains("setxkbmap"));
	}
}
