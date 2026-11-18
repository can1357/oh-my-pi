//! zsh 5.9's spelling correction of one word (`Src/utils.c`: `spckword`,
//! `spscan`, `spname`, `mindist`, `spdist`) as `spell-word` uses it
//! (`spckword(&x, 0, lincmd, 0)`: no history update, no question asked).
//!
//! The file-system questions (`access`, `stat`, `opendir`, the `$PATH`
//! search of `hashcmd`) go to the host as probes: the correction runs
//! again from the start once an answer is in (it is a pure function of
//! the answers), the editor waiting meanwhile.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use bstr::BString;
use strum::IntoEnumIterator;

use super::expand::{quiet_error, run};
use crate::bash::{
	fs::StatKind,
	ids::{Dialect, IntrinsicId},
	pattern::zsh::{PatFlags, Pattern, remnulargs, tokenize},
	store::{KeyBuf, Record, Table},
	syntax::zsh::{
		iident,
		tok::{DASH, EQUALS, STRING, TILDE, at, is_tok, metafy, unmetafy},
	},
	vm::{
		fsprobe::{FsAns, FsReq},
		probe,
		proc::{Probe, ProbeResult, Scratch},
		state,
		zle::exec::{Await, WResult, Zw, then},
		zsh::{nameddir, params, subst, zpattern},
	},
	zshopt::ZshOpt,
};

/// What [`spckword`] hands on: the word, corrected or not.
pub type SpK = Box<dyn FnOnce(&mut Zw<'_, '_>, Vec<u8>) -> WResult + Send>;

/// The hash tables `spckword` scans (metafied names).
#[derive(Default)]
struct Tables {
	params:   Vec<Vec<u8>>,
	aliases:  Vec<Vec<u8>>,
	cmdnam:   Vec<Vec<u8>>,
	funcs:    Vec<Vec<u8>>,
	builtins: Vec<Vec<u8>>,
	reswds:   Vec<Vec<u8>>,
}

/// zsh's reserved words (`reswds`).
const RESWDS: &[&str] = &[
	"!",
	"[[",
	"{",
	"}",
	"case",
	"coproc",
	"declare",
	"do",
	"done",
	"elif",
	"else",
	"end",
	"esac",
	"export",
	"fi",
	"float",
	"for",
	"foreach",
	"function",
	"if",
	"integer",
	"local",
	"nocorrect",
	"readonly",
	"repeat",
	"select",
	"then",
	"time",
	"typeset",
	"until",
	"while",
];

/// Everything the file-system part of `spckword` needs.
struct Job {
	s:         Vec<u8>,
	cmd:       bool,
	t:         usize,
	guess:     Vec<u8>,
	ic:        u8,
	preflen:   usize,
	tables:    Arc<Tables>,
	spckpat:   Option<Arc<Pattern>>,
	spnamepat: Option<Arc<Pattern>>,
	env:       zpattern::CharEnvBuf,
	path:      Vec<BString>,
	hashlist:  bool,
	autocd:    bool,
	cdable:    bool,
	cdpath:    Vec<Vec<u8>>,
	dvorak:    bool,
	cwd:       BString,
	/// The `branch` of zsh's code: `$name`, `=cmd`, or a word.
	kind:      Kind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	Param,
	Equals,
	Word,
}

/// zsh `spckword(s, 0, cmd, 0)`: the word `s` (metafied, tokenized)
/// corrected to the nearest name zsh knows (a file along its path, a
/// parameter for `$name`, a command for `=cmd` and in command position),
/// then `k` with it.
pub fn spckword(zw: &mut Zw<'_, '_>, mut s: Vec<u8>, cmd: bool, k: SpK) -> WResult {
	if s.len() < 2 {
		return k(zw, s);
	}
	if if cmd {
		s[0] == b'%'
	} else {
		s[0] == b'-' || s[0] == DASH
	} {
		return k(zw, s);
	}
	if s == b"in" {
		return k(zw, s);
	}
	let tables = match load_tables(zw) {
		Ok(t) => Arc::new(t),
		Err(e) => {
			zw.fail(e);
			return k(zw, s);
		},
	};
	if cmd {
		let known = |v: &Vec<Vec<u8>>| v.contains(&s);
		if known(&tables.funcs)
			|| known(&tables.builtins)
			|| known(&tables.cmdnam)
			|| known(&tables.aliases)
			|| known(&tables.reswds)
		{
			return k(zw, s);
		}
	}
	let mut t = usize::from(matches!(s[0], TILDE | EQUALS | STRING));
	while t < s.len() {
		if is_tok(s[t]) {
			if s[t] == DASH {
				s[t] = b'-';
			} else {
				return k(zw, s);
			}
		}
		t += 1;
	}
	let t = s.iter().position(|&c| c == b'/').unwrap_or(s.len());
	if s[0] == TILDE && t == s.len() {
		return k(zw, s);
	}
	let spckpat = ignore_pattern(zw, b"CORRECT_IGNORE");
	let spnamepat = ignore_pattern(zw, b"CORRECT_IGNORE_FILE");
	let env = match zw.params(zpattern::char_env) {
		Ok(e) => e,
		Err(stop) => {
			quiet_error(zw, stop);
			return k(zw, s);
		},
	};
	let path = zw.getaparam(b"path").unwrap_or_default();
	let cdpath = zw
		.getaparam(b"cdpath")
		.unwrap_or_default()
		.into_iter()
		.map(|d| d.to_vec())
		.collect();
	let autocd = cmd && zw.isset(ZshOpt::Autocd) && s != b"." && s != b"..";
	let mut job = Job {
		s,
		cmd,
		t,
		guess: Vec::new(),
		ic: 0,
		preflen: 0,
		tables,
		spckpat,
		spnamepat,
		env,
		path,
		hashlist: zw.isset(ZshOpt::Hashlistall),
		autocd,
		cdable: false,
		cdpath,
		dvorak: zw.isset(ZshOpt::Dvorak),
		cwd: zw.vp.cwd.clone(),
		kind: Kind::Word,
	};
	if job.s[0] == STRING && t == job.s.len() {
		job.guess = job.s[1..].to_vec();
		if !iident(at(&job.guess, 0)) {
			return k(zw, job.s);
		}
		job.ic = STRING;
		job.kind = Kind::Param;
		return fs_part(zw, Box::default(), job, k);
	}
	if job.s[0] == EQUALS {
		if t < job.s.len() {
			return k(zw, job.s);
		}
		job.guess = job.s[1..].to_vec();
		job.ic = EQUALS;
		job.kind = Kind::Equals;
		return fs_part(zw, Box::default(), job, k);
	}
	job.guess.clone_from(&job.s);
	if matches!(job.s[0], TILDE | STRING) {
		job.ic = job.s[0];
		job.t += 1;
		if job.t >= job.s.len() {
			return k(zw, job.s);
		}
		let guess = job.guess.clone();
		return run::<Vec<u8>, _>(
			zw,
			Box::default(),
			move |ex| subst::singsub(ex, guess.clone()),
			Box::new(move |zw, sc, r| match r {
				Ok(g) => {
					let rest = job.s.len() - job.t;
					job.preflen = g.len().saturating_sub(rest);
					job.guess = g;
					word_part(zw, sc, job, k)
				},
				Err(stop) => {
					quiet_error(zw, stop);
					k(zw, job.s)
				},
			}),
		);
	}
	word_part(zw, Box::default(), job, k)
}

/// The `cd_able_vars` check of the autocd branch, then the file-system
/// part.
fn word_part(zw: &mut Zw<'_, '_>, sc: Box<Scratch>, mut job: Job, k: SpK) -> WResult {
	if job.autocd && job.t == job.s.len() && zw.isset(ZshOpt::Cdablevars) {
		let g = job.guess.clone();
		let rest = g.iter().position(|&c| c == b'/').unwrap_or(g.len());
		let name = g[..rest].to_vec();
		job.cdable = match zw.params(|ex| nameddir::getnameddir(ex, &name)) {
			Ok(d) => d.is_some(),
			Err(stop) => {
				quiet_error(zw, stop);
				false
			},
		};
	}
	fs_part(zw, sc, job, k)
}

/// The rest of `spckword`, over the host's file-system answers.
fn fs_part(zw: &mut Zw<'_, '_>, mut sc: Box<Scratch>, job: Job, k: SpK) -> WResult {
	loop {
		let res = {
			let sc_ref = &sc;
			let mut look = |p: &Probe| probe::cached(sc_ref, p).cloned();
			correct(&job, &mut look)
		};
		match res {
			Ok(s) => return k(zw, s),
			Err(p) => {
				if let Err(key) = probe::perform(zw.k, zw.cx, zw.vp, &mut sc, &p) {
					return then(Await::Wait(key), move |zw, _| fs_part(zw, sc, job, k));
				}
			},
		}
	}
}

/// The tables `spckword` and `spscan` read.
fn load_tables(zw: &mut Zw<'_, '_>) -> Result<Tables, crate::bash::store::StoreError> {
	let mut t = Tables::default();
	let (root, store, vp) = (&zw.k.root, &mut *zw.cx.store, &*zw.vp);
	for (key, _) in state::scan(root, store, vp, Table::Func)? {
		if let KeyBuf::Func(n) = key {
			t.funcs.push(metafy(&n));
		}
	}
	for (key, _) in state::scan(root, store, vp, Table::Alias)? {
		if let KeyBuf::Alias(n) = key {
			t.aliases.push(metafy(&n));
		}
	}
	for (key, _) in state::scan(root, store, vp, Table::ZshAlias)? {
		if let KeyBuf::ZshAlias { suffix: false, name } = key {
			t.aliases.push(metafy(&name));
		}
	}
	for (key, rec) in state::scan(root, store, vp, Table::CmdHash)? {
		if let (KeyBuf::CmdHash(n), Record::CmdHash { .. }) = (key, rec) {
			t.cmdnam.push(metafy(&n));
		}
	}
	t.builtins.push(b"-".to_vec());
	t.builtins.push(b"noglob".to_vec());
	for id in IntrinsicId::iter().filter(|id| id.available_in(Dialect::Zsh)) {
		if crate::bash::vm::builtins::zsh_module::builtin_state(store, vp, id)?.is_some() {
			t.builtins
				.push(<&'static str>::from(id).as_bytes().to_vec());
		}
	}
	let aliases = crate::bash::vm::builtins::alias_table(zw.k, zw.cx, zw.vp)?;
	for w in RESWDS {
		let off = aliases
			.as_ref()
			.is_some_and(|a| crate::bash::syntax::AliasLookup::reserved_disabled(a, w.as_bytes()));
		if !off {
			t.reswds.push(w.as_bytes().to_vec());
		}
	}
	t.params = match zw.params(params::scan_names) {
		Ok(names) => names.into_iter().map(|n| n.to_vec()).collect(),
		Err(crate::bash::vm::expand::Stop::Store(e)) => return Err(e),
		Err(_) => Vec::new(),
	};
	Ok(t)
}

/// `$CORRECT_IGNORE`/`$CORRECT_IGNORE_FILE` compiled (tokenized first).
fn ignore_pattern(zw: &mut Zw<'_, '_>, name: &[u8]) -> Option<Arc<Pattern>> {
	let mut text = zw.getsparam(name)?.to_vec();
	tokenize(&mut text);
	remnulargs(&mut text);
	zw.params(|ex| zpattern::try_compile(ex, &text, PatFlags::default()))
		.ok()
		.flatten()
}

/// A file-system answer, or the probe to ask first.
type Ans<T> = Result<T, Probe>;

/// The host's answers so far.
struct Fs<'a> {
	look: &'a mut dyn FnMut(&Probe) -> Option<ProbeResult>,
	cwd:  &'a [u8],
}

impl Fs<'_> {
	/// `stat(path)` (raw bytes): whether it exists, and is a directory.
	fn stat(&mut self, path: &[u8]) -> Ans<Option<bool>> {
		let p = Probe::Stat { path: probe::absolute(self.cwd, path), follow: true };
		match (self.look)(&p) {
			Some(ProbeResult::Stat(st)) => Ok(st.map(|st| st.kind == StatKind::Dir)),
			Some(_) => Ok(None),
			None => Err(p),
		}
	}

	/// `opendir`+`readdir` (raw bytes): the names, `None` when it cannot
	/// be read.
	fn readdir(&mut self, path: &[u8]) -> Ans<Option<Vec<BString>>> {
		let p = Probe::Fs {
			seq: 0,
			req: Box::new(FsReq::ReadDir { path: probe::absolute(self.cwd, path) }),
		};
		match (self.look)(&p) {
			Some(ProbeResult::Fs(Ok(FsAns::Names(n)))) => Ok(Some(n)),
			Some(_) => Ok(None),
			None => Err(p),
		}
	}

	/// The `$PATH` search of zsh `hashcmd`.
	fn pathsearch(&mut self, name: &[u8], path: &[BString]) -> Ans<bool> {
		let mut joined = Vec::new();
		for (i, d) in path.iter().enumerate() {
			if i > 0 {
				joined.push(b':');
			}
			joined.extend_from_slice(&unmetafy(d));
		}
		let p = Probe::Path { name: BString::from(name), path: BString::from(joined) };
		match (self.look)(&p) {
			Some(ProbeResult::Path(found)) => Ok(found.is_some()),
			Some(_) => Ok(false),
			None => Err(p),
		}
	}
}

/// zsh `pattry` of an ignore pattern on a metafied name.
fn ignored(pat: Option<&Arc<Pattern>>, env: &zpattern::CharEnvBuf, name: &[u8]) -> bool {
	pat.is_some_and(|p| p.matches(name, &env.env()))
}

/// The part of zsh `spckword` after the cheap checks: the best name for
/// `job.guess`, and the word corrected with it.
fn correct(job: &Job, look: &mut dyn FnMut(&Probe) -> Option<ProbeResult>) -> Ans<Vec<u8>> {
	let mut fs = Fs { look, cwd: &job.cwd };
	let s = &job.s;
	let guess = &job.guess;
	let mut d = 100;
	let mut best: Option<Vec<u8>> = None;
	let spscan = |names: &[Vec<u8>], d: &mut i32, best: &mut Option<Vec<u8>>| {
		for n in names {
			if ignored(job.spckpat.as_ref(), &job.env, n) {
				continue;
			}
			let nd = spdist(n, guess, guess.len() as i32 / 4 + 1, job.dvorak);
			if nd <= *d {
				*best = Some(n.clone());
				*d = nd;
			}
		}
	};
	match job.kind {
		Kind::Param => spscan(&job.tables.params[..], &mut d, &mut best),
		Kind::Equals => {
			if job.tables.cmdnam.iter().any(|n| n == guess)
				|| fs.pathsearch(&unmetafy(guess), &job.path)?
			{
				return Ok(s.clone());
			}
			spscan(&job.tables.aliases[..], &mut d, &mut best);
			spscan(&job.tables.cmdnam[..], &mut d, &mut best);
		},
		Kind::Word => {
			if fs.stat(&unmetafy(guess))?.is_some() {
				return Ok(s.clone());
			}
			best = spname(&mut fs, guess, job)?;
			if job.ic == 0 && job.t == s.len() && job.cmd {
				if job.tables.cmdnam.iter().any(|n| n == guess)
					|| fs.pathsearch(&unmetafy(guess), &job.path)?
				{
					return Ok(s.clone());
				}
				d = 100;
				spscan(&job.tables.reswds[..], &mut d, &mut best);
				spscan(&job.tables.aliases[..], &mut d, &mut best);
				spscan(&job.tables.funcs[..], &mut d, &mut best);
				spscan(&job.tables.builtins[..], &mut d, &mut best);
				let mut cmdnam = job.tables.cmdnam.clone();
				if job.hashlist {
					for dir in &job.path {
						if dir.first() != Some(&b'/') {
							continue;
						}
						if let Some(names) = fs.readdir(&unmetafy(dir))? {
							for n in names {
								let n = metafy(&n);
								if !cmdnam.contains(&n) {
									cmdnam.push(n);
								}
							}
						}
					}
				}
				spscan(&cmdnam[..], &mut d, &mut best);
				if job.autocd {
					if job.cdable {
						return Ok(s.clone());
					}
					for pp in &job.cdpath {
						let (thisdist, bestcd) = mindist(&mut fs, pp, s, true, job)?;
						if thisdist < d {
							best = Some(bestcd);
							d = thisdist;
						}
					}
				}
			}
		},
	}
	let Some(mut best) = best else {
		return Ok(s.clone());
	};
	if best.len() <= 1 || best == *guess {
		return Ok(s.clone());
	}
	if job.ic != 0 {
		if job.preflen > 0 {
			if guess.get(..job.preflen) != best.get(..job.preflen) {
				return Ok(s.clone());
			}
			let mut u = s[..job.t.min(s.len())].to_vec();
			u.extend_from_slice(best.get(job.preflen..).unwrap_or_default());
			best = u;
		} else {
			let mut u = vec![0];
			u.extend_from_slice(&best);
			best = u;
		}
		best[0] = job.ic;
	}
	Ok(best)
}

/// zsh `spname`: correct each directory component of `oldname`
/// (metafied) in turn; `None` when the first cannot be.
fn spname(fs: &mut Fs<'_>, oldname: &[u8], job: &Job) -> Ans<Option<Vec<u8>>> {
	let mut new: Vec<u8> = Vec::new();
	let mut old = 0;
	let (mut bestdist, mut maxthresh) = (0, 0);
	loop {
		while at(oldname, old) == b'/' {
			new.push(b'/');
			old += 1;
		}
		if old >= oldname.len() {
			return Ok(Some(new));
		}
		let start = old;
		while old < oldname.len() && oldname[old] != b'/' {
			old += 1;
		}
		let guess = oldname[start..old].to_vec();
		let thresh = (guess.len() as i32 / 4 + 1).clamp(3, 100);
		let (thisdist, best) = mindist(fs, &new, &guess, at(oldname, old) == b'/', job)?;
		if thisdist >= thresh {
			if bestdist < maxthresh {
				new.extend_from_slice(&guess);
				new.extend_from_slice(&oldname[old..]);
				return Ok(Some(new));
			}
			return Ok(None);
		}
		maxthresh = bestdist + thresh;
		bestdist += thisdist;
		new.extend_from_slice(&best);
	}
}

/// zsh `mindist`: the entry of `dir` nearest to `guess` (metafied) and
/// its distance (100: none near).
fn mindist(
	fs: &mut Fs<'_>,
	dir: &[u8],
	guess: &[u8],
	wantdir: bool,
	job: &Job,
) -> Ans<(i32, Vec<u8>)> {
	let dir: &[u8] = if dir.is_empty() { b"." } else { dir };
	let join = |name: &[u8]| -> Vec<u8> {
		let mut b = unmetafy(dir);
		b.push(b'/');
		b.extend_from_slice(&unmetafy(name));
		b
	};
	if let Some(isdir) = fs.stat(&join(guess))?
		&& (!wantdir || isdir)
	{
		return Ok((0, guess.to_vec()));
	}
	let mut d = 100;
	let mut best = Vec::new();
	if let Some(names) = fs.readdir(&unmetafy(dir))? {
		for fname in names {
			let fname = metafy(&fname);
			if ignored(job.spnamepat.as_ref(), &job.env, &fname) {
				continue;
			}
			let nd = spdist(&fname, guess, guess.len() as i32 / 4 + 1, job.dvorak);
			if nd <= d {
				if wantdir && fs.stat(&join(&fname))? != Some(true) {
					continue;
				}
				best = fname;
				d = nd;
				if d == 0 {
					break;
				}
			}
		}
	}
	Ok((d, best))
}

/// zsh's keyboard maps for `spdist` (rows of 14 with `\t`/`\n` padding).
const QWERTY: &[u8] = b"\n\n\n\n\n\n\n\n\n\n\n\n\n\n\t1234567890-=\t\tqwertyuiop[]\t\tasdfghjkl;'\n\t\tzxcvbnm,./\t\t\t\n\n\n\n\n\n\n\n\n\n\n\n\n\n\t!@#$%^&*()_+\t\tQWERTYUIOP{}\t\tASDFGHJKL:\"\n\t\tZXCVBNM<>?\n\n\t\n\n\n\n\n\n\n\n\n\n\n\n\n\n";
const DVORAK: &[u8] = b"\n\n\n\n\n\n\n\n\n\n\n\n\n\n\t1234567890[]\t\t',.pyfgcrl/=\t\taoeuidhtns-\n\t\t;qjkxbmwvz\t\t\t\n\n\n\n\n\n\n\n\n\n\n\n\n\n\t!@#$%^&*(){}\t\t\"<>PYFGCRL?+\t\tAOEUIDHTNS_\n\t\t:QJKXBMWVZ\n\n\t\n\n\n\n\n\n\n\n\n\n\n\n\n\n";

/// zsh `spdist`: the typing distance from `s` to `t` (0 equal, 1 case,
/// 2 a transposition or missing letter, …; 200 beyond `thresh`).
pub fn spdist(s: &[u8], t: &[u8], thresh: i32, dvorak: bool) -> i32 {
	let keymap = if dvorak { DVORAK } else { QWERTY };
	if s == t {
		return 0;
	}
	let (mut p, mut q) = (0, 0);
	while p < s.len() && at(s, p).eq_ignore_ascii_case(&at(t, q)) {
		p += 1;
		q += 1;
	}
	if p >= s.len() && q >= t.len() {
		return 1;
	}
	if thresh == 0 {
		return 200;
	}
	let (mut p, mut q) = (0, 0);
	while p < s.len() && q < t.len() {
		let (sp, tq) = (s[p], t[q]);
		if sp == tq {
			p += 1;
			q += 1;
			continue;
		} else if at(s, p + 1) == tq && at(t, q + 1) == sp {
			return spdist(
				s.get(p + 2..).unwrap_or_default(),
				t.get(q + 2..).unwrap_or_default(),
				thresh - 1,
				dvorak,
			) + 1;
		} else if at(s, p + 1) == tq {
			return spdist(&s[p + 1..], &t[q..], thresh - 1, dvorak) + 2;
		} else if sp == at(t, q + 1) {
			return spdist(&s[p..], &t[q + 1..], thresh - 1, dvorak) + 2;
		}
		break;
	}
	if (p >= s.len() && t.len() - q.min(t.len()) == 1)
		|| (q >= t.len() && s.len() - p.min(s.len()) == 1)
	{
		return 2;
	}
	let (mut p, mut q) = (0, 0);
	while p < s.len() && q < t.len() {
		let (sp, tq) = (s[p], t[q]);
		if sp != tq && at(s, p + 1) == at(t, q + 1) {
			// A mistyped letter: a neighbouring key costs less.
			let Some(t0) = keymap
				.iter()
				.position(|&c| c == sp)
				.filter(|&i| !matches!(keymap[i], b'\n' | b'\t'))
			else {
				return spdist(&s[p + 1..], &t[q + 1..], thresh - 1, dvorak) + 1;
			};
			let near = |off: isize| -> bool {
				let i = t0 as isize + off;
				i >= 0 && keymap.get(i as usize) == Some(&tq)
			};
			if near(-15)
				|| near(-14)
				|| near(-13)
				|| near(-1)
				|| near(1)
				|| near(13)
				|| near(14)
				|| near(15)
			{
				return spdist(&s[p + 1..], &t[q + 1..], thresh - 1, dvorak) + 2;
			}
			return 200;
		} else if sp != tq {
			break;
		}
		p += 1;
		q += 1;
	}
	200
}

#[cfg(test)]
pub(super) fn spdist_for_tests(s: &str, t: &str) -> i32 {
	spdist(s.as_bytes(), t.as_bytes(), s.len() as i32 / 4 + 1, false)
}
