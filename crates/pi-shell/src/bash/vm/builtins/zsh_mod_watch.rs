//! zsh/watch: the `log` builtin, `$watch`/`$WATCH`, `WATCHFMT` and
//! `LOGCHECK`.
//!
//! The login database comes from the host ([`Host::logins`]; the process
//! host reads utmpx with `getutxent`, hosts without one refuse and nothing
//! is reported, as zsh when it cannot `stat` the utmpx file). The last
//! table seen and zsh's `lastutmpcheck`/`lastwatch` live in the store
//! ([`MiscKey::ZshWatch`]). zsh checks before each prompt (a pre-prompt
//! function): the interactive reader calls [`check`] and writes what it
//! returns to standard output.
//!
//! A logout's time is the time of the check: zsh searches the wtmp file
//! for it, which macOS does not keep (zsh's `WATCH_WTMP_FILE` is
//! `/dev/null` there, and its search falls back to `time(NULL)`).
//!
//! [`Host::logins`]: crate::bash::Host::logins
//!
//! Ported from zsh 5.9 `Src/Modules/watch.c` (MIT-style licence, Copyright
//! (c) 1992-1997 Paul Falstad and the zsh development group).

use std::cmp::Ordering;

use bstr::{BString, ByteSlice};

use super::{
	Ctx, R, done,
	zsh_args::zx,
	zsh_mod_util::ztrftime,
	zsh_prompt::{
		Cap, ColourSeqs, TXT_ERROR, TXTNOBGCOLOUR, TXTNOFGCOLOUR, TermCaps, colour_sequence,
		match_colour, tsetcap,
	},
};
use crate::bash::{
	Login,
	pattern::zsh::{PatFlags, tokenize},
	store::{Attrs, Key, KeyBuf, MiscKey, Record},
	syntax::zsh::tok,
	vm::{
		expand::{Expander, Stop, X},
		state,
		zsh::{math::Number, params, zpattern},
	},
	zshopt::ZshOpt,
};

/// zsh's `DEFAULT_WATCHFMT` (utmpx has `ut_host`).
pub const DEFAULT_WATCHFMT: &[u8] = b"%n has %a %l from %m.";

/// zsh/watch's state between checks.
#[derive(Default)]
struct Watch {
	/// zsh's `wtab`: the sessions of the last check (`None`: not read yet).
	wtab:          Option<Vec<Login>>,
	/// zsh's `lastutmpcheck`: the utmpx mtime of the last check.
	lastutmpcheck: i64,
	/// zsh's `lastwatch`: when the last check ran.
	lastwatch:     i64,
}

impl Watch {
	/// The state a [`MiscKey::ZshWatch`] record holds: `wtab` present
	/// (`0`/`1`), `lastutmpcheck`, `lastwatch`, then user, line, host and
	/// time per session.
	fn from_record(rec: Option<&Record>) -> Self {
		let Some(Record::Words(w)) = rec else {
			return Self::default();
		};
		let num = |i: usize| -> i64 {
			w.get(i)
				.and_then(|s| s.to_str().ok())
				.and_then(|s| s.parse().ok())
				.unwrap_or(0)
		};
		let entries = w
			.get(3..)
			.unwrap_or_default()
			.as_chunks::<4>()
			.0
			.iter()
			.map(|c| Login {
				user: c[0].clone(),
				line: c[1].clone(),
				host: c[2].clone(),
				time: c[3].to_str().ok().and_then(|s| s.parse().ok()).unwrap_or(0),
			})
			.collect();
		Self {
			wtab:          (num(0) != 0).then_some(entries),
			lastutmpcheck: num(1),
			lastwatch:     num(2),
		}
	}

	fn to_record(&self) -> Record {
		let wtab = self.wtab.as_deref().unwrap_or_default();
		let mut w = Vec::with_capacity(3 + 4 * wtab.len());
		w.push(BString::from(if self.wtab.is_some() { "1" } else { "0" }));
		w.push(BString::from(self.lastutmpcheck.to_string()));
		w.push(BString::from(self.lastwatch.to_string()));
		for e in wtab {
			w.push(e.user.clone());
			w.push(e.line.clone());
			w.push(e.host.clone());
			w.push(BString::from(e.time.to_string()));
		}
		Record::Words(w)
	}
}

fn load(ex: &mut Expander<'_, '_>) -> X<Watch> {
	Ok(Watch::from_record(state::record(ex.cx.store, ex.vp, Key::Misc(MiscKey::ZshWatch))?))
}

fn save(ex: &mut Expander<'_, '_>, w: &Watch) {
	state::store_record(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		KeyBuf::Misc(MiscKey::ZshWatch),
		Some(w.to_record()),
	);
}

/// zsh `ucmp`: by login time, then terminal.
fn ucmp(u: &Login, v: &Login) -> Ordering {
	u.time.cmp(&v.time).then_with(|| u.line.cmp(&v.line))
}

/// The host's sessions sorted as zsh's `readwtab` leaves them, with the
/// utmpx mtime; `None` when the host has no login database.
fn read_utmp(ex: &Expander<'_, '_>) -> Option<(i64, Vec<Login>)> {
	let mut l = ex.cx.host.logins().ok()?;
	l.entries.sort_by(ucmp);
	Some((l.mtime, l.entries))
}

/// zsh `dowatch`: report the logins and logouts since the last check, as
/// `$WATCHFMT` lines for the sessions `$watch` selects; the text.
///
/// # Errors
/// A store failure, a parameter error.
pub fn dowatch(ex: &mut Expander<'_, '_>) -> X<Vec<u8>> {
	let mut st = load(ex)?;
	let utmp = read_utmp(ex);
	if st.wtab.is_none() {
		st.wtab = Some(utmp.as_ref().map_or_default(|(_, e)| e.clone()));
	}
	let Some((mtime, utab)) = utmp.filter(|(m, _)| *m > st.lastutmpcheck) else {
		save(ex, &st);
		return Ok(Vec::new());
	};
	st.lastutmpcheck = mtime;
	let watch: Vec<BString> = match state::lookup(&ex.k.root, ex.cx.store, ex.vp, b"WATCH")? {
		Some(v) => match v.as_scalar() {
			Some(s) if !s.is_empty() => s.split(|&c| c == b':').map(BString::from).collect(),
			_ => Vec::new(),
		},
		None => Vec::new(),
	};
	let fmt = params::getsparam(ex, b"WATCHFMT")?.unwrap_or_else(|| DEFAULT_WATCHFMT.into());
	let me = ex.cx.host.user().name;
	let now = ex.cx.host.wall().secs;
	let term = term_caps(ex)?;
	let wtab = st.wtab.take().unwrap_or_default();
	let mut out = Vec::new();
	let (mut u, mut w) = (0, 0);
	while u < utab.len() || w < wtab.len() {
		let ord = (u < utab.len() && w < wtab.len()).then(|| ucmp(&utab[u], &wtab[w]));
		if u >= utab.len() || ord == Some(Ordering::Greater) {
			watchlog(
				ex,
				&mut out,
				Event { u: &wtab[w], on: false, now, term: &term },
				&watch,
				&me,
				&fmt,
			)?;
			w += 1;
		} else if w >= wtab.len() || ord == Some(Ordering::Less) {
			watchlog(
				ex,
				&mut out,
				Event { u: &utab[u], on: true, now, term: &term },
				&watch,
				&me,
				&fmt,
			)?;
			u += 1;
		} else {
			u += 1;
			w += 1;
		}
	}
	st.wtab = Some(utab);
	st.lastwatch = now;
	save(ex, &st);
	Ok(out)
}

/// zsh/watch's pre-prompt check (its `checksched`): when the module is
/// loaded and more than `$LOGCHECK` seconds passed since the last check,
/// [`dowatch`]; the text to write to standard output (empty otherwise).
///
/// # Errors
/// A store failure, a parameter error.
pub fn check(ex: &mut Expander<'_, '_>) -> X<Vec<u8>> {
	if !super::zsh_module::loaded(ex.cx.store, ex.vp, b"zsh/watch")? {
		return Ok(Vec::new());
	}
	let last = load(ex)?.lastwatch;
	let logcheck = params::getsparam(ex, b"LOGCHECK")?.map_or(0, |v| params::parse_int(&v));
	let now = ex.cx.host.wall().secs;
	if now.saturating_sub(last) > logcheck {
		return dowatch(ex);
	}
	Ok(Vec::new())
}

/// zsh `bin_log`: report every session as logged on.
pub fn log(ctx: &mut Ctx<'_, '_>) -> R {
	let r = zx(ctx, |ex| {
		let mut st = load(ex)?;
		st.wtab = Some(Vec::new());
		st.lastutmpcheck = 0;
		save(ex, &st);
		dowatch(ex)
	})?;
	match r {
		Ok(out) => {
			ctx.out(&out);
			done(0)
		},
		Err(d) => {
			ctx.diag(d);
			done(1)
		},
	}
}

/// zsh/watch's `boot_`: `$watch` empty, `WATCHFMT` and `LOGCHECK` set to
/// their defaults unless set.
///
/// # Errors
/// A store failure, a parameter error.
pub fn boot(ex: &mut Expander<'_, '_>) -> X<()> {
	// Straight to the stored scalar: `WATCH` is the module's own parameter,
	// which does not exist yet while the module boots.
	state::store_var(
		&mut ex.k.root,
		ex.cx.store,
		ex.vp,
		b"WATCH",
		Some(state::Var::scalar(BString::default(), Attrs::NONE)),
		state::Level::Global,
	);
	if params::getparam(ex, b"WATCHFMT")?.is_none() {
		params::assignsparam(ex, b"WATCHFMT", DEFAULT_WATCHFMT, 0)?;
	}
	if params::getparam(ex, b"LOGCHECK")?.is_none() {
		params::setnparam(ex, b"LOGCHECK", Number::Int(60), b"60", 10)?;
	}
	Ok(())
}

/// The terminal attributes zsh/watch writes with `tsetcap(…, TSC_RAW)`:
/// they go to zsh's `shout`, the terminal of an interactive shell (whose
/// capabilities, `$TERM`'s, the prompt code loads), and nowhere in a
/// non-interactive one. Colours are written in either case.
fn term_caps(ex: &mut Expander<'_, '_>) -> X<TermCaps> {
	let interactive = state::zsh_option(&mut ex.k.root, ex.cx.store, ex.vp, ZshOpt::Interactive)?;
	if !interactive {
		return Ok(TermCaps::default());
	}
	Ok(super::zsh_print::prompt_env_ex(ex, (BString::default(), 0), true, false)?.term)
}

/// One session to report.
#[derive(Clone, Copy)]
struct Event<'a> {
	u:    &'a Login,
	/// Logged on (zsh's `inout`).
	on:   bool,
	/// The check's time: a logout's time.
	now:  i64,
	term: &'a TermCaps,
}

/// zsh `watchlog_match`: `test` as a pattern against `actual`, else (a bad
/// pattern) the same text (`prefix`: `actual` starts with it).
fn watch_match(ex: &mut Expander<'_, '_>, test: &[u8], actual: &[u8], prefix: bool) -> X<bool> {
	let mut t = tok::metafy(test);
	tokenize(&mut t);
	match zpattern::compile(ex, &t, PatFlags::NONE) {
		Ok(pat) => {
			let env = zpattern::char_env(ex)?;
			Ok(pat.matches(&tok::metafy(actual), &env.env()))
		},
		Err(Stop::Fail(_)) => Ok(if prefix {
			actual.starts_with(test)
		} else {
			actual == test
		}),
		Err(e) => Err(e),
	}
}

/// zsh `watchlog`: write `e` when `watch` selects it.
fn watchlog(
	ex: &mut Expander<'_, '_>,
	out: &mut Vec<u8>,
	e: Event<'_>,
	watch: &[BString],
	me: &[u8],
	fmt: &[u8],
) -> X<()> {
	let u = e.u;
	if u.user.is_empty() {
		return Ok(());
	}
	let first = watch.first().map(|w| w.as_slice());
	if first == Some(&b"all"[..]) || (first == Some(&b"notme"[..]) && u.user.as_slice() != me) {
		watchlog2(ex, out, e, fmt, 0, true, None)?;
		return Ok(());
	}
	for v in watch {
		let v = v.as_slice();
		let mut bad = false;
		let mut i = if matches!(v.first(), Some(b'@' | b'%')) {
			0
		} else {
			let end = v
				.iter()
				.position(|&c| c == b'@' || c == b'%')
				.unwrap_or(v.len());
			if !watch_match(ex, &v[..end], &u.user, false)? {
				bad = true;
			}
			end
		};
		loop {
			match v.get(i) {
				Some(b'%') => {
					let start = i + 1;
					let end = v[start..]
						.iter()
						.position(|&c| c == b'@')
						.map_or(v.len(), |p| start + p);
					if !watch_match(ex, &v[start..end], &u.line, false)? {
						bad = true;
					}
					i = end;
				},
				Some(b'@') => {
					let start = i + 1;
					let end = v[start..]
						.iter()
						.position(|&c| c == b'%')
						.map_or(v.len(), |p| start + p);
					// zsh compares `strlen` of the rest of the entry.
					if !watch_match(ex, &v[start..end], &u.host, true)? {
						bad = true;
					}
					i = end;
				},
				_ => break,
			}
		}
		if !bad {
			watchlog2(ex, out, e, fmt, 0, true, None)?;
			return Ok(());
		}
	}
	Ok(())
}

/// zsh `watch3ary`: the `%(x.true.false)` at `fmt[i..]` (after `%(`); the
/// position after it.
fn watch3ary(
	ex: &mut Expander<'_, '_>,
	out: &mut Vec<u8>,
	e: Event<'_>,
	fmt: &[u8],
	mut i: usize,
	prnt: bool,
) -> X<usize> {
	let u = e.u;
	let mut prnt = prnt;
	let truth = match fmt.get(i) {
		Some(b'n') => !u.user.is_empty(),
		Some(b'a') => e.on,
		Some(b'l') => {
			if u.line.starts_with(b"tty") {
				u.line.len() > 3
			} else {
				!u.line.is_empty()
			}
		},
		Some(b'm' | b'M') => !u.host.is_empty(),
		// Unknown conditions are skipped entirely.
		_ => {
			prnt = false;
			true
		},
	};
	i += 1;
	let sep = fmt.get(i).copied();
	i += 1;
	i = watchlog2(ex, out, e, fmt, i, truth && prnt, sep)?;
	watchlog2(ex, out, e, fmt, i, !truth && prnt, Some(b')'))
}

/// zsh `watchlog2`: write `fmt[i..]` for `e` (when `prnt`) up to `fini`
/// (`None`: the end, then a newline); the position after what was read.
#[allow(clippy::too_many_lines, reason = "one arm per escape")]
fn watchlog2(
	ex: &mut Expander<'_, '_>,
	out: &mut Vec<u8>,
	e: Event<'_>,
	fmt: &[u8],
	mut i: usize,
	prnt: bool,
	fini: Option<u8>,
) -> X<usize> {
	let u = e.u;
	let seqs = ColourSeqs::default();
	while let Some(&c) = fmt.get(i) {
		if c == b'\\' {
			i += 1;
			if let Some(&n) = fmt.get(i) {
				if prnt {
					out.push(n);
				}
				i += 1;
			} else if fini.is_some() {
				return Ok(i);
			} else {
				break;
			}
		} else if Some(c) == fini {
			return Ok(i + 1);
		} else if c != b'%' {
			if prnt {
				out.push(c);
			}
			i += 1;
		} else {
			i += 1;
			if fmt.get(i) == Some(&b'(') {
				i = watch3ary(ex, out, e, fmt, i + 1, prnt)?;
				continue;
			}
			if !prnt {
				i += 1;
				continue;
			}
			let Some(&esc) = fmt.get(i) else {
				out.push(b'%');
				break;
			};
			i += 1;
			match esc {
				b'n' => out.extend_from_slice(&u.user),
				b'a' => out.extend_from_slice(if e.on {
					&b"logged on"[..]
				} else {
					b"logged off"
				}),
				b'l' => {
					let line = u.line.as_slice();
					out.extend_from_slice(line.strip_prefix(b"tty").unwrap_or(line));
				},
				b'm' => {
					// Up to the first dot that does not start a number.
					let h = u.host.as_slice();
					let end = (0..h.len())
						.find(|&k| h[k] == b'.' && !h.get(k + 1).is_some_and(u8::is_ascii_digit))
						.unwrap_or(h.len());
					out.extend_from_slice(&h[..end]);
				},
				b'M' => out.extend_from_slice(&u.host),
				b'T' | b't' | b'@' | b'W' | b'w' | b'D' => {
					let tf: Vec<u8> = match esc {
						b'@' | b't' => b"%l:%M%p".to_vec(),
						b'T' => b"%K:%M".to_vec(),
						b'w' => b"%a %f".to_vec(),
						b'W' => b"%m/%d/%y".to_vec(),
						_ => {
							if fmt.get(i) == Some(&b'{') {
								// `%D{format}`, `\` quoting, at most 79 bytes.
								let mut buf = Vec::new();
								let mut k = i + 1;
								let mut n = 79;
								while n > 0 && fmt.get(k).is_some_and(|&c| c != b'}') {
									n -= 1;
									if fmt[k] == b'\\' && k + 1 < fmt.len() {
										k += 1;
									}
									buf.push(fmt[k]);
									k += 1;
								}
								if fmt.get(k) == Some(&b'}') {
									i = k + 1;
									buf
								} else {
									b"%y-%m-%d".to_vec()
								}
							} else {
								b"%y-%m-%d".to_vec()
							}
						},
					};
					let when = if e.on { u.time } else { e.now };
					let buf = ztrftime(ex, &tf, when)?;
					out.extend_from_slice(buf.strip_prefix(b" ").unwrap_or(&buf[..]));
				},
				b'%' => out.push(b'%'),
				b'F' | b'K' => {
					let fg = esc == b'F';
					if fmt.get(i) == Some(&b'{') {
						i += 1;
						let mut s: &[u8] = &fmt[i..];
						let atr = match_colour(Some(&mut s), fg, 0, e.term, None);
						i = fmt.len() - s.len();
						if fmt.get(i) == Some(&b'}') {
							i += 1;
						}
						let none = if fg { TXTNOFGCOLOUR } else { TXTNOBGCOLOUR };
						if atr & (TXT_ERROR | none) == 0
							&& let Some(seq) = colour_sequence(e.term, &seqs, atr, fg)
						{
							out.extend_from_slice(&seq);
						}
					}
				},
				b'f' | b'k' => {
					let (atr, fg) = if esc == b'f' {
						(TXTNOFGCOLOUR, true)
					} else {
						(TXTNOBGCOLOUR, false)
					};
					if let Some(seq) = colour_sequence(e.term, &seqs, atr, fg) {
						out.extend_from_slice(&seq);
					}
				},
				b'S' => out.extend_from_slice(&tsetcap(e.term, Cap::StandoutBeg, false)),
				b's' => out.extend_from_slice(&tsetcap(e.term, Cap::StandoutEnd, false)),
				b'B' => out.extend_from_slice(&tsetcap(e.term, Cap::BoldBeg, false)),
				b'b' => out.extend_from_slice(&tsetcap(e.term, Cap::AllAttrsOff, false)),
				b'U' => out.extend_from_slice(&tsetcap(e.term, Cap::UnderlineBeg, false)),
				b'u' => out.extend_from_slice(&tsetcap(e.term, Cap::UnderlineEnd, false)),
				other => {
					out.push(b'%');
					out.push(other);
				},
			}
		}
	}
	if prnt {
		out.push(b'\n');
	}
	Ok(i)
}
