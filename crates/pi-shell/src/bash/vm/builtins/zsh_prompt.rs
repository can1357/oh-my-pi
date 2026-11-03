//! zsh prompt expansion for `print -P`: a port of zsh 5.9 `prompt.c`
//! `putpromptchar`, `promptpath` and `prompttrunc`, with `utils.c`
//! `finddir` over `$HOME` (the only named directory this engine keeps).
//!
//! Visual attributes (`%B %b %U %u %S %s %F %f %K %k %E`) print nothing:
//! there is no terminal capability database behind the engine, as for a
//! zsh whose `$TERM` has no entry. `%{…%}` contents are copied as they
//! are.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use super::strftime;
use crate::bash::syntax::zsh::tok::{head, span, tail};

/// The shell state prompt escapes read.
#[derive(Clone, Debug, Default)]
pub struct PromptEnv {
	/// `$PWD`.
	pub pwd:        BString,
	/// `$HOME` (`~` in `%~`).
	pub home:       Option<BString>,
	/// `$?`.
	pub lastval:    i32,
	/// Effective uid (`%#`, `%(#…)`, `%(!…)`).
	pub euid:       u32,
	/// Effective gid (`%(g…)`).
	pub egid:       u32,
	/// `%n`.
	pub user:       BString,
	/// `$HOST` (`%m`, `%M`).
	pub host:       Option<BString>,
	/// `$SHLVL` (`%L`).
	pub shlvl:      i64,
	/// `$psvar` (`%v`).
	pub psvar:      Vec<BString>,
	/// Depth of `$funcstack` (`%e`).
	pub depth:      usize,
	/// `$LINENO` (`%i`, `%I`).
	pub lineno:     u32,
	/// zsh's `scriptname` (`%N`, `%x`).
	pub scriptname: BString,
	/// Current time: seconds, nanoseconds, zone offset east of UTC and
	/// zone abbreviation (`%D %T %t %* %w %W`).
	pub now:        (i64, u32, i32, BString),
	/// `PROMPT_PERCENT`.
	pub percent:    bool,
	/// `PROMPT_BANG` (`!` is the history number).
	pub bang:       bool,
}

/// zsh `finddir` for `$HOME`: the length of the home prefix of `p` (at a
/// path boundary), `None` when `p` is not under it.
fn finddir(env: &PromptEnv, p: &[u8]) -> Option<usize> {
	let home = env.home.as_ref()?;
	// `homenode.diff` is 0 for `/`: never abbreviated.
	if home.len() <= 1 || !p.starts_with(home) {
		return None;
	}
	matches!(p.get(home.len()), None | Some(b'/')).then_some(home.len())
}

/// zsh `promptpath`: `p` with `~` for `$HOME` (`tilde`), its last `npath`
/// components (`npath > 0`) or its first `-npath` (`npath < 0`).
fn promptpath(env: &PromptEnv, p: &[u8], npath: i64, tilde: bool, out: &mut Vec<u8>) {
	let modp: Vec<u8> = match finddir(env, p).filter(|_| tilde) {
		Some(n) => [b"~".as_slice(), tail(p, n)].concat(),
		None => p.to_vec(),
	};
	match npath.cmp(&0) {
		std::cmp::Ordering::Greater => {
			let mut n = npath;
			let mut s = modp.len();
			while s > 0 {
				if modp.get(s) == Some(&b'/') {
					n -= 1;
					if n == 0 {
						s += 1;
						break;
					}
				}
				s -= 1;
			}
			if modp.get(s) == Some(&b'/') && s + 1 < modp.len() && s != 0 {
				s += 1;
			}
			out.extend_from_slice(tail(&modp, s.min(modp.len())));
		},
		std::cmp::Ordering::Less => {
			let mut n = npath;
			let mut s = 1;
			while s < modp.len() {
				if modp[s] == b'/' {
					n += 1;
					if n == 0 {
						break;
					}
				}
				s += 1;
			}
			out.extend_from_slice(head(&modp, s.min(modp.len())));
		},
		std::cmp::Ordering::Equal => out.extend_from_slice(&modp),
	}
}

/// The leading decimal number at `fm[*i..]` (zsh `zstrtol(…, 10)`).
fn number(fm: &[u8], i: &mut usize) -> i64 {
	let mut v: i64 = 0;
	while let Some(c) = fm.get(*i).filter(|c| c.is_ascii_digit()) {
		v = v.saturating_mul(10).saturating_add(i64::from(c - b'0'));
		*i += 1;
	}
	v
}

/// zsh's prompt buffer state (`struct buf_vars`) over one format.
struct Prompt<'a> {
	env:        &'a PromptEnv,
	fm:         &'a [u8],
	/// Read position (`bv->fm`).
	i:          usize,
	out:        Vec<u8>,
	/// An active `%<…<` / `%>…>` / `%[…]` truncation width.
	truncwidth: i64,
	/// A `%<<` ended the active truncation: unwind to it.
	stop:       bool,
}

impl Prompt<'_> {
	fn at(&self, i: usize) -> u8 {
		self.fm.get(i).copied().unwrap_or(0)
	}

	/// zsh `putpromptchar(doprint, endchar)`: expand up to `endchar` (0 for
	/// the end); `false` when the format ended first.
	#[expect(clippy::too_many_lines, reason = "one switch, as zsh's putpromptchar")]
	fn put(&mut self, doprint: bool, endchar: u8) -> bool {
		while self.i < self.fm.len() && self.fm[self.i] != endchar {
			if self.stop {
				return true;
			}
			let c = self.fm[self.i];
			if c == b'%' && self.env.percent {
				self.i += 1;
				let mut minus = false;
				if self.at(self.i) == b'-' {
					minus = true;
					self.i += 1;
				}
				let mut arg: i64 = 0;
				if self.at(self.i).is_ascii_digit() {
					arg = number(self.fm, &mut self.i);
					if minus {
						arg = -arg;
					}
				} else if minus {
					arg = -1;
				}
				if self.at(self.i) == b'(' {
					self.i += 1;
					if self.at(self.i).is_ascii_digit() {
						arg = number(self.fm, &mut self.i);
					} else if arg < 0 {
						arg = -arg;
					}
					let test = self.cond_test(self.at(self.i), arg);
					if self.at(self.i) == 0 {
						return false;
					}
					self.i += 1;
					let sep = self.at(self.i);
					if sep == 0 {
						return false;
					}
					self.i += 1;
					let saved = self.truncwidth;
					self.truncwidth = 0;
					let ok = self.put(test == Some(true) && doprint, sep)
						&& {
							self.i += 1;
							self.i < self.fm.len()
						}
						&& self.put(test == Some(false) && doprint, b')');
					self.truncwidth = saved;
					if !ok {
						return false;
					}
					self.i += 1;
					continue;
				}
				if !doprint {
					match self.at(self.i) {
						b'[' => {
							self.i += 1;
							while self.at(self.i).is_ascii_digit() {
								self.i += 1;
							}
							while self.i < self.fm.len() && self.at(self.i) != b']' {
								self.i += 1;
							}
						},
						d @ (b'<' | b'>') => {
							self.i += 1;
							while self.i < self.fm.len() && self.at(self.i) != d {
								self.i += 1;
							}
						},
						b'D' if self.at(self.i + 1) == b'{' => {
							while self.i < self.fm.len() && self.at(self.i) != b'}' {
								self.i += 1;
							}
						},
						_ => {},
					}
					self.i += 1;
					continue;
				}
				let env = self.env;
				match self.at(self.i) {
					b'~' => promptpath(env, &env.pwd, arg, true, &mut self.out),
					b'd' | b'/' => promptpath(env, &env.pwd, arg, false, &mut self.out),
					b'c' | b'.' => {
						promptpath(env, &env.pwd, if arg == 0 { 1 } else { arg }, true, &mut self.out);
					},
					b'C' => {
						promptpath(env, &env.pwd, if arg == 0 { 1 } else { arg }, false, &mut self.out);
					},
					b'N' | b'x' => promptpath(env, &env.scriptname, arg, false, &mut self.out),
					// No history: the history number is 0.
					b'h' | b'!' => self.out.push(b'0'),
					b'j' => self.out.push(b'0'),
					b'M' => {
						if let Some(h) = &env.host {
							self.out.extend_from_slice(h);
						}
					},
					b'm' => {
						if let Some(h) = &env.host {
							let mut arg = if arg == 0 { 1 } else { arg };
							if arg < 0 {
								let mut s = h.len();
								while s > 0 {
									if h[s - 1] == b'.' {
										arg += 1;
										if arg == 0 {
											break;
										}
									}
									s -= 1;
								}
								self.out.extend_from_slice(tail(h, s));
							} else {
								let mut s = 0;
								while s < h.len() {
									if h[s] == b'.' {
										arg -= 1;
										if arg == 0 {
											break;
										}
									}
									s += 1;
								}
								self.out.extend_from_slice(head(h, s));
							}
						}
					},
					// Attributes need terminal capabilities.
					b'S' | b's' | b'B' | b'b' | b'U' | b'u' | b'F' | b'f' | b'K' | b'k' | b'E' => {
						if matches!(self.at(self.i), b'F' | b'K') && self.at(self.i + 1) == b'{' {
							while self.i < self.fm.len() && self.at(self.i) != b'}' {
								self.i += 1;
							}
						}
					},
					d @ (b'[' | b'<' | b'>') => {
						if d == b'[' {
							self.i += 1;
							if self.at(self.i).is_ascii_digit() {
								arg = number(self.fm, &mut self.i);
							}
							self.i -= 1;
						}
						let close = if d == b'[' { b']' } else { d };
						if !self.trunc(arg, d, close, doprint, endchar) {
							return false;
						}
						continue;
					},
					b'{' | b'}' | b'G' => {},
					b't' | b'@' | b'T' | b'*' | b'w' | b'W' | b'D' => {
						let fmt: Vec<u8> = match self.at(self.i) {
							b'T' => b"%K:%M".to_vec(),
							b'*' => b"%K:%M:%S".to_vec(),
							b'w' => b"%a %f".to_vec(),
							b'W' => b"%m/%d/%y".to_vec(),
							b'D' if self.at(self.i + 1) == b'{' => {
								let mut f = Vec::new();
								let mut j = self.i + 2;
								while j < self.fm.len() && self.fm[j] != b'}' {
									if self.fm[j] == b'\\' && j + 1 < self.fm.len() {
										j += 1;
									}
									f.push(self.fm[j]);
									j += 1;
								}
								self.i = if j < self.fm.len() { j } else { j - 1 };
								f
							},
							b'D' => b"%y-%m-%d".to_vec(),
							_ => b"%l:%M%p".to_vec(),
						};
						if !fmt.is_empty() {
							let (secs, _, off, abbr) = &env.now;
							self.out.extend_from_slice(&strftime::format(
								&zsh_time_format(&fmt),
								*secs,
								*off,
								abbr,
							));
						}
					},
					b'n' => self.out.extend_from_slice(&env.user),
					b'l' | b'y' => self.out.extend_from_slice(b"()"),
					b'L' => self.out.extend_from_slice(env.shlvl.to_string().as_bytes()),
					b'?' => self
						.out
						.extend_from_slice(env.lastval.to_string().as_bytes()),
					d @ (b'%' | b')') => self.out.push(d),
					b'#' => self.out.push(if env.euid == 0 { b'#' } else { b'%' }),
					b'v' => {
						let n = i64::try_from(env.psvar.len()).unwrap_or(i64::MAX);
						let arg = match arg.cmp(&0) {
							std::cmp::Ordering::Equal => 1,
							std::cmp::Ordering::Less => arg + n + 1,
							std::cmp::Ordering::Greater => arg,
						};
						if arg > 0
							&& let Some(v) = usize::try_from(arg - 1).ok().and_then(|k| env.psvar.get(k))
						{
							self.out.extend_from_slice(v);
						}
					},
					b'e' => self.out.extend_from_slice(env.depth.to_string().as_bytes()),
					b'i' | b'I' => self
						.out
						.extend_from_slice(env.lineno.to_string().as_bytes()),
					0 => return false,
					_ => {},
				}
			} else if c == b'!' && self.env.bang {
				if doprint {
					if self.at(self.i + 1) == b'!' {
						self.i += 1;
						self.out.push(b'!');
					} else {
						self.out.push(b'0');
					}
				}
			} else if doprint {
				self.out.push(c);
			}
			self.i += 1;
		}
		self.i < self.fm.len()
	}

	/// The test of `%(x.true.false)` (`None`: an unknown test, neither
	/// branch prints).
	fn cond_test(&self, tc: u8, arg: i64) -> Option<bool> {
		let env = self.env;
		Some(match tc {
			b'c' | b'.' | b'~' | b'/' | b'C' => {
				let mut arg = arg;
				let mut ss: &[u8] = &env.pwd;
				if matches!(tc, b'c' | b'.' | b'~')
					&& let Some(n) = finddir(env, ss)
				{
					arg -= 1;
					ss = tail(ss, n);
				}
				if ss.first() == Some(&b'/') && ss.len() > 1 {
					arg -= 1;
				}
				let rest = ss.get(1..).unwrap_or_default();
				#[allow(
					clippy::naive_bytecount,
					reason = "one path per prompt escape; no bytecount dependency"
				)]
				let slashes = rest.iter().filter(|&&c| c == b'/').count();
				arg -= i64::try_from(slashes).unwrap_or(0);
				arg <= 0
			},
			b'?' => i64::from(env.lastval) == arg,
			b'#' => i64::from(env.euid) == arg,
			b'g' => i64::from(env.egid) == arg,
			b'j' => 0 >= arg,
			b'e' => i64::try_from(env.depth).unwrap_or(i64::MAX) >= arg,
			b'L' => env.shlvl >= arg,
			b'v' => i64::try_from(env.psvar.len()).unwrap_or(0) >= arg,
			b'V' => {
				let k = usize::try_from(if arg == 0 { 1 } else { arg }).unwrap_or(1) - 1;
				i64::try_from(env.psvar.len()).unwrap_or(0) >= arg
					&& env.psvar.get(k).is_some_and(|v| !v.is_empty())
			},
			b'_' => 0 >= arg,
			b'!' => env.euid == 0,
			_ => return None,
		})
	}

	/// zsh `prompttrunc`: `%N<str<`, `%N>str>`, `%N[str]`: what follows
	/// (to the end of this level) is cut to `arg` characters, `str`
	/// marking the cut.
	fn trunc(&mut self, arg: i64, ch: u8, close: u8, doprint: bool, endchar: u8) -> bool {
		self.i += 1;
		let mut s = Vec::new();
		while self.i < self.fm.len() && self.fm[self.i] != close {
			if self.fm[self.i] == b'\\' && self.i + 1 < self.fm.len() {
				self.i += 1;
			}
			s.push(self.fm[self.i]);
			self.i += 1;
		}
		if self.i >= self.fm.len() {
			return false;
		}
		self.i += 1;
		if arg <= 0 {
			// `%<<`: ends the active truncation here.
			if self.truncwidth > 0 {
				self.stop = true;
			}
			return true;
		}
		if s.is_empty() && close == b']' {
			s.push(b'<');
		}
		let left = ch == b'<' || ch == b'[';
		let start = self.out.len();
		let saved = self.truncwidth;
		self.truncwidth = arg;
		self.put(doprint, endchar);
		self.truncwidth = saved;
		self.stop = false;
		let text: Vec<u8> = self.out.split_off(start);
		let chars = chars_of(&text);
		let width = usize::try_from(arg).unwrap_or(usize::MAX);
		if chars.len() <= width {
			self.out.extend_from_slice(&text);
			return true;
		}
		let tw = s.len();
		if tw >= width {
			self.out.extend_from_slice(&s);
			return true;
		}
		let keep = width - tw;
		if left {
			self.out.extend_from_slice(&s);
			for c in tail(&chars, chars.len() - keep) {
				self.out.extend_from_slice(c);
			}
		} else {
			for c in head(&chars, keep) {
				self.out.extend_from_slice(c);
			}
			self.out.extend_from_slice(&s);
		}
		true
	}
}

/// `s` split into characters (UTF-8 sequences; an invalid byte alone).
fn chars_of(s: &[u8]) -> Vec<&[u8]> {
	let mut v = Vec::new();
	let mut i = 0;
	while i < s.len() {
		let n = bstr::decode_utf8(tail(s, i)).1.max(1);
		v.push(span(s, i, i + n));
		i += n;
	}
	v
}

/// zsh's `ztrftime` extensions over C's: `%K` (hour, space padded, 24h),
/// `%L` (hour, 12h, space padded) and `%f` (day, no padding) map to the
/// engine's `strftime` (`%k`, `%l`, `%-d`).
fn zsh_time_format(fmt: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(fmt.len());
	let mut i = 0;
	while i < fmt.len() {
		if fmt[i] == b'%' && i + 1 < fmt.len() {
			match fmt[i + 1] {
				b'K' => out.extend_from_slice(b"%k"),
				b'L' => out.extend_from_slice(b"%l"),
				b'f' => out.extend_from_slice(b"%-d"),
				c => {
					out.push(b'%');
					out.push(c);
				},
			}
			i += 2;
			continue;
		}
		out.push(fmt[i]);
		i += 1;
	}
	out
}

/// zsh `promptexpand(s, 0, NULL, NULL, NULL)`: `s` with its prompt
/// escapes expanded.
pub fn promptexpand(s: &[u8], env: &PromptEnv) -> Vec<u8> {
	let mut e =
		Prompt { env, fm: s, i: 0, out: Vec::with_capacity(s.len()), truncwidth: 0, stop: false };
	e.put(true, 0);
	e.out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn env() -> PromptEnv {
		PromptEnv {
			pwd: "/home/u/src/proj".into(),
			home: Some("/home/u".into()),
			lastval: 3,
			user: "u".into(),
			host: Some("box.example.org".into()),
			shlvl: 2,
			euid: 1000,
			percent: true,
			..PromptEnv::default()
		}
	}

	fn p(s: &str) -> String {
		String::from_utf8(promptexpand(s.as_bytes(), &env())).unwrap()
	}

	#[test]
	fn paths_and_home_abbreviation() {
		assert_eq!(p("%~"), "~/src/proj");
		assert_eq!(p("%/"), "/home/u/src/proj");
		assert_eq!(p("%c"), "proj");
		assert_eq!(p("%2~"), "src/proj");
		assert_eq!(p("%-1/"), "/home");
	}

	#[test]
	fn simple_escapes_and_conditionals() {
		assert_eq!(p("%n@%m %? %L %% %#"), "u@box 3 2 % %");
		assert_eq!(p("%(?.ok.fail %?)"), "fail 3");
		assert_eq!(p("%(3?.three.other)"), "three");
		assert_eq!(p("%M"), "box.example.org");
	}

	#[test]
	fn truncation() {
		assert_eq!(p("%5<..<abcdefgh"), "..fgh");
		assert_eq!(p("%5>..>abcdefgh"), "abc..");
		assert_eq!(p("%10<..<short"), "short");
	}
}
