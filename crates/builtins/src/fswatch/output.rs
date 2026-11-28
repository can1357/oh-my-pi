//! What `fswatch` prints: each monitor's event flags as fswatch lists them,
//! the path and event-type filters, and the record format.

use std::{io::Write as _, time::SystemTime};

use jiff::{
	Timestamp,
	fmt::strtime::{BrokenDownTime, Config, PosixCustom},
	tz::TimeZone,
};
use omp_xfs::watch::{Backend, Batch, Flags};
use regex::bytes::{Regex, RegexBuilder};
use smallvec::SmallVec;

use super::options::{EXIT_ERROR, Exit, FilterMode, FilterSpec, Options};
use crate::bre;

/// `fsw_event_flag` values.
const NO_OP: u16 = 0;
const PLATFORM_SPECIFIC: u16 = Flags::PLATFORM_SPECIFIC.bits() as u16;
const CREATED: u16 = Flags::CREATED.bits() as u16;
const UPDATED: u16 = Flags::UPDATED.bits() as u16;
const REMOVED: u16 = Flags::REMOVED.bits() as u16;
const RENAMED: u16 = Flags::RENAMED.bits() as u16;
const OWNER_MODIFIED: u16 = Flags::OWNER_MODIFIED.bits() as u16;
const ATTRIBUTE_MODIFIED: u16 = Flags::ATTRIBUTE_MODIFIED.bits() as u16;
const MOVED_FROM: u16 = Flags::MOVED_FROM.bits() as u16;
const MOVED_TO: u16 = Flags::MOVED_TO.bits() as u16;
const IS_FILE: u16 = Flags::IS_FILE.bits() as u16;
const IS_DIR: u16 = Flags::IS_DIR.bits() as u16;
const IS_SYMLINK: u16 = Flags::IS_SYMLINK.bits() as u16;
const LINK: u16 = Flags::LINK.bits() as u16;
const OVERFLOW: u16 = Flags::OVERFLOW.bits() as u16;
const CLOSE_WRITE: u16 = Flags::CLOSE_WRITE.bits() as u16;

/// One event's flags in the order fswatch prints them. A flag appears once
/// per system flag that maps to it, as it does in fswatch (and counts that
/// often in `--numeric`).
pub(super) type FlagList = SmallVec<[u16; 12]>;

/// `kFSEventStreamEventFlagRootChanged`: reported only to streams that watch
/// their roots, which fswatch's does not.
const FSEVENTS_ROOT_CHANGED: u32 = 0x20;

/// fswatch's FSEvents table: stream event flag, event flag.
const FSEVENTS: [(u32, u16); 25] = [
	(0x1, PLATFORM_SPECIFIC),           // MustScanSubDirs
	(0x2, PLATFORM_SPECIFIC),           // UserDropped
	(0x4, PLATFORM_SPECIFIC),           // KernelDropped
	(0x8, PLATFORM_SPECIFIC),           // EventIdsWrapped
	(0x10, PLATFORM_SPECIFIC),          // HistoryDone
	(0x20, PLATFORM_SPECIFIC),          // RootChanged
	(0x40, PLATFORM_SPECIFIC),          // Mount
	(0x80, PLATFORM_SPECIFIC),          // Unmount
	(0x4000, OWNER_MODIFIED),           // ItemChangeOwner
	(0x100, CREATED),                   // ItemCreated
	(0x2000, PLATFORM_SPECIFIC),        // ItemFinderInfoMod
	(0x2000, ATTRIBUTE_MODIFIED),       // ItemFinderInfoMod
	(0x400, ATTRIBUTE_MODIFIED),        // ItemInodeMetaMod
	(0x2_0000, IS_DIR),                 // ItemIsDir
	(0x1_0000, IS_FILE),                // ItemIsFile
	(0x4_0000, IS_SYMLINK),             // ItemIsSymlink
	(0x1000, UPDATED),                  // ItemModified
	(0x200, REMOVED),                   // ItemRemoved
	(0x800, RENAMED),                   // ItemRenamed
	(0x8000, ATTRIBUTE_MODIFIED),       // ItemXattrMod
	(0x8_0000, ATTRIBUTE_MODIFIED),     // OwnEvent
	(0x10_0000, LINK),                  // ItemIsHardlink
	(0x20_0000, LINK),                  // ItemIsLastHardlink
	(0x20_0000, PLATFORM_SPECIFIC),     // ItemIsLastHardlink
	(0x40_0000, PLATFORM_SPECIFIC),     // ItemCloned
];

/// fswatch's inotify mapping: what it reports of the entry's directory side
/// (type, moves), then of the entry itself.
const INOTIFY: [(u32, u16); 16] = [
	(0x4000_0000, IS_DIR),         // IN_ISDIR
	(0x800, UPDATED),              // IN_MOVE_SELF
	(0x40, REMOVED),               // IN_MOVED_FROM
	(0x40, MOVED_FROM),            // IN_MOVED_FROM
	(0x80, CREATED),               // IN_MOVED_TO
	(0x80, MOVED_TO),              // IN_MOVED_TO
	(0x2000, PLATFORM_SPECIFIC),   // IN_UNMOUNT
	(0x1, PLATFORM_SPECIFIC),      // IN_ACCESS
	(0x4, ATTRIBUTE_MODIFIED),     // IN_ATTRIB
	(0x10, PLATFORM_SPECIFIC),     // IN_CLOSE_NOWRITE
	(0x8, CLOSE_WRITE),            // IN_CLOSE_WRITE
	(0x100, CREATED),              // IN_CREATE
	(0x200, REMOVED),              // IN_DELETE
	(0x400, REMOVED),              // IN_DELETE_SELF
	(0x2, UPDATED),                // IN_MODIFY
	(0x20, PLATFORM_SPECIFIC),     // IN_OPEN
];

/// fswatch's kqueue table: vnode event flag, event flag.
const KQUEUE: [(u32, u16); 7] = [
	(0x1, REMOVED),             // NOTE_DELETE
	(0x2, UPDATED),             // NOTE_WRITE
	(0x4, PLATFORM_SPECIFIC),   // NOTE_EXTEND
	(0x8, ATTRIBUTE_MODIFIED),  // NOTE_ATTRIB
	(0x10, LINK),               // NOTE_LINK
	(0x20, RENAMED),            // NOTE_RENAME
	(0x40, PLATFORM_SPECIFIC),  // NOTE_REVOKE
];

/// fswatch's `ReadDirectoryChangesW` mapping, by `FILE_ACTION_*`.
const fn windows_action(action: u32) -> &'static [u16] {
	match action {
		1 => &[CREATED],
		2 => &[REMOVED],
		3 => &[UPDATED],
		4 => &[MOVED_FROM, RENAMED],
		5 => &[MOVED_TO, RENAMED],
		_ => &[],
	}
}

/// The flags fswatch's `backend` monitor reports for an event the watcher
/// delivered with `flags` and the system's own `native` value.
pub(super) fn decode(backend: Backend, flags: Flags, native: u32) -> FlagList {
	let table: &[(u32, u16)] = match backend {
		Backend::FsEvents if native != 0 => &FSEVENTS,
		Backend::Inotify if native != 0 => &INOTIFY,
		Backend::Kqueue if native != 0 => &KQUEUE,
		Backend::Windows if native != 0 => return SmallVec::from_slice(windows_action(native)),
		_ => {
			// An event of the watcher's own (a scan, a root that appeared), and
			// every event of the poll monitor.
			let flags = match backend {
				// inotify tells files from directories only by the latter's flag.
				Backend::Inotify => flags.difference(Flags::IS_FILE),
				// fswatch's poll monitor compares times and names no types: a
				// newer mtime is an update, and a newer ctime, which every change
				// to an inode brings, an attribute change.
				Backend::Poll => {
					let inode = Flags::OWNER_MODIFIED | Flags::LINK;
					let flags = if flags.intersects(inode | Flags::UPDATED) {
						flags.difference(inode) | Flags::ATTRIBUTE_MODIFIED
					} else {
						flags
					};
					flags.difference(Flags::TYPES)
				},
				_ => flags,
			};
			return ascending(flags.bits());
		},
	};
	table
		.iter()
		.filter(|(bits, _)| native & bits != 0)
		.map(|&(_, flag)| flag)
		.collect()
}

/// The flags of `bits`, lowest first.
fn ascending(bits: u32) -> FlagList {
	(0..15)
		.map(|bit| 1u16 << bit)
		.filter(|&flag| bits & u32::from(flag) != 0)
		.collect()
}

/// fswatch's name for `flag`.
pub(super) fn name(flag: u16) -> &'static str {
	if flag == NO_OP {
		return "NoOp";
	}
	Flags::from_bits(u32::from(flag)).names().next().unwrap_or("")
}

/// The `--event` filters: the flags an event keeps.
#[derive(Default)]
struct EventTypes {
	/// Whether any `--event` was given; without one every flag is kept.
	active: bool,
	mask:   u32,
	no_op:  bool,
}

impl EventTypes {
	fn new(accepted: &[u32]) -> Self {
		Self {
			active: !accepted.is_empty(),
			mask:   accepted.iter().fold(0, |mask, flag| mask | flag),
			no_op:  accepted.contains(&0),
		}
	}

	const fn keeps(&self, flag: u16) -> bool {
		if flag == NO_OP { self.no_op } else { self.mask & flag as u32 != 0 }
	}
}

/// The `-e`/`-i` filters.
struct PathFilters {
	mode:    FilterMode,
	/// The expression and whether it includes.
	filters: Vec<(Regex, bool)>,
}

impl PathFilters {
	fn accepts(&self, path: &[u8]) -> bool {
		if self.mode == FilterMode::Conjunctive {
			let mut has_includes = false;
			let mut included = false;
			for (regex, include) in &self.filters {
				let matches = regex.is_match(path);
				if *include {
					has_includes = true;
					included |= matches;
				} else if matches {
					return false;
				}
			}
			return !has_includes || included;
		}
		let mut excluded = false;
		for (regex, include) in &self.filters {
			if regex.is_match(path) {
				if *include {
					return true;
				}
				excluded = true;
			}
		}
		!excluded
	}
}

/// Compiles a filter expression: POSIX basic, or extended.
///
/// # Errors
///
/// fswatch's report of an expression that does not compile.
pub(super) fn compile(text: &str, extended: bool, case_sensitive: bool) -> Result<Regex, Exit> {
	let translated;
	let pattern = if extended {
		Some(text)
	} else {
		translated =
			bre::bre_to_ere(text, bre::Backrefs::Unsupported, bre::StackedRepeats::Allowed, bre::Encoding::Utf8).ok();
		translated.as_deref()
	};
	pattern
		.and_then(|pattern| {
			RegexBuilder::new(pattern)
				.case_insensitive(!case_sensitive)
				.dot_matches_new_line(true)
				.build()
				.ok()
		})
		.ok_or_else(|| {
			Exit::error(
				EXIT_ERROR,
				format!("An error occurred during the compilation of {text}\nStatus code: 2048"),
			)
		})
}

/// One part of a record.
enum Piece {
	Text(Vec<u8>),
	/// `%p`
	Path,
	/// `%f`
	Flags,
	/// `%t`
	Time,
	/// `%c`
	Correlation,
}

/// The pieces of the valid record format `format`.
fn pieces(format: &str) -> Vec<Piece> {
	let mut pieces = Vec::new();
	let mut text = Vec::new();
	let mut bytes = format.bytes();
	while let Some(byte) = bytes.next() {
		if byte != b'%' {
			text.push(byte);
			continue;
		}
		let piece = match bytes.next() {
			Some(b'%') => {
				text.push(b'%');
				continue;
			},
			Some(b'0') => {
				text.push(0);
				continue;
			},
			Some(b'n') => {
				text.push(b'\n');
				continue;
			},
			Some(b'p') => Piece::Path,
			Some(b'f') => Piece::Flags,
			Some(b't') => Piece::Time,
			Some(b'c') => Piece::Correlation,
			// `%K` and `%P`: the process behind the event, which no monitor
			// here knows; fswatch prints nothing for them then.
			_ => continue,
		};
		if !text.is_empty() {
			pieces.push(Piece::Text(std::mem::take(&mut text)));
		}
		pieces.push(piece);
	}
	if !text.is_empty() {
		pieces.push(Piece::Text(text));
	}
	pieces
}

/// The watcher lost events and `--allow-overflow` was not given.
#[derive(Debug)]
pub(super) struct Overflowed;

/// Turns batches into fswatch's output.
pub(super) struct Printer {
	pieces:         Vec<Piece>,
	flag_separator: Vec<u8>,
	numeric:        bool,
	terminator:     u8,
	time_format:    String,
	zone:           TimeZone,
	/// `--batch-marker`.
	marker:         Option<Vec<u8>>,
	/// `-o`: one count per batch instead of its records.
	count_only:     bool,
	bubble:         bool,
	allow_overflow: bool,
	types:          EventTypes,
	paths:          PathFilters,
}

impl Printer {
	/// The printer `options` describe; `filters` are those of `-e`, `-i` and
	/// the filter files, and `zone` is where `%t` is local.
	///
	/// # Errors
	///
	/// A filter that does not compile.
	pub(super) fn new(options: &Options, filters: &[FilterSpec], zone: TimeZone) -> Result<Self, Exit> {
		let format = match &options.format {
			Some(format) => format.clone(),
			None => {
				let mut format = String::new();
				if options.timestamp {
					format.push_str("%t ");
				}
				format.push_str("%p");
				if options.event_flags {
					format.push_str(" %f");
				}
				format
			},
		};
		let filters = filters
			.iter()
			.map(|filter| {
				compile(&filter.text, filter.extended, filter.case_sensitive)
					.map(|regex| (regex, filter.include))
			})
			.collect::<Result<_, _>>()?;
		Ok(Self {
			pieces: pieces(&format),
			flag_separator: options.flag_separator.clone().into_bytes(),
			numeric: options.numeric,
			terminator: if options.print0 { 0 } else { b'\n' },
			time_format: options.time_format.clone(),
			zone: if options.utc { TimeZone::UTC } else { zone },
			marker: options.batch_marker.clone().map(String::into_bytes),
			count_only: options.one_per_batch,
			bubble: options.bubble,
			allow_overflow: options.allow_overflow,
			types: EventTypes::new(&options.events),
			paths: PathFilters { mode: options.filter_mode, filters },
		})
	}

	/// Whether records carry `%c`.
	pub(super) fn wants_correlation(&self) -> bool {
		self.pieces.iter().any(|piece| matches!(piece, Piece::Correlation))
	}

	/// Appends what fswatch prints for `batch` to `out`; `false` when the
	/// filters leave nothing of it.
	///
	/// # Errors
	///
	/// [`Overflowed`], with `out` as it was.
	pub(super) fn batch(
		&self,
		backend: Backend,
		batch: &Batch,
		out: &mut Vec<u8>,
	) -> Result<bool, Overflowed> {
		let start = out.len();
		let mut pass = Pass::new(self, out, batch.time());
		for event in batch.iter() {
			let path = event.path.as_os_str().as_encoded_bytes();
			if event.flags.contains(Flags::OVERFLOW) {
				if self.allow_overflow {
					pass.record(path, 0, SmallVec::from_slice(&[OVERFLOW]));
					continue;
				}
				// fswatch's FSEvents monitor reports a dropped event like any
				// other; the rest end on one.
				if backend != Backend::FsEvents {
					pass.out.truncate(start);
					return Err(Overflowed);
				}
			}
			if backend == Backend::FsEvents && event.native & FSEVENTS_ROOT_CHANGED != 0 {
				continue;
			}
			pass.record(path, event.id, decode(backend, event.flags, event.native));
		}
		Ok(pass.finish())
	}

	/// Appends the idle event (`--fire-idle-events`) to `out`; `false` when
	/// the filters drop it.
	pub(super) fn idle(&self, out: &mut Vec<u8>) -> bool {
		let mut pass = Pass::new(self, out, SystemTime::now());
		pass.record(b"", 0, SmallVec::from_slice(&[NO_OP]));
		pass.finish()
	}

	/// `time` as `%t` prints it.
	fn stamp(&self, time: SystemTime) -> String {
		// fswatch stamps events with `time()`: whole seconds.
		let seconds = match time.duration_since(SystemTime::UNIX_EPOCH) {
			Ok(since) => i64::try_from(since.as_secs()).unwrap_or(i64::MAX),
			Err(_) => 0,
		};
		Timestamp::from_second(seconds)
			.ok()
			.and_then(|timestamp| {
				let zoned = timestamp.to_zoned(self.zone.clone());
				let config = Config::new().custom(PosixCustom::new()).lenient(true);
				BrokenDownTime::from(&zoned)
					.to_string_with_config(&config, &self.time_format)
					.ok()
			})
			// `strftime` into fswatch's 128-byte buffer.
			.filter(|stamp| !stamp.is_empty() && stamp.len() < 128)
			.unwrap_or_else(|| "<date format error>".to_owned())
	}
}

/// One batch on its way through the filters into the output.
struct Pass<'p, 'b> {
	printer: &'p Printer,
	out:     &'p mut Vec<u8>,
	time:    SystemTime,
	/// `time` formatted, once a record needs it.
	stamp:   Option<String>,
	/// Records that passed the filters.
	shown:   usize,
	/// `-b`: path, correlation id and flag bits of the events to merge.
	held:    Vec<(&'b [u8], u64, u32)>,
}

impl<'p, 'b> Pass<'p, 'b> {
	fn new(printer: &'p Printer, out: &'p mut Vec<u8>, time: SystemTime) -> Self {
		Self { printer, out, time, stamp: None, shown: 0, held: Vec::new() }
	}

	/// Filters one event and prints it, or holds it for `-b`.
	fn record(&mut self, path: &'b [u8], id: u64, mut flags: FlagList) {
		let printer = self.printer;
		if printer.types.active {
			flags.retain(|flag| printer.types.keeps(*flag));
		}
		if flags.is_empty() || !printer.paths.accepts(path) {
			return;
		}
		if printer.bubble {
			let bits = flags.iter().fold(0, |bits, &flag| bits | u32::from(flag));
			self.held.push((path, id, bits));
		} else {
			self.print(path, id, &flags);
		}
	}

	fn print(&mut self, path: &[u8], id: u64, flags: &[u16]) {
		self.shown += 1;
		let printer = self.printer;
		if printer.count_only {
			return;
		}
		for piece in &printer.pieces {
			match piece {
				Piece::Text(text) => self.out.extend_from_slice(text),
				Piece::Path => self.out.extend_from_slice(path),
				Piece::Correlation => {
					let _ = write!(self.out, "{id}");
				},
				Piece::Time => {
					let stamp = self.stamp.get_or_insert_with(|| printer.stamp(self.time));
					self.out.extend_from_slice(stamp.as_bytes());
				},
				Piece::Flags if printer.numeric => {
					let mask: u32 = flags.iter().map(|&flag| u32::from(flag)).sum();
					let _ = write!(self.out, "{mask}");
				},
				Piece::Flags => {
					for (index, &flag) in flags.iter().enumerate() {
						if index > 0 {
							self.out.extend_from_slice(&printer.flag_separator);
						}
						self.out.extend_from_slice(name(flag).as_bytes());
					}
				},
			}
		}
		self.out.push(printer.terminator);
	}

	/// Ends the batch: the merged events of `-b`, the count of `-o` and the
	/// batch marker. `false` when no record passed the filters.
	fn finish(mut self) -> bool {
		let mut held = std::mem::take(&mut self.held);
		// fswatch keys the merge by time, path and correlation id, and prints
		// in key order; a batch has one time.
		held.sort_unstable_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
		let mut at = 0;
		while at < held.len() {
			let (path, id, mut bits) = held[at];
			at += 1;
			while at < held.len() && (held[at].0, held[at].1) == (path, id) {
				bits |= held[at].2;
				at += 1;
			}
			let flags = if bits == 0 { SmallVec::from_slice(&[NO_OP]) } else { ascending(bits) };
			self.print(path, id, &flags);
		}
		if self.shown == 0 {
			return false;
		}
		let printer = self.printer;
		if printer.count_only {
			let _ = write!(self.out, "{}", self.shown);
			self.out.push(printer.terminator);
		}
		if let Some(marker) = &printer.marker {
			self.out.extend_from_slice(marker);
			self.out.push(printer.terminator);
		}
		true
	}
}

#[cfg(test)]
impl Printer {
	/// Appends what fswatch prints for one batch read at `time`, given as
	/// path, correlation id and flag names.
	pub(super) fn events(
		&self,
		time: SystemTime,
		events: &[(&str, u64, &[&str])],
		out: &mut Vec<u8>,
	) -> bool {
		let mut pass = Pass::new(self, out, time);
		for &(path, id, names) in events {
			let flags = names
				.iter()
				.map(|name| Flags::from_name(name).expect("flag name").bits() as u16)
				.collect();
			pass.record(path.as_bytes(), id, flags);
		}
		pass.finish()
	}
}
