//! The buffer scanner: finds a buffer's matching lines (or multiline blocks)
//! and renders them with their context, with grep-searcher's semantics as pi
//! drove it (binary detection, context, match limits), monomorphised per
//! engine.
//!
//! Line mode asks the matcher for candidate lines over the whole buffer
//! (`find_candidate_line`, the literal-prefiltered fast path) when it is
//! line-terminated, and otherwise searches the buffer with `find_at`,
//! confirming a match that crosses a line end against its first line alone.
//! Multiline mode merges matches on the same or adjacent lines into one block.

use std::io;

use grep_matcher::{LineMatchKind, Matcher};
use grep_searcher::{
	BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkContextKind, SinkMatch,
};

use super::{
	ContextLine, Match,
	render::{matched_text, trimmed, truncate_line},
};

/// How much of a buffer is checked for NUL up front (grep-searcher's buffer
/// size): a NUL there makes the buffer binary, searched without matches.
/// Past it, a line about to be reported (match or context) that holds a NUL
/// ends the scan, keeping what was reported before it.
const BINARY_WINDOW: usize = 64 * 1024;

/// Longest line a streamed search buffers before it fails.
pub const STREAM_LINE_LIMIT: usize = 64 * 1024 * 1024;

/// What one scan reports.
#[derive(Clone, Copy, Debug, Default)]
pub struct ScanParams {
	/// Render [`Match`] entries (line numbers, text, context).
	pub content:     bool,
	/// Context lines before each match (content only).
	pub before:      usize,
	/// Context lines after each match (content only).
	pub after:       usize,
	/// Window or cut reported lines longer than this many bytes.
	pub max_columns: Option<usize>,
	/// Matches to skip before collecting.
	pub offset:      u64,
	/// Collect at most this many matches (at least one: the cap is checked
	/// after collecting, like pi's collector).
	pub cap:         Option<u64>,
	/// Once capped, look for one more match and count it (pi's collector
	/// stops at the match after the cap); otherwise stop at the cap.
	pub probe:       bool,
}

/// Outcome of one scan.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScanOutcome {
	/// Matches found: skipped, collected, and the probe match.
	pub count:         u64,
	/// Matches collected (after `offset`, up to the cap).
	pub collected:     u64,
	/// The cap was reached.
	pub limit_reached: bool,
}

/// Per-thread scanner scratch.
#[derive(Default)]
pub struct Scanner {
	starts: Vec<usize>,
}

/// Index of the `\n` ending the line that starts at or contains `s`, or
/// `buf.len()`.
fn line_end(buf: &[u8], s: usize) -> usize {
	memchr::memchr(b'\n', &buf[s..]).map_or(buf.len(), |i| s + i)
}

/// Start of the line containing `pos`.
fn line_start(buf: &[u8], pos: usize) -> usize {
	memchr::memrchr(b'\n', &buf[..pos]).map_or(0, |i| i + 1)
}

/// Number of `\n` in `b`.
#[allow(clippy::naive_bytecount, reason = "auto-vectorised; no bytecount dependency")]
fn newlines(b: &[u8]) -> u64 {
	b.iter().filter(|&&c| c == b'\n').count() as u64
}

/// How [`Blocks`] finds matches.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Strategy {
	/// Line mode with a line-terminated matcher: candidate lines.
	Candidates,
	/// Line mode otherwise: buffer search, crossing matches confirmed per
	/// line.
	Confirm,
	/// Multiline blocks.
	Multi,
}

/// A buffer's matches as line blocks `[bs, be)`: `be` is the index of the
/// `\n` ending the block's last line, or the buffer length. In multiline
/// mode a block is the lines a match touches, and matches on the same or
/// adjacent lines merge into one block (grep-searcher's `MultiLine`).
struct Blocks<'a, M> {
	matcher:  &'a M,
	buf:      &'a [u8],
	strategy: Strategy,
	/// Line mode: next line start; multiline: next search position.
	from:     usize,
	pending:  Option<(usize, usize)>,
	done:     bool,
}

impl<M: Matcher> Blocks<'_, M> {
	fn next(&mut self) -> Result<Option<(usize, usize)>, M::Error> {
		match self.strategy {
			Strategy::Candidates => self.next_candidate(),
			Strategy::Confirm => self.next_confirmed(),
			Strategy::Multi => self.next_multi(),
		}
	}

	fn next_candidate(&mut self) -> Result<Option<(usize, usize)>, M::Error> {
		let buf = self.buf;
		while self.from < buf.len() {
			let from = self.from;
			let (kind, at) = match self.matcher.find_candidate_line(&buf[from..])? {
				None => break,
				Some(LineMatchKind::Confirmed(i)) => (true, from + i),
				Some(LineMatchKind::Candidate(i)) => (false, from + i),
			};
			let ls = line_start(buf, at);
			if ls == buf.len() {
				break;
			}
			let le = line_end(buf, at);
			self.from = le + 1;
			if kind || self.matcher.is_match(&buf[ls..le])? {
				return Ok(Some((ls, le)));
			}
		}
		self.from = buf.len();
		Ok(None)
	}

	fn next_confirmed(&mut self) -> Result<Option<(usize, usize)>, M::Error> {
		let buf = self.buf;
		while self.from < buf.len() {
			let Some(found) = self.matcher.find_at(buf, self.from)? else {
				break;
			};
			let ls = line_start(buf, found.start());
			if ls == buf.len() {
				break;
			}
			let le = line_end(buf, found.start());
			self.from = le + 1;
			// Look-around may have read past the line; judge it alone.
			if self.matcher.is_match(&buf[ls..le])? {
				return Ok(Some((ls, le)));
			}
		}
		self.from = buf.len();
		Ok(None)
	}

	fn next_multi(&mut self) -> Result<Option<(usize, usize)>, M::Error> {
		let buf = self.buf;
		while !self.done && self.from < buf.len() {
			let Some(found) = self.matcher.find_at(buf, self.from)? else {
				self.done = true;
				break;
			};
			let (s, e) = (found.start(), found.end());
			self.from = if s == e { e + 1 } else { e };
			let ls = line_start(buf, s);
			let le = if e > ls && buf[e - 1] == b'\n' {
				e
			} else {
				memchr::memchr(b'\n', &buf[e..]).map_or(buf.len(), |i| e + i + 1)
			};
			match self.pending {
				Some((ps, pe)) if pe >= ls => self.pending = Some((ps, le)),
				Some(out) => {
					self.pending = Some((ls, le));
					return Ok(self.emit(out));
				},
				None => self.pending = Some((ls, le)),
			}
		}
		Ok(self.pending.take().and_then(|out| self.emit(out)))
	}

	/// A pending line range as a block; an empty range (a match just past a
	/// final `\n`) ends the search, as in grep-searcher.
	const fn emit(&mut self, (s, mut e): (usize, usize)) -> Option<(usize, usize)> {
		if s == e {
			self.done = true;
			self.pending = None;
			return None;
		}
		if self.buf[e - 1] == b'\n' {
			e -= 1;
		}
		Some((s, e))
	}
}

/// Pending after-context of the latest reported (or skipped) match.
struct After {
	/// Next after-context line start.
	pos:   usize,
	/// Its line number.
	line:  u64,
	/// Lines still owed.
	left:  usize,
	/// Index in `out` of the match they belong to (`None`: skipped match).
	owner: Option<usize>,
}

impl Scanner {
	/// Scans `buf` with `matcher`, appending rendered matches to `out` when
	/// `p.content` (with empty paths). `multiline` is whether the engine was
	/// compiled for multiline matching.
	pub fn scan<M: Matcher>(
		&mut self,
		matcher: &M,
		multiline: bool,
		spans_lines: bool,
		buf: &[u8],
		p: &ScanParams,
		out: &mut Vec<Match>,
	) -> Result<ScanOutcome, M::Error> {
		let mut res = ScanOutcome::default();
		if memchr::memchr(0, &buf[..buf.len().min(BINARY_WINDOW)]).is_some() {
			return Ok(res);
		}
		let multi = multiline && spans_lines;
		let strategy = if multi {
			Strategy::Multi
		} else if matcher
			.line_terminator()
			.is_some_and(|t| t.as_byte() == b'\n')
		{
			Strategy::Candidates
		} else {
			Strategy::Confirm
		};
		let mut blocks = Blocks { matcher, buf, strategy, from: 0, pending: None, done: false };
		let nul = |s: usize, e: usize| e > BINARY_WINDOW && memchr::memchr(0, &buf[s..e]).is_some();
		let (before, after) = if p.content {
			(p.before, p.after)
		} else {
			(0, 0)
		};

		let mut cur = 0usize;
		let mut cur_line = 1u64;
		// Lines before `floor` were reported already.
		let mut floor = 0usize;
		let mut pending = After { pos: 0, line: 0, left: 0, owner: None };
		let mut skipped = 0u64;

		// Reports pending after-context lines that start before `limit`;
		// false means a NUL ended the scan.
		let flush_after =
			|pending: &mut After, floor: &mut usize, out: &mut Vec<Match>, limit: usize| {
				while pending.left > 0 && pending.pos < limit && pending.pos < buf.len() {
					let e = line_end(buf, pending.pos);
					if nul(pending.pos, e) {
						return false;
					}
					if let Some(owner) = pending.owner {
						let text = truncate_line(trimmed(&buf[pending.pos..e]), p.max_columns);
						out[owner]
							.after
							.push(ContextLine { line: pending.line, text });
					}
					pending.pos = e + 1;
					pending.line += 1;
					pending.left -= 1;
					*floor = pending.pos;
				}
				true
			};

		while let Some((bs, be)) = blocks.next()? {
			// Up to `before` unreported line starts preceding `bs`, nearest
			// first.
			self.starts.clear();
			if p.content {
				if !flush_after(&mut pending, &mut floor, &mut *out, bs) {
					return Ok(res);
				}
				let mut pos = bs;
				while self.starts.len() < before && pos > floor {
					pos = line_start(buf, pos - 1);
					self.starts.push(pos);
				}
			}
			if res.limit_reached {
				// The probe: grep-searcher reports a match's context before
				// the match, so a NUL in either keeps it from counting.
				if self.starts.iter().any(|&s| nul(s, line_end(buf, s))) || nul(bs, be) {
					return Ok(res);
				}
				res.count += 1;
				return Ok(res);
			}
			if !p.content {
				if nul(bs, be) {
					return Ok(res);
				}
				res.count += 1;
				if skipped < p.offset {
					skipped += 1;
					continue;
				}
				res.collected += 1;
				if p.cap.is_some_and(|cap| res.collected >= cap) {
					res.limit_reached = true;
					if !p.probe {
						return Ok(res);
					}
				}
				continue;
			}

			cur_line += newlines(&buf[cur..bs]);
			cur = bs;
			let n = self.starts.len() as u64;
			let mut context = Vec::new();
			for (i, &s) in self.starts.iter().rev().enumerate() {
				let e = line_end(buf, s);
				if nul(s, e) {
					return Ok(res);
				}
				if skipped >= p.offset {
					let text = truncate_line(trimmed(&buf[s..e]), p.max_columns);
					context.push(ContextLine { line: cur_line - n + i as u64, text });
				}
			}
			if nul(bs, be) {
				return Ok(res);
			}
			res.count += 1;
			let after_line = cur_line + 1 + if multi { newlines(&buf[bs..be]) } else { 0 };
			pending = After { pos: be + 1, line: after_line, left: after, owner: None };
			floor = be + 1;
			if skipped < p.offset {
				skipped += 1;
				continue;
			}
			let end = if be < buf.len() { be + 1 } else { be };
			let (text, truncated, column) =
				matched_text(matcher, buf, (bs, end), multi, p.max_columns);
			pending.owner = Some(out.len());
			out.push(Match {
				path: String::new(),
				line: cur_line,
				text,
				before: context,
				after: if after > 0 {
					Vec::with_capacity(after)
				} else {
					Vec::new()
				},
				truncated,
				column,
				count: None,
			});
			res.collected += 1;
			if p.cap.is_some_and(|cap| res.collected >= cap) {
				res.limit_reached = true;
				if !p.probe {
					break;
				}
			}
		}
		if p.content {
			flush_after(&mut pending, &mut floor, &mut *out, buf.len());
		}
		Ok(res)
	}
}

/// pi's `MatchCollector` over grep-searcher: the streamed search of a file
/// root too large to hold in memory.
struct StreamCollector<'a, M> {
	matcher: &'a M,
	params:  &'a ScanParams,
	out:     &'a mut Vec<Match>,
	res:     ScanOutcome,
	skipped: u64,
	before:  Vec<ContextLine>,
}

impl<M: Matcher> Sink for StreamCollector<'_, M> {
	type Error = io::Error;

	fn matched(&mut self, _: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		self.res.count += 1;
		if self.res.limit_reached {
			return Ok(false);
		}
		if self.skipped < self.params.offset {
			self.skipped += 1;
			self.before.clear();
			return Ok(true);
		}
		if self.params.content {
			let range = mat.bytes_range_in_buffer();
			let (text, truncated, column) = matched_text(
				self.matcher,
				mat.buffer(),
				(range.start, range.end),
				false,
				self.params.max_columns,
			);
			self.out.push(Match {
				path: String::new(),
				line: mat.line_number().unwrap_or(0),
				text,
				before: std::mem::take(&mut self.before),
				after: Vec::new(),
				truncated,
				column,
				count: None,
			});
		}
		self.res.collected += 1;
		if self.params.cap.is_some_and(|cap| self.res.collected >= cap) {
			self.res.limit_reached = true;
			if !self.params.probe {
				return Ok(false);
			}
		}
		Ok(true)
	}

	fn context(&mut self, _: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		if !self.params.content {
			return Ok(true);
		}
		let line = ContextLine {
			line: ctx.line_number().unwrap_or(0),
			text: truncate_line(trimmed(ctx.bytes()), self.params.max_columns),
		};
		match ctx.kind() {
			SinkContextKind::Before => self.before.push(line),
			SinkContextKind::After => {
				if let Some(last) = self.out.last_mut() {
					last.after.push(line);
				}
			},
			SinkContextKind::Other => {},
		}
		Ok(true)
	}
}

/// Searches `reader` line by line through grep-searcher's bounded buffer
/// (lines up to [`STREAM_LINE_LIMIT`]), with the semantics of
/// [`Scanner::scan`] in line mode.
pub fn scan_reader<M: Matcher>(
	matcher: &M,
	reader: impl io::Read,
	p: &ScanParams,
	out: &mut Vec<Match>,
) -> io::Result<ScanOutcome> {
	let (before, after) = if p.content {
		(p.before, p.after)
	} else {
		(0, 0)
	};
	let mut searcher = SearcherBuilder::new()
		.binary_detection(BinaryDetection::quit(0))
		.line_number(p.content)
		.before_context(before)
		.after_context(after)
		.heap_limit(Some(STREAM_LINE_LIMIT))
		.build();
	let mut sink = StreamCollector {
		matcher,
		params: p,
		out,
		res: ScanOutcome::default(),
		skipped: 0,
		before: Vec::new(),
	};
	searcher.search_reader(matcher, reader, &mut sink)?;
	Ok(sink.res)
}
