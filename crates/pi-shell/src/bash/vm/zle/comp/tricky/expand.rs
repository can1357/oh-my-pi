//! `zle_tricky.c`'s expansion of the word on the line (`doexpansion`): zsh
//! `prefork` and `globlist` (with `NULL_GLOB`) on the word, run from native
//! editor code as an op would run them: command substitutions run in
//! child vprocs (or, for expansion hooks, as frames of the editing vproc)
//! and file-system questions go to the host, the expansion parking until
//! the answer is there and then replaying from its log.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use super::{COMP_EXPAND, COMP_EXPAND_COMPLETE, COMP_LIST_EXPAND, quote_opts, quotename};
use crate::bash::{
	diag::Diag,
	pattern::zsh::{haswilds, remnulargs},
	syntax::zsh::tok::{DNULL, SNULL, TILDE, metafy, unmetafy, untokenize},
	vm::{
		exec::{Flow, settle_probe, settle_sub, start_zsh_sub},
		expand::{Expander, Stop, X},
		proc::{Scratch, Slot},
		state,
		zle::{
			comp::K,
			exec::{Await, WResult, Zw, then},
			widgets::named,
		},
		zsh::{
			subst::{List, filesubstr, prefork},
			zglob, zpattern,
		},
	},
	zshopt::ZshOpt,
};

/// The rest of an expansion run through [`run`]: its scratch back and
/// what the expansion gave.
pub type ExK<T> = Box<dyn FnOnce(&mut Zw<'_, '_>, Box<Scratch>, Result<T, Stop>) -> WResult + Send>;

/// Run the zsh expansion `f` from native editor code: its command
/// substitutions and probes run first (the editor waits, then `f` runs
/// again and replays them from the log in `sc`), then `k` gets the
/// result. Errors come back as they are (zsh's `noerrs`: the caller
/// decides what to report).
pub fn run<T, F>(zw: &mut Zw<'_, '_>, mut sc: Box<Scratch>, mut f: F, k: ExK<T>) -> WResult
where
	T: 'static,
	F: FnMut(&mut Expander<'_, '_>) -> X<T> + Send + 'static,
{
	loop {
		if let Some(flow) = settle_sub(zw.k, zw.vp, zw.cx, &mut sc, Slot::Builtin) {
			return match flow {
				Flow::Block(key) => then(Await::Wait(key), move |zw, _| run(zw, sc, f, k)),
				_ => k(
					zw,
					sc,
					Err(Stop::Fail(Diag::Unsupported {
						what: "a command substitution flow in a ZLE expansion".into(),
					})),
				),
			};
		}
		let mut log = std::mem::take(&mut sc.logs[Slot::Builtin as usize]);
		let r = {
			let mut ex = Expander::new(zw.k, zw.cx, zw.vp, &mut log, true, 0);
			crate::bash::vm::zsh::subst::begin_pass(&mut ex).and_then(|()| f(&mut ex))
		};
		sc.logs[Slot::Builtin as usize] = log;
		match r {
			Ok(v) => {
				sc.recycle();
				return k(zw, sc, Ok(v));
			},
			Err(Stop::ZshSub { text, here }) => {
				let depth = zw.vp.frames.len();
				match start_zsh_sub(zw.k, zw.vp, zw.cx, &mut sc, &text, here, 0) {
					Flow::Block(key) => return then(Await::Wait(key), move |zw, _| run(zw, sc, f, k)),
					Flow::Call => return then(Await::Frame { depth }, move |zw, _| run(zw, sc, f, k)),
					_ => {
						return k(
							zw,
							sc,
							Err(Stop::Fail(Diag::Unsupported {
								what: "a command substitution flow in a ZLE expansion".into(),
							})),
						);
					},
				}
			},
			Err(Stop::Probe(p)) => {
				match settle_probe(zw.k, zw.cx, zw.vp, &mut sc, Slot::Builtin, &p) {
					Ok(()) => {},
					Err(key) => return then(Await::Wait(key), move |zw, _| run(zw, sc, f, k)),
				}
			},
			Err(Stop::Wait(key)) => return then(Await::Wait(key), move |zw, _| run(zw, sc, f, k)),
			Err(stop) => {
				sc.recycle();
				return k(zw, sc, Err(stop));
			},
		}
	}
}

/// A failed expansion under zsh's `noerrs`: nothing is printed; a store
/// failure still goes to the kernel.
pub fn quiet_error(zw: &mut Zw<'_, '_>, stop: Stop) {
	if let Stop::Store(e) = stop {
		zw.fail(e);
	}
}

/// What [`globlist`] hands on: the words, `None` after an error.
type GlobK = Box<dyn FnOnce(&mut Zw<'_, '_>, Box<Scratch>, Option<Vec<Vec<u8>>>) -> WResult + Send>;

/// zsh `globlist(vl, PREFORK_NO_UNTOK)` with `NULL_GLOB` set: every word
/// with active wildcards replaced by its matches (metafied), the others
/// left tokenized. The glob walk runs on the scratch `sc`, put in the
/// top frame's place while it runs (zsh's walk keeps its state there).
fn globlist(zw: &mut Zw<'_, '_>, mut sc: Box<Scratch>, nodes: Vec<Vec<u8>>, k: GlobK) -> WResult {
	let globbing = zw.isset(ZshOpt::Glob);
	let popts = match zw.params(zpattern::opts) {
		Ok(o) => o,
		Err(stop) => {
			quiet_error(zw, stop);
			return k(zw, sc, None);
		},
	};
	let mut items: Vec<BString> = Vec::with_capacity(nodes.len());
	let mut globs: Vec<(u32, BString)> = Vec::new();
	for (i, w) in nodes.iter().enumerate() {
		let mut probe = w.clone();
		if globbing && haswilds(&mut probe, &popts) {
			globs.push((u32::try_from(i).unwrap_or(u32::MAX), BString::from(probe)));
			items.push(BString::from("*"));
		} else {
			// No file name is empty: the words that stay are told from
			// the matches by this.
			items.push(BString::default());
		}
	}
	if globs.is_empty() {
		return k(zw, sc, Some(nodes));
	}
	let Some(fi) = zw.vp.frames.len().checked_sub(1) else {
		zw.k.diag(zw.cx, zw.vp, 0, Diag::Unsupported {
			what: "filename generation in ZLE without a frame".into(),
		});
		return k(zw, sc, None);
	};
	let ng = zw.isset(ZshOpt::Nullglob);
	if let Err(e) = state::set_zsh_option(&mut zw.k.root, zw.cx.store, zw.vp, ZshOpt::Nullglob, true)
	{
		zw.fail(e);
		return k(zw, sc, None);
	}
	let theirs = zw.vp.frames[fi].scratch.take();
	zw.vp.frames[fi].scratch = Some(sc);
	let r = zglob::expand_globs(zw.k, zw.vp, zw.cx, &mut items, &globs, 0);
	sc = zw
		.vp
		.frames
		.get_mut(fi)
		.and_then(|f| f.scratch.take())
		.unwrap_or_default();
	if let Some(f) = zw.vp.frames.get_mut(fi) {
		f.scratch = theirs;
	}
	if let Err(e) = state::set_zsh_option(&mut zw.k.root, zw.cx.store, zw.vp, ZshOpt::Nullglob, ng) {
		zw.fail(e);
	}
	match r {
		Ok(()) => {},
		Err(Flow::Block(key)) => {
			return then(Await::Wait(key), move |zw, _| globlist(zw, sc, nodes, k));
		},
		Err(_) => return k(zw, sc, None),
	}
	let mut kept = nodes
		.into_iter()
		.enumerate()
		.filter(|(i, _)| !globs.iter().any(|(g, _)| *g as usize == *i));
	let mut out = Vec::with_capacity(items.len());
	for it in items {
		if it.is_empty() {
			if let Some((_, w)) = kept.next() {
				out.push(w);
			}
		} else {
			out.push(metafy(&it));
		}
	}
	k(zw, sc, Some(out))
}

/// zsh `doexpansion`: expand word `s` (`origword`: metafied, tokenized,
/// quotes taken off) and put the expansions on the line in place of the
/// word (`COMP_LIST_EXPAND`: list them, the line restored); `k` gets 1
/// when nothing was expanded.
pub fn doexpansion(
	zw: &mut Zw<'_, '_>,
	s: Vec<u8>,
	lst: i32,
	olst: i32,
	explincmd: i32,
	k: K<i32>,
) -> WResult {
	let mut ss = s.clone();
	for b in &mut ss {
		if *b == b'"' {
			*b = DNULL;
		} else if *b == b'\'' {
			*b = SNULL;
		}
	}
	let word = ss.clone();
	run::<Vec<Vec<u8>>, _>(
		zw,
		Box::default(),
		move |ex| {
			let mut list = List::one(word.clone());
			let mut rf = 0;
			prefork(ex, &mut list, 0, &mut rf)?;
			Ok(list.nodes)
		},
		Box::new(move |zw, sc, r| {
			let nodes = match r {
				Ok(n) => n,
				Err(stop) => {
					quiet_error(zw, stop);
					return k(zw, 1);
				},
			};
			// zsh compares the node with the word it put in: no
			// substitution left the same word (its nulls removed in place).
			let mut same = ss.clone();
			remnulargs(&mut same);
			let unchanged = nodes.len() == 1 && nodes[0] == same;
			if lst != COMP_LIST_EXPAND && lst != COMP_EXPAND {
				return expanded(zw, s, nodes, unchanged, lst, olst, explincmd, k);
			}
			globlist(
				zw,
				sc,
				nodes,
				Box::new(move |zw, _sc, words| match words {
					None => k(zw, 1),
					Some(words) => {
						let unchanged = unchanged && words.len() == 1 && words[0] == same;
						expanded(zw, s, words, unchanged, lst, olst, explincmd, k)
					},
				}),
			)
		}),
	)
}

/// `doexpansion` once the words are there.
#[allow(clippy::too_many_arguments, reason = "the state of zsh's doexpansion")]
fn expanded(
	zw: &mut Zw<'_, '_>,
	s: Vec<u8>,
	vl: Vec<Vec<u8>>,
	unchanged: bool,
	lst: i32,
	olst: i32,
	explincmd: i32,
	k: K<i32>,
) -> WResult {
	if vl.first().is_none_or(Vec::is_empty) {
		return k(zw, 1);
	}
	if unchanged {
		if lst == COMP_EXPAND_COMPLETE {
			return super::docompletion(
				zw,
				s,
				super::COMP_COMPLETE,
				explincmd,
				Box::new(move |zw, _| k(zw, 1)),
			);
		}
		return k(zw, 1);
	}
	if olst == COMP_EXPAND_COMPLETE && vl.len() == 1 && s.first() == Some(&TILDE) {
		let first = vl[0].clone();
		let word = s.clone();
		return run::<bool, _>(
			zw,
			Box::default(),
			move |ex| {
				let mut w = word.clone();
				let done = filesubstr(ex, &mut w, 0)?;
				Ok(done && w == first)
			},
			Box::new(move |zw, _sc, r| match r {
				Ok(true) => {
					if lst == COMP_EXPAND_COMPLETE {
						return super::docompletion(
							zw,
							s,
							super::COMP_COMPLETE,
							explincmd,
							Box::new(move |zw, _| k(zw, 1)),
						);
					}
					k(zw, 1)
				},
				Ok(false) => insert_expansions(zw, vl, lst, k),
				Err(stop) => {
					quiet_error(zw, stop);
					k(zw, 1)
				},
			}),
		);
	}
	insert_expansions(zw, vl, lst, k)
}

/// The end of `doexpansion`: list the expansions (`COMP_LIST_EXPAND`), or
/// put them on the line, quoted, in place of the word.
fn insert_expansions(zw: &mut Zw<'_, '_>, vl: Vec<Vec<u8>>, lst: i32, k: K<i32>) -> WResult {
	if lst == COMP_LIST_EXPAND {
		let c = &mut *zw.zle.comp;
		let origline = c.tricky.origline.clone().unwrap_or_default();
		c.line.cs = 0;
		let ll = c.line.ll();
		c.line.foredel(ll);
		c.line.spaceinline(origline.len());
		if let Some(l) = c.line.s.as_mut() {
			l[..origline.len()].copy_from_slice(&origline);
		}
		c.line.cs = usize::try_from(c.tricky.origcs).unwrap_or(0);
		let items: Vec<BString> = vl
			.into_iter()
			.map(|mut w| {
				untokenize(&mut w);
				BString::from(unmetafy(&w))
			})
			.collect();
		return named::listlist(
			zw,
			items,
			Box::new(move |zw, ret| {
				if zw.zle.display.listshown != 0 {
					zw.zle.comp.tricky.showagain = 1;
				}
				zw.zle.display.showinglist = 0;
				k(zw, ret)
			}),
		);
	}
	let o = quote_opts(zw);
	let c = &mut *zw.zle.comp;
	let (wb, we) = (c.tricky.wb, c.tricky.we);
	c.line.cs = usize::try_from(wb).unwrap_or(0);
	c.line.foredel(usize::try_from(we - wb).unwrap_or(0));
	let n = vl.len();
	let mut ret = 1;
	for (i, w) in vl.into_iter().enumerate() {
		ret = 0;
		let mut q = quotename(&c.tricky, &w, o);
		untokenize(&mut q);
		c.line.inststrlen(&q, true);
		if i + 1 < n || i > 0 {
			c.line.spaceinline(1);
			let cs = c.line.cs;
			if let Some(l) = c.line.s.as_mut() {
				l[cs] = b' ';
			}
			c.line.cs += 1;
		}
	}
	zw.ed.region_active = 0;
	k(zw, ret)
}

/// zsh `expandcmdpath`'s `findcmd(s, 1, 0)`: the full path of command
/// `name` (raw bytes) from the command hash table or a `$PATH` search.
pub fn findcmd_path(ex: &mut Expander<'_, '_>, name: &[u8]) -> X<Option<Vec<u8>>> {
	use crate::bash::store::{Key, Record};
	if let Some(Record::CmdHash { path, .. }) =
		state::record(ex.cx.store, ex.vp, Key::CmdHash(bstr::BStr::new(name)))?
	{
		return Ok(Some(path.to_vec()));
	}
	let path = state::lookup(&ex.k.root, ex.cx.store, ex.vp, b"PATH")?
		.and_then(|v| v.as_scalar().map(BString::from))
		.unwrap_or_default();
	crate::bash::vm::zsh::subst::findcmd(ex, name, &path)
}
