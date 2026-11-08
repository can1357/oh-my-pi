//! `--progress` per-file lines and the `--info=progress2` whole-transfer line.
//!
//! Lines are `\r`-rewritten in place:
//! `\r<bytes:15> <pct:3>% <rate:7.2><unit> <h:4>:<mm>:<ss>` followed by two
//! spaces while a file is in flight, or ` (xfr#N, to-chk=M/T)` when it ends.
//! While a file is in flight the rate covers the last ~5 seconds (one sample
//! per second) and the time is the estimated remainder; the final line shows
//! the file's average rate and elapsed time.

use std::time::{Duration, Instant};

use crate::rsync::log::{LogCode, Logger, big_num};

/// Samples kept for the in-flight rate (one per second).
const HISTORY: usize = 5;

#[derive(Clone, Copy, Debug)]
struct Sample {
	time: Instant,
	ofs: u64,
}

/// --progress / --info=progress2 line printer (client side only). Lines go through the
/// logger as FCLIENT text, sharing its pending-newline state.
pub(crate) struct Progress {
	logger: Logger,
	level: u8,
	human: u8,
	quiet: bool,
	/// Current file size (progress) — the denominator for per-file lines.
	size: u64,
	/// Where the current measurement started (None = not yet).
	start: Option<Sample>,
	history: [Option<Sample>; HISTORY],
	newest: usize,
	oldest: usize,
	/// The whole file list has arrived: `to-chk` rather than `ir-chk`.
	flist_eof: bool,
	/// progress2: bytes of all files handled so far, including the current one's size.
	total_transferred: u64,
	/// progress2: size of the whole transfer.
	total_size: u64,
	/// progress2: length of the previous end-of-line suffix (to blank leftovers).
	last_eol_len: usize,
}

impl Progress {
	/// A printer that writes through `logger` (stdout, honoring `-q` and the logger's
	/// pending-newline state so the next message starts on a fresh line); `level` 1 =
	/// per-file, 2 = whole transfer.
	pub(crate) fn from_logger(logger: &Logger, level: u8) -> Self {
		Self {
			logger: logger.clone(),
			level,
			human: logger.config().human_readable,
			quiet: logger.config().quiet,
			size: 0,
			start: None,
			history: [None; HISTORY],
			newest: 0,
			oldest: 0,
			flist_eof: true,
			total_transferred: 0,
			total_size: 0,
			last_eol_len: 0,
		}
	}

	/// Whether the complete file list has been received (`to-chk` vs `ir-chk`).
	pub(crate) fn set_flist_eof(&mut self, eof: bool) {
		self.flist_eof = eof;
	}

	/// progress2 totals: upstream `stats.total_transferred_size` (already including the
	/// file in flight) and `stats.total_size`.
	pub(crate) fn set_totals(&mut self, transferred: u64, total_size: u64) {
		self.total_transferred = transferred;
		self.total_size = total_size;
	}

	/// A file of `size` bytes is about to arrive.
	pub(crate) fn start_file(&mut self, size: u64) {
		self.size = size;
	}

	/// `done` bytes of the current file are in (show_progress). Prints at most once a
	/// second unless `force`.
	pub(crate) fn update(&mut self, done: u64, force: bool) {
		self.update_at(done, force, Instant::now());
	}

	/// The current file finished (end_progress): prints its final line with
	/// `(xfr#N, to-chk=M/T)`.
	pub(crate) fn end_file(&mut self, done: u64, xfer_ndx: u32, to_check: u32, total: u32) {
		self.end_file_at(done, xfer_ndx, to_check, total, Instant::now());
	}

	fn update_at(&mut self, done: u64, force: bool, now: Instant) {
		let (mut ofs, mut size) = (done, self.size);
		if self.level >= 2 {
			ofs = (self.total_transferred.saturating_sub(size)).saturating_add(ofs);
			size = self.total_size;
		}
		match self.start {
			None => {
				// A sample less than 1.5 s old means data has been flowing: measure from it.
				let recent = self.history[self.newest]
					.filter(|sample| now.saturating_duration_since(sample.time) <= ms(1500));
				let start = match recent {
					Some(sample) => Sample { time: sample.time, ofs: 0 },
					None => Sample { time: now, ofs },
				};
				self.start = Some(start);
				self.history = [Some(start); HISTORY];
			}
			Some(_) => {
				let newest_time = self.history[self.newest].map_or(now, |sample| sample.time);
				if !force && now.saturating_duration_since(newest_time) < ms(1000) {
					return;
				}
				self.newest = self.oldest;
				self.oldest = (self.oldest + 1) % HISTORY;
				self.history[self.newest] = Some(Sample { time: now, ofs });
			}
		}
		self.print(ofs, size, now, None);
	}

	fn end_file_at(&mut self, done: u64, xfer_ndx: u32, to_check: u32, total: u32, now: Instant) {
		let kind = if self.flist_eof { "to" } else { "ir" };
		let eol = format!(" (xfr#{xfer_ndx}, {kind}-chk={to_check}/{total})\n");
		if self.level >= 2 {
			self.print(self.total_transferred, self.total_size, now, Some(eol));
		} else {
			self.print(done, done, now, Some(eol));
			self.start = None;
		}
	}

	/// rprint_progress. `last` carries the end-of-file suffix.
	fn print(&mut self, ofs: u64, size: u64, now: Instant, last: Option<String>) {
		let (rate, remain, eol, is_last) = match last {
			Some(mut eol) => {
				let mut is_last = true;
				if self.level >= 2 {
					// No newline: the next file's line overwrites this one, so pad over
					// whatever a longer previous suffix left behind.
					eol.pop();
					let len = eol.len();
					if self.last_eol_len > len {
						eol.push_str(&" ".repeat(self.last_eol_len - len));
					}
					self.last_eol_len = len;
					is_last = false;
				}
				let (base, elapsed) = match self.start {
					Some(start) => (start.ofs, millis(now.saturating_duration_since(start.time))),
					None => (0, 0),
				};
				let diff = elapsed.max(1) as f64;
				let rate = (ofs as f64 - base as f64) * 1000.0 / diff / 1024.0;
				(rate, diff / 1000.0, eol, is_last)
			}
			None => {
				let oldest = self.history[self.oldest].unwrap_or(Sample { time: now, ofs });
				let diff = millis(now.saturating_duration_since(oldest.time)).max(1) as f64;
				let rate = (ofs as f64 - oldest.ofs as f64) * 1000.0 / diff / 1024.0;
				let remain =
					if rate != 0.0 { (size as f64 - ofs as f64) / rate / 1000.0 } else { 0.0 };
				(rate, remain, "  ".to_owned(), false)
			}
		};
		let line = render_line(ofs, size, rate, remain, &eol, self.human);
		self.write(line.as_bytes(), is_last);
	}

	fn write(&mut self, line: &[u8], is_last: bool) {
		self.logger.set_needs_newline(0);
		self.logger.rprintf(LogCode::Client, line);
		if !is_last && !self.quiet {
			self.logger.set_needs_newline(1);
			self.logger.flush();
		}
	}
}

/// One progress line (without bookkeeping), as upstream lays it out.
fn render_line(ofs: u64, size: u64, rate: f64, remain: f64, eol: &str, human: u8) -> String {
	let (rate, units) = if rate > 1024.0 * 1024.0 {
		(rate / (1024.0 * 1024.0), "GB/s")
	} else if rate > 1024.0 {
		(rate / 1024.0, "MB/s")
	} else {
		(rate, "kB/s")
	};
	let remaining = if !(0.0..=9999.0 * 3600.0).contains(&remain) {
		"  ??:??:??".to_owned()
	} else {
		format!(
			"{:4}:{:02}:{:02}",
			(remain / 3600.0) as u32,
			(remain / 60.0) as u32 % 60,
			remain as u32 % 60
		)
	};
	let pct = if ofs == size { 100 } else { (100.0 * ofs as f64 / size as f64) as i32 };
	let bytes = big_num(i64::try_from(ofs).unwrap_or(i64::MAX), human);
	format!("\r{bytes:>15} {pct:>3}% {rate:>7.2}{units} {remaining}{eol}")
}

const fn ms(n: u64) -> Duration {
	Duration::from_millis(n)
}

fn millis(duration: Duration) -> u64 {
	u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
	use std::{
		io::Write,
		sync::{Arc, Mutex},
	};

	use super::*;
	use crate::rsync::log::LogConfig;

	#[derive(Clone, Default)]
	struct Buf(Arc<Mutex<Vec<u8>>>);

	impl Write for Buf {
		fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
			self.0.lock().unwrap().extend_from_slice(data);
			Ok(data.len())
		}

		fn flush(&mut self) -> std::io::Result<()> {
			Ok(())
		}
	}

	impl Buf {
		fn take(&self) -> String {
			String::from_utf8(std::mem::take(&mut *self.0.lock().unwrap())).unwrap()
		}
	}

	/// A client logger writing stdout into the returned buffer.
	fn client_logger(cfg: LogConfig) -> (Logger, Buf) {
		let out = Buf::default();
		(Logger::local(Box::new(out.clone()), Box::new(Buf::default()), cfg), out)
	}

	fn printer(level: u8, human: u8) -> (Progress, Logger, Buf) {
		let (logger, out) =
			client_logger(LogConfig { human_readable: human, ..LogConfig::default() });
		(Progress::from_logger(&logger, level), logger, out)
	}

	#[test]
	fn line_layout_matches_reference() {
		// Bytes captured from `rsync -r --progress` (3.5.1).
		assert_eq!(
			render_line(17, 17, 0.0, 0.0, " (xfr#1, to-chk=5/7)\n", 1),
			"\r             17 100%    0.00kB/s    0:00:00 (xfr#1, to-chk=5/7)\n"
		);
		assert_eq!(
			render_line(5000, 5000, 4.77 * 1024.0, 0.0, "  ", 1),
			"\r          5,000 100%    4.77MB/s    0:00:00  "
		);
		assert_eq!(
			render_line(5036, 5037, 4.79 * 1024.0, 0.0, " (xfr#4, to-chk=0/7)", 1),
			"\r          5,036  99%    4.79MB/s    0:00:00 (xfr#4, to-chk=0/7)"
		);
		assert_eq!(
			render_line(1_234_567, 2_000_000, 2.5 * 1024.0 * 1024.0, 3725.0, "  ", 3),
			"\r          1.18M  61%    2.50GB/s    1:02:05  "
		);
		assert_eq!(render_line(0, 10, 0.0, -1.0, "  ", 0), "\r              0   0%    0.00kB/s   ??:??:??  ");
	}

	#[test]
	fn per_file_progress_and_final_line() {
		let (mut progress, logger, buf) = printer(1, 1);
		let t0 = Instant::now();
		progress.start_file(10 * 1024 * 1024);
		progress.update_at(0, false, t0);
		assert_eq!(buf.take(), "\r              0   0%    0.00kB/s    0:00:00  ");
		// Under a second later: throttled.
		progress.update_at(1024 * 1024, false, t0 + ms(500));
		assert_eq!(buf.take(), "");
		// One second, 2 MiB in: 2 MB/s, 4 s to go.
		progress.update_at(2 * 1024 * 1024, false, t0 + ms(1000));
		assert_eq!(buf.take(), "\r      2,097,152  20%    2.00MB/s    0:00:04  ");
		progress.end_file_at(10 * 1024 * 1024, 3, 2, 9, t0 + ms(4000));
		assert_eq!(
			buf.take(),
			"\r     10,485,760 100%    2.50MB/s    0:00:04 (xfr#3, to-chk=2/9)\n"
		);
		// A finished line leaves no newline pending.
		assert_eq!(logger.needs_newline(), 0);
	}

	#[test]
	fn incremental_recursion_and_unfinished_line() {
		let (mut progress, logger, buf) = printer(1, 0);
		progress.set_flist_eof(false);
		let t0 = Instant::now();
		progress.start_file(100);
		progress.update_at(50, true, t0);
		buf.take();
		assert_eq!(logger.needs_newline(), 1);
		// The final line overwrites the in-flight one: no newline in between.
		progress.end_file_at(100, 1, 40, 50, t0);
		let text = buf.take();
		assert!(text.starts_with('\r'), "{text:?}");
		assert!(text.ends_with(" (xfr#1, ir-chk=40/50)\n"), "{text:?}");
	}

	#[test]
	fn progress2_pads_shorter_suffixes_without_newline() {
		let (mut progress, logger, buf) = printer(2, 1);
		let t0 = Instant::now();
		progress.set_totals(17, 5036);
		progress.start_file(17);
		progress.update_at(17, false, t0);
		buf.take();
		progress.end_file_at(17, 10, 10, 20, t0);
		assert_eq!(
			buf.take(),
			"\r             17   0%    0.00kB/s    0:00:00 (xfr#10, to-chk=10/20)"
		);
		// The whole-transfer rate keeps measuring from the first sample (5019 bytes in
		// under a millisecond counts as one).
		progress.set_totals(5036, 5036);
		progress.start_file(5019);
		progress.end_file_at(5019, 11, 9, 20, t0);
		assert_eq!(
			buf.take(),
			"\r          5,036 100%    4.79MB/s    0:00:00 (xfr#11, to-chk=9/20) "
		);
		// The next message starts on a fresh line.
		logger.rprintf(LogCode::Info, b"done\n");
		assert_eq!(buf.take(), "\ndone\n");
	}

	#[test]
	fn logger_output_shares_pending_newline() {
		let (mut progress, logger, out) = printer(1, 1);
		let t0 = Instant::now();
		progress.start_file(4);
		progress.update_at(2, false, t0);
		logger.rprintf(LogCode::Info, b"next\n");
		assert_eq!(out.take(), "\r              2  50%    0.00kB/s    0:00:00  \nnext\n");
		let (quiet, out) = client_logger(LogConfig { quiet: true, ..LogConfig::default() });
		let mut progress = Progress::from_logger(&quiet, 1);
		progress.start_file(4);
		progress.update_at(2, false, t0);
		assert_eq!(out.take(), "");
	}
}
