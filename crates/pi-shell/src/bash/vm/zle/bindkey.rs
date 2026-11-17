//! The `bindkey` builtin (zsh 5.9 `Src/Zle/zle_keymap.c` `bin_bindkey`
//! and its operations, `zle_utils.c` `bindztrdup`/`printbind`), over the
//! keymaps of the vproc's editor state ([`super::Zle::keymaps`]).
//!
//! Relinking `main` (`-e`, `-v`, `-A … main`, `-N main`, `-D`, `-d`) needs
//! no separate step for a line in progress: the reader resolves the
//! current keymap by name for every key, which is zsh's `reselectkeymap`
//! after each widget (falling back to `.safe` with a `No such keymap`
//! warning when the name is gone).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use bstr::BString;

use super::{
	bindings,
	keymap::{Bind, Keymap, Keymaps, MapOrigin, UnlinkError, default_main_vi},
};
use crate::bash::{
	store::Attrs,
	syntax::zsh::tok,
	vm::{
		builtins::{
			Ctx, Need, R, done,
			zsh_args::{Ops, isset},
			zsh_print::charset,
			zsh_quote::{Charset, niceformat, quotedzputs},
		},
		zle,
		zsh::text::{getkey, getkeystring},
	},
	zshopt::ZshOpt,
};

/// The options that pick a `bindkey` operation, in zsh's precedence order
/// (`opns[]`): letter, whether a keymap is selected for it, fewest and
/// most arguments. No letter: bind or list (`func` 0).
const OPNS: [(u8, bool, usize, Option<usize>); 8] = [
	(b'l', false, 0, None),
	(b'd', false, 0, Some(0)),
	(b'D', false, 1, None),
	(b'A', false, 2, Some(2)),
	(b'N', false, 1, Some(2)),
	(b'm', true, 0, Some(0)),
	(b'r', true, 1, None),
	(b's', true, 2, None),
];

/// How names and strings print: the character set, `RC_QUOTES` and
/// `CSH_JUNKIE_QUOTES`.
#[derive(Clone, Copy, Debug, Default)]
struct Fmt {
	cs:  Charset,
	rc:  bool,
	csh: bool,
}

impl Fmt {
	/// zsh `nicezputs`.
	fn nice(self, s: &[u8]) -> Vec<u8> {
		niceformat(s, false, self.cs)
	}

	/// zsh `quotedzputs`.
	fn quoted(self, s: &[u8]) -> Vec<u8> {
		quotedzputs(s, self.rc, self.cs)
	}

	/// A `%s` of a zsh warning (`nicezputs`).
	fn arg(self, s: &[u8]) -> String {
		String::from_utf8_lossy(&self.nice(s)).into_owned()
	}
}

/// What `bindkey` printed and warned, in order.
enum Ev {
	Out(Vec<u8>),
	Warn(String),
}

/// The output of one `bindkey` run.
struct Report {
	fmt: Fmt,
	ev:  Vec<Ev>,
}

impl Report {
	const fn new(fmt: Fmt) -> Self {
		Self { fmt, ev: Vec::new() }
	}

	fn out(&mut self, b: &[u8]) {
		if b.is_empty() {
			return;
		}
		if let Some(Ev::Out(o)) = self.ev.last_mut() {
			o.extend_from_slice(b);
		} else {
			self.ev.push(Ev::Out(b.to_vec()));
		}
	}

	/// zsh `zwarnnam(name, …)`.
	fn warn(&mut self, msg: String) {
		self.ev.push(Ev::Warn(msg));
	}
}

/// zsh `getkeystring(s, &len, GETKEYS_BINDKEY, NULL)` of a raw argument:
/// the raw key sequence (`^X`, `\e`, `\M-x`, `\C-x`, octal and hex
/// escapes).
pub fn getkeys(s: &[u8]) -> Vec<u8> {
	getkeystring(&tok::metafy(s), getkey::KEYS_BINDKEY).text
}

/// zsh `bindztrdup` (`printbind`): raw key sequence `s` in the double
/// quoted `^X`/`\M-x` form listings show; `csh` is `CSH_JUNKIE_QUOTES`.
pub fn bindztrdup(s: &[u8], csh: bool) -> Vec<u8> {
	let mut buf = Vec::with_capacity(s.len() * 2);
	for &b in s {
		let mut c = b;
		if c & 0x80 != 0 {
			buf.extend_from_slice(b"\\M-");
			c &= 0x7f;
		}
		if c < 32 || c == 0x7f {
			buf.push(b'^');
			c ^= 64;
		}
		if c == b'\\' || c == b'^' {
			buf.push(b'\\');
		}
		buf.push(c);
	}
	dquotedztrdup(&buf, csh)
}

/// zsh `dquotedztrdup`: `s` double quoted.
fn dquotedztrdup(s: &[u8], csh: bool) -> Vec<u8> {
	let mut p = Vec::with_capacity(s.len() * 2 + 2);
	if csh {
		let mut inquote = false;
		for &c in s {
			match c {
				b'"' | b'$' | b'`' => {
					if inquote {
						p.push(b'"');
						inquote = false;
					}
					p.push(b'\\');
					p.push(c);
				},
				_ => {
					if !inquote {
						p.push(b'"');
						inquote = true;
					}
					if c == b'\n' {
						p.push(b'\\');
					}
					p.push(c);
				},
			}
		}
		if inquote {
			p.push(b'"');
		}
	} else {
		let mut pending = false;
		p.push(b'"');
		for &c in s {
			match c {
				b'\\' => {
					if pending {
						p.push(b'\\');
					}
					p.push(b'\\');
					pending = true;
				},
				b'"' | b'$' | b'`' => {
					if pending {
						p.push(b'\\');
					}
					p.push(b'\\');
					p.push(c);
					pending = false;
				},
				_ => {
					p.push(c);
					pending = false;
				},
			}
		}
		if pending {
			p.push(b'\\');
		}
		p.push(b'"');
	}
	p
}

/// An exported variable's value (zsh `zgetenv`).
fn getenv(ctx: &mut Ctx<'_, '_>, name: &[u8]) -> Result<Option<BString>, Need> {
	Ok(ctx
		.var(name)?
		.filter(|v| v.attrs.contains(Attrs::EXPORT))
		.and_then(|v| v.as_scalar().map(BString::from)))
}

/// zsh `bin_bindkey`: the `bindkey` builtin (options already parsed with
/// optstring `evaM:ldDANmrsLRp`).
pub fn bindkey(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let fmt = Fmt {
		cs:  charset(ctx)?,
		rc:  isset(ctx, ZshOpt::Rcquotes)?,
		csh: isset(ctx, ZshOpt::Cshjunkiequotes)?,
	};
	// `bindkey -d` builds the defaults again, `main` chosen from the
	// environment as at startup.
	let main_vi = if ops.isset(b'd') {
		let visual = getenv(ctx, b"VISUAL")?;
		let editor = getenv(ctx, b"EDITOR")?;
		default_main_vi(visual.as_ref().map(|v| v.as_slice()), editor.as_ref().map(|v| v.as_slice()))
	} else {
		false
	};
	let mut rep = Report::new(fmt);
	let status = {
		let z = zle::zle_mut(ctx.k, ctx.cx, ctx.vp);
		run(&mut z.keymaps, ops, args, main_vi, &mut rep)
	};
	for ev in rep.ev {
		match ev {
			Ev::Out(b) => ctx.out(&b),
			Ev::Warn(m) => ctx.usage(m),
		}
	}
	done(status)
}

/// zsh `bin_bindkey` over `kms`: the operation's status.
fn run(
	kms: &mut Arc<Keymaps>,
	ops: &Ops,
	args: &[BString],
	main_vi: bool,
	rep: &mut Report,
) -> i32 {
	let fmt = rep.fmt;
	// Select the operation and ensure no clashing options.
	let op = OPNS.iter().position(|o| ops.isset(o.0));
	if let Some(i) = op
		&& OPNS[i + 1..].iter().any(|o| ops.isset(o.0))
	{
		rep.warn("incompatible operation selection options".into());
		return 1;
	}
	let (o, selp, min, max) = op.map_or((0, true, 0, None), |i| OPNS[i]);
	let n = b"evaM".iter().filter(|&&c| ops.isset(c)).count();
	if !selp && n != 0 {
		rep.warn(format!("keymap cannot be selected with -{}", char::from(o)));
		return 1;
	}
	if n > 1 {
		rep.warn("incompatible keymap selection options".into());
		return 1;
	}

	// Keymap selection.
	let sel = if selp {
		let kmname: &[u8] = if ops.isset(b'e') {
			b"emacs"
		} else if ops.isset(b'v') {
			b"viins"
		} else if ops.isset(b'a') {
			b"vicmd"
		} else if ops.isset(b'M') {
			ops.arg(b'M').unwrap_or_default()
		} else {
			b"main"
		};
		let Some(id) = kms.open(kmname) else {
			rep.warn(format!("no such keymap `{}'", fmt.arg(kmname)));
			return 1;
		};
		if ops.isset(b'e') || ops.isset(b'v') {
			// zsh ignores linkkeymap's result: only an immortal `main`
			// (which nothing creates) could refuse.
			let _ = Arc::make_mut(kms).link(id, b"main", false);
		}
		Some((kmname, id))
	} else {
		None
	};

	// Listing is a special case.
	if o == 0 && args.len() < 2 {
		if ops.isset(b'e') || ops.isset(b'v') {
			return 0;
		}
		let Some((kmname, id)) = sel else {
			return 1;
		};
		let Some(km) = kms.keymap(id) else {
			return 1;
		};
		return list(km, kmname, args, ops.isset(b'L'), ops.isset(b'p'), rep);
	}

	// Check the number of arguments.
	if args.len() < min {
		rep.warn(format!("not enough arguments for -{}", char::from(o)));
		return 1;
	}
	if max.is_some_and(|m| args.len() > m) {
		rep.warn(format!("too many arguments for -{}", char::from(o)));
		return 1;
	}

	match (o, sel) {
		(b'l', _) => lsmaps(kms, args, ops.isset(b'L'), rep),
		(b'd', _) => {
			Arc::make_mut(kms).reset(main_vi);
			0
		},
		(b'D', _) => del(kms, args, rep),
		(b'A', _) => link(kms, args, rep),
		(b'N', _) => new(kms, args, rep),
		(b'm', Some((kmname, id))) => meta(kms, kmname, id, rep),
		(b'r' | b's' | 0, Some((kmname, id))) => bind(kms, kmname, id, args, ops, o, rep),
		_ => 1,
	}
}

/// zsh `bin_bindkey_lsmaps` (`-l`): the named keymaps, or all of them
/// sorted; `long` (`-L`) as `bindkey -N`/`-A` commands.
fn lsmaps(kms: &Keymaps, args: &[BString], long: bool, rep: &mut Report) -> i32 {
	let mut ret = 0;
	if args.is_empty() {
		for name in kms.sorted_names() {
			listmap(kms, &name, long, rep);
		}
	} else {
		for a in args {
			if kms.exists(a) {
				listmap(kms, a, long, rep);
			} else {
				rep.warn(format!("no such keymap: `{}'", rep.fmt.arg(a)));
				ret = 1;
			}
		}
	}
	ret
}

/// zsh `scanlistmaps`: one name of `bindkey -l`.
fn listmap(kms: &Keymaps, name: &[u8], long: bool, rep: &mut Report) {
	let fmt = rep.fmt;
	let mut out = Vec::new();
	if long {
		// `.safe` is not listed as a command: it cannot be created so.
		let Some(primary) = kms.primary_of(name) else {
			return;
		};
		out.extend_from_slice(b"bindkey -");
		if let MapOrigin::Linked(p) = primary {
			out.extend_from_slice(b"A ");
			if p.first() == Some(&b'-') {
				out.extend_from_slice(b"-- ");
			}
			out.extend_from_slice(&fmt.quoted(&p));
			out.push(b' ');
		} else {
			out.extend_from_slice(b"N ");
			if name.first() == Some(&b'-') {
				out.extend_from_slice(b"-- ");
			}
		}
		out.extend_from_slice(&fmt.quoted(name));
	} else {
		out.extend_from_slice(&fmt.nice(name));
	}
	out.push(b'\n');
	rep.out(&out);
}

/// zsh `bin_bindkey_del` (`-D`).
fn del(kms: &mut Arc<Keymaps>, args: &[BString], rep: &mut Report) -> i32 {
	let mut ret = 0;
	for a in args {
		match Arc::make_mut(kms).unlink(a, false) {
			Ok(()) => {},
			Err(UnlinkError::Protected) => {
				rep.warn(format!("keymap name `{}' is protected", rep.fmt.arg(a)));
				ret = 1;
			},
			Err(UnlinkError::NoSuchKeymap) => {
				rep.warn(format!("no such keymap `{}'", rep.fmt.arg(a)));
				ret = 1;
			},
		}
	}
	ret
}

/// zsh `bin_bindkey_link` (`-A old new`).
fn link(kms: &mut Arc<Keymaps>, args: &[BString], rep: &mut Report) -> i32 {
	let (from, to) = (&args[0], &args[1]);
	let Some(id) = kms.open(from) else {
		rep.warn(format!("no such keymap `{}'", rep.fmt.arg(from)));
		return 1;
	};
	if Arc::make_mut(kms).link(id, to, false).is_err() {
		rep.warn(format!("keymap name `{}' is protected", rep.fmt.arg(to)));
		return 1;
	}
	0
}

/// zsh `bin_bindkey_new` (`-N name [old]`).
fn new(kms: &mut Arc<Keymaps>, args: &[BString], rep: &mut Report) -> i32 {
	let name = &args[0];
	if kms.immortal(name) {
		rep.warn(format!("keymap name `{}' is protected", rep.fmt.arg(name)));
		return 1;
	}
	let copy = match args.get(1) {
		Some(old) => {
			let Some(id) = kms.open(old) else {
				rep.warn(format!("no such keymap `{}'", rep.fmt.arg(old)));
				return 1;
			};
			Some(id)
		},
		None => None,
	};
	if Arc::make_mut(kms).create(name, copy, false).is_err() {
		rep.warn(format!("keymap name `{}' is protected", rep.fmt.arg(name)));
		return 1;
	}
	0
}

/// zsh `bin_bindkey_meta` (`-m`): bind the meta keys of `metabind` that
/// are unbound or `self-insert`.
fn meta(kms: &mut Arc<Keymaps>, kmname: &[u8], id: super::keymap::KmId, rep: &mut Report) -> i32 {
	if kms.keymap(id).is_none_or(Keymap::immutable) {
		rep.warn(format!("keymap `{}' is protected", rep.fmt.arg(kmname)));
		return 1;
	}
	rep.warn("warning: `bindkey -m' disables multibyte support".into());
	let kms = Arc::make_mut(kms);
	for (i, wid) in bindings::META.iter().enumerate() {
		let (Some(wid), Ok(c)) = (*wid, u8::try_from(i + 128)) else {
			continue;
		};
		let rebind = kms.keymap(id).is_some_and(|km| match km.lookup(&[c]) {
			None => true,
			Some(Bind::Widget(w)) => w.as_slice() == b"self-insert" || w.as_slice() == b".self-insert",
			Some(Bind::Str(_)) => false,
		});
		if rebind {
			// The keymap is mutable and the sequence not empty.
			let _ = kms.bind(id, &[c], Some(Bind::widget(wid)));
		}
	}
	0
}

/// zsh `bin_bindkey_bind`: `-r` (unbind), `-s` (send strings) or plain
/// (widgets) bindings, of key ranges with `-R`, or `-rp` (unbind every
/// sequence a prefix starts).
fn bind(
	kms: &mut Arc<Keymaps>,
	kmname: &[u8],
	id: super::keymap::KmId,
	args: &[BString],
	ops: &Ops,
	func: u8,
	rep: &mut Report,
) -> i32 {
	if func != b'r' && !args.len().is_multiple_of(2) {
		rep.warn("even number of arguments required".into());
		return 1;
	}
	if kms.keymap(id).is_none_or(Keymap::immutable) {
		rep.warn(format!("keymap `{}' is protected", rep.fmt.arg(kmname)));
		return 1;
	}
	let kms = Arc::make_mut(kms);
	if func == b'r' && ops.isset(b'p') {
		for a in args {
			let prefix = getkeys(a);
			let mut seqs: Vec<Vec<u8>> = Vec::new();
			if let Some(km) = kms.keymap(id) {
				km.scan_entries(&mut |seq, _| {
					if seq.starts_with(&prefix) && seq.len() > prefix.len() {
						seqs.push(seq.to_vec());
					}
				});
			}
			for seq in seqs {
				// The keymap is mutable and the sequence not empty.
				let _ = kms.bind(id, &seq, None);
			}
		}
		return 0;
	}
	let mut ret = 0;
	let mut i = 0;
	while i < args.len() {
		let useq = &args[i];
		let b = match func {
			b'r' => None,
			b's' => {
				i += 1;
				Some(Bind::Str(BString::from(getkeys(&args[i]))))
			},
			_ => {
				i += 1;
				Some(Bind::Widget(args[i].clone()))
			},
		};
		let bseq = getkeys(useq);
		if ops.isset(b'R') {
			let len = bseq.len();
			let dash = usize::from(bseq.get(1) == Some(&b'-'));
			if len < 2 || len > 2 + dash || bseq[0] > bseq[len - 1] {
				rep.warn(format!("malformed key range `{}'", rep.fmt.arg(useq)));
				ret = 1;
			} else {
				for c in bseq[0]..=bseq[len - 1] {
					// The keymap is mutable and the sequence not empty.
					let _ = kms.bind(id, &[c], b.clone());
				}
			}
		} else if kms.bind(id, &bseq, b).is_err() {
			rep.warn("cannot bind to an empty key sequence".into());
			ret = 1;
		}
		i += 1;
	}
	ret
}

/// zsh `struct bindstate`: the run of bindings being listed.
struct ListState<'a> {
	kmname: &'a [u8],
	/// `BS_LIST` (`-L`).
	long:   bool,
	/// `BS_ALL`: list an unbound key too.
	all:    bool,
	first:  Vec<u8>,
	last:   Vec<u8>,
	bind:   Option<Bind>,
}

/// zsh `bin_bindkey_list`: one key's binding, the bindings a prefix
/// starts (`-p`), or the whole keymap; `long` (`-L`) as `bindkey`
/// commands.
fn list(
	km: &Keymap,
	kmname: &[u8],
	args: &[BString],
	long: bool,
	pflag: bool,
	rep: &mut Report,
) -> i32 {
	let fmt = rep.fmt;
	let mut st =
		ListState { kmname, long, all: false, first: Vec::new(), last: Vec::new(), bind: None };
	if let (Some(a), false) = (args.first(), pflag) {
		let seq = getkeys(a);
		st.all = true;
		st.bind = km.lookup(&seq).cloned();
		st.first.clone_from(&seq);
		st.last = seq;
		let out = bindlistout(&st, fmt);
		rep.out(&out);
		return 0;
	}
	// An empty prefix is no prefix.
	let prefix = if pflag && args.first().is_none_or(|a| !a.is_empty()) {
		let Some(a) = args.first() else {
			rep.warn("option -p requires a prefix string".into());
			return 1;
		};
		getkeys(a)
	} else {
		Vec::new()
	};
	let mut out = Vec::new();
	km.scan_entries(&mut |seq, bind| {
		if !prefix.is_empty() && (!seq.starts_with(&prefix) || seq.len() <= prefix.len()) {
			return;
		}
		if let ([t], [l]) = (seq, st.last.as_slice())
			&& bind == st.bind.as_ref()
			&& l.checked_add(1) == Some(*t)
		{
			st.last = seq.to_vec();
			return;
		}
		out.extend_from_slice(&bindlistout(&st, fmt));
		st.first = seq.to_vec();
		st.last = seq.to_vec();
		st.bind = bind.cloned();
	});
	out.extend_from_slice(&bindlistout(&st, fmt));
	rep.out(&out);
	0
}

/// zsh `bindlistout`: one line of a listing (a key or a range of keys
/// with the same binding).
fn bindlistout(st: &ListState<'_>, fmt: Fmt) -> Vec<u8> {
	let mut out = Vec::new();
	if st.bind.is_none() && !st.all {
		return out;
	}
	let range = st.first != st.last;
	if st.long {
		let mut nodash = true;
		out.extend_from_slice(b"bindkey ");
		if range {
			out.extend_from_slice(b"-R ");
		}
		if matches!(st.bind, Some(Bind::Str(_))) {
			out.extend_from_slice(b"-s ");
		}
		match st.kmname {
			b"main" => {},
			b"vicmd" => out.extend_from_slice(b"-a "),
			name => {
				out.extend_from_slice(b"-M ");
				out.extend_from_slice(&fmt.quoted(name));
				out.push(b' ');
				nodash = false;
			},
		}
		if nodash && st.first.first() == Some(&b'-') {
			out.extend_from_slice(b"-- ");
		}
	}
	out.extend_from_slice(&bindztrdup(&st.first, fmt.csh));
	if range {
		out.push(b'-');
		out.extend_from_slice(&bindztrdup(&st.last, fmt.csh));
	}
	out.push(b' ');
	match &st.bind {
		Some(Bind::Str(s)) => out.extend_from_slice(&bindztrdup(s, fmt.csh)),
		b => {
			let name = match b {
				Some(Bind::Widget(w)) => w.as_slice(),
				_ => super::keymap::UNDEFINED_KEY,
			};
			out.extend_from_slice(&if st.long {
				fmt.quoted(name)
			} else {
				fmt.nice(name)
			});
		},
	}
	out.push(b'\n');
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn fmt() -> Fmt {
		Fmt {
			cs:  Charset { utf8: true, print_eight: false, ..Charset::default() },
			rc:  false,
			csh: false,
		}
	}

	fn listing(kms: &Keymaps, name: &[u8], long: bool) -> String {
		let mut rep = Report::new(fmt());
		let km = kms.get(name).expect("keymap exists");
		assert_eq!(list(km, name, &[], long, false, &mut rep), 0);
		out_of(rep)
	}

	fn out_of(rep: Report) -> String {
		let mut s = Vec::new();
		for ev in rep.ev {
			match ev {
				Ev::Out(b) => s.extend_from_slice(&b),
				Ev::Warn(w) => {
					s.extend_from_slice(b"W:");
					s.extend_from_slice(w.as_bytes());
					s.push(b'\n');
				},
			}
		}
		String::from_utf8_lossy(&s).into_owned()
	}

	/// `bindkey -M NAME OPTIONS… ARGS…` over `kms` with `-M`/`-L` given as
	/// flags (tests cannot build an [`Ops`] with arguments).
	fn bk(kms: &mut Arc<Keymaps>, kmname: &[u8], letters: &[u8], args: &[&[u8]]) -> (i32, String) {
		let mut ops = Ops::default();
		for &c in letters {
			ops.set(c);
		}
		let args: Vec<BString> = args.iter().map(|a| BString::from(*a)).collect();
		let mut rep = Report::new(fmt());
		let id = kms.open(kmname).expect("keymap exists");
		let st = if letters.contains(&b'm') {
			meta(kms, kmname, id, &mut rep)
		} else if args.len() < 2 && !letters.contains(&b'r') && !letters.contains(&b's') {
			let km = kms.keymap(id).expect("keymap exists");
			list(km, kmname, &args, ops.isset(b'L'), ops.isset(b'p'), &mut rep)
		} else {
			let func = if letters.contains(&b'r') {
				b'r'
			} else if letters.contains(&b's') {
				b's'
			} else {
				0
			};
			bind(kms, kmname, id, &args, &ops, func, &mut rep)
		};
		(st, out_of(rep))
	}

	/// `bindkey OPTIONS… ARGS…` through [`run`] (no `-M`).
	fn bkrun(kms: &mut Arc<Keymaps>, letters: &[u8], args: &[&[u8]]) -> (i32, String) {
		let mut ops = Ops::default();
		for &c in letters {
			ops.set(c);
		}
		let args: Vec<BString> = args.iter().map(|a| BString::from(*a)).collect();
		let mut rep = Report::new(fmt());
		let st = run(kms, &ops, &args, false, &mut rep);
		(st, out_of(rep))
	}

	// Expected outputs: /bin/zsh -f -c 'bindkey -L -M NAME' (zsh 5.9,
	// TERM=dumb, VISUAL/EDITOR without "vi").
	#[test]
	fn default_keymaps_list_like_zsh() {
		let kms = Keymaps::new(false);
		for (name, want) in [
			(&b"emacs"[..], include_str!("testdata/bindkey_L_emacs.txt")),
			(b"viins", include_str!("testdata/bindkey_L_viins.txt")),
			(b"vicmd", include_str!("testdata/bindkey_L_vicmd.txt")),
			(b".safe", include_str!("testdata/bindkey_L_safe.txt")),
			(b"isearch", include_str!("testdata/bindkey_L_isearch.txt")),
			(b"command", include_str!("testdata/bindkey_L_command.txt")),
			(b"visual", include_str!("testdata/bindkey_L_visual.txt")),
			(b"viopp", include_str!("testdata/bindkey_L_viopp.txt")),
		] {
			assert_eq!(
				listing(&kms, name, true),
				want,
				"bindkey -L -M {}",
				String::from_utf8_lossy(name)
			);
		}
		// zsh: bindkey -M vicmd
		assert_eq!(listing(&kms, b"vicmd", false), include_str!("testdata/bindkey_vicmd.txt"));
	}

	#[test]
	fn keymap_names_like_zsh() {
		let mut kms = Arc::new(Keymaps::new(false));
		// zsh: print -l $keymaps
		let names: Vec<String> = kms.names().iter().map(ToString::to_string).collect();
		assert_eq!(names, [
			"visual", "viopp", "command", ".safe", "vicmd", "main", "isearch", "viins", "emacs"
		]);
		// zsh: bindkey -l; bindkey -lL
		assert_eq!(
			bkrun(&mut kms, b"l", &[]),
			(0, ".safe\ncommand\nemacs\nisearch\nmain\nvicmd\nviins\nviopp\nvisual\n".into())
		);
		assert_eq!(
			bkrun(&mut kms, b"lL", &[]),
			(
				0,
				"bindkey -N command\nbindkey -N emacs\nbindkey -N isearch\nbindkey -A emacs \
				 main\nbindkey -N vicmd\nbindkey -N viins\nbindkey -N viopp\nbindkey -N visual\n"
					.into()
			)
		);
		// zsh: bindkey -l nope emacs
		assert_eq!(
			bkrun(&mut kms, b"l", &[b"nope", b"emacs"]),
			(1, "W:no such keymap: `nope'\nemacs\n".into())
		);
		// zsh: bindkey -D main; print -l $keymaps
		assert_eq!(bkrun(&mut kms, b"D", &[b"main"]).0, 0);
		let names: Vec<String> = kms.names().iter().map(ToString::to_string).collect();
		assert_eq!(names, [
			"visual", "viopp", "command", ".safe", "vicmd", "isearch", "viins", "emacs"
		]);
	}

	#[test]
	fn primary_names_follow_zsh() {
		// zsh: bindkey -N -- -foo; bindkey -A -- -foo bar; bindkey -A emacs "a
		// b"; bindkey -lL
		let mut kms = Arc::new(Keymaps::new(false));
		bkrun(&mut kms, b"N", &[b"-foo"]);
		bkrun(&mut kms, b"A", &[b"-foo", b"bar"]);
		bkrun(&mut kms, b"A", &[b"emacs", b"a b"]);
		assert_eq!(
			bkrun(&mut kms, b"lL", &[]).1,
			"bindkey -N -- -foo\nbindkey -A emacs 'a b'\nbindkey -A -- -foo bar\nbindkey -N \
			 command\nbindkey -N emacs\nbindkey -N isearch\nbindkey -A emacs main\nbindkey -N \
			 vicmd\nbindkey -N viins\nbindkey -N viopp\nbindkey -N visual\n"
		);
		// zsh: bindkey -D -- -foo; bindkey -lL | grep bar
		bkrun(&mut kms, b"D", &[b"-foo"]);
		assert!(bkrun(&mut kms, b"lL", &[]).1.contains("bindkey -N bar\n"));
		// zsh: bindkey -N foo; bindkey -A foo zzz; bindkey -A emacs foo; bindkey
		// -lL
		let mut kms = Arc::new(Keymaps::new(false));
		bkrun(&mut kms, b"N", &[b"foo"]);
		bkrun(&mut kms, b"A", &[b"foo", b"zzz"]);
		bkrun(&mut kms, b"A", &[b"emacs", b"foo"]);
		let out = bkrun(&mut kms, b"lL", &[]).1;
		assert!(out.contains("bindkey -A emacs foo\n"));
		assert!(out.ends_with("bindkey -A foo zzz\n"));
	}

	#[test]
	fn errors_like_zsh() {
		let mut kms = Arc::new(Keymaps::new(false));
		let w = |s: &str| (1, format!("W:{s}\n"));
		assert_eq!(bkrun(&mut kms, b"ev", &[]), w("incompatible keymap selection options"));
		assert_eq!(bkrun(&mut kms, b"le", &[]), w("keymap cannot be selected with -l"));
		assert_eq!(bkrun(&mut kms, b"lr", &[]), w("incompatible operation selection options"));
		assert_eq!(bkrun(&mut kms, b"A", &[b"emacs"]), w("not enough arguments for -A"));
		assert_eq!(bkrun(&mut kms, b"A", &[b"a", b"b", b"c"]), w("too many arguments for -A"));
		assert_eq!(bkrun(&mut kms, b"m", &[b"x"]), w("too many arguments for -m"));
		assert_eq!(bkrun(&mut kms, b"s", &[b"a"]), w("not enough arguments for -s"));
		assert_eq!(bkrun(&mut kms, b"r", &[]), w("not enough arguments for -r"));
		assert_eq!(bkrun(&mut kms, b"", &[b"a", b"b", b"c"]), w("even number of arguments required"));
		assert_eq!(bkrun(&mut kms, b"", &[b"", b"foo"]), w("cannot bind to an empty key sequence"));
		assert_eq!(bkrun(&mut kms, b"R", &[b"abc", b"foo"]), w("malformed key range `abc'"));
		assert_eq!(bkrun(&mut kms, b"R", &[b"ba", b"foo"]), w("malformed key range `ba'"));
		assert_eq!(bkrun(&mut kms, b"p", &[]), w("option -p requires a prefix string"));
		assert_eq!(bkrun(&mut kms, b"A", &[b"nope", b"x"]), w("no such keymap `nope'"));
		assert_eq!(
			bkrun(&mut kms, b"A", &[b"emacs", b".safe"]),
			w("keymap name `.safe' is protected")
		);
		assert_eq!(bkrun(&mut kms, b"N", &[b".safe"]), w("keymap name `.safe' is protected"));
		assert_eq!(bkrun(&mut kms, b"N", &[b"x", b"nope"]), w("no such keymap `nope'"));
		assert_eq!(bkrun(&mut kms, b"D", &[b".safe"]), w("keymap name `.safe' is protected"));
		assert_eq!(bk(&mut kms, b".safe", b"", &[b"a", b"b"]), w("keymap `.safe' is protected"));
		assert_eq!(bk(&mut kms, b".safe", b"m", &[]), w("keymap `.safe' is protected"));
		// zsh: bindkey -D nope emacs (still deletes emacs)
		assert_eq!(bkrun(&mut kms, b"D", &[b"nope", b"emacs"]), w("no such keymap `nope'"));
		assert!(!kms.exists(b"emacs"));
		// zsh: bindkey -e "^A" prints nothing
		let mut kms = Arc::new(Keymaps::new(true));
		assert_eq!(bkrun(&mut kms, b"e", &[b"^A"]), (0, String::new()));
		assert!(kms.same(b"main", b"emacs"));
		assert_eq!(bkrun(&mut kms, b"v", &[]), (0, String::new()));
		assert!(kms.same(b"main", b"viins"));
	}

	#[test]
	fn single_key_and_prefix_listing() {
		let mut kms = Arc::new(Keymaps::new(false));
		// zsh: bindkey "^C"; bindkey -L "^C"; bindkey -a "^C"; bindkey "^A"
		assert_eq!(bk(&mut kms, b"main", b"", &[b"^C"]).1, "\"^C\" undefined-key\n");
		assert_eq!(bk(&mut kms, b"main", b"L", &[b"^C"]).1, "bindkey \"^C\" undefined-key\n");
		assert_eq!(bk(&mut kms, b"main", b"", &[b"^A"]).1, "\"^A\" beginning-of-line\n");
		// zsh: bindkey -L -p "^[O"
		assert_eq!(
			bk(&mut kms, b"main", b"Lp", &[b"^[O"]).1,
			"bindkey \"^[OA\" up-line-or-history\nbindkey \"^[OB\" down-line-or-history\nbindkey \
			 \"^[OC\" forward-char\nbindkey \"^[OD\" backward-char\n"
		);
		// zsh: bindkey -p "" | wc -l
		assert_eq!(bk(&mut kms, b"main", b"p", &[b""]).1.lines().count(), 117);
	}

	#[test]
	fn binding_and_sort_order_like_zsh() {
		// zsh: bindkey -N t; bindkey -M t "\M-ab" w1; … ; bindkey -M t
		let mut kms = Arc::new(Keymaps::new(false));
		bkrun(&mut kms, b"N", &[b"t"]);
		for (k, w) in [
			(&b"\\M-ab"[..], &b"w1"[..]),
			(b"^Xa", b"w2"),
			(b"a", b"w3"),
			(b"\\M-^C", b"w4"),
			(b"\\M-^Cx", b"w5"),
			(b"^@x", b"w6"),
			(b"^@", b"w7"),
			(b"\\M-^@", b"w8"),
			(b"\\M-^@y", b"w9"),
		] {
			assert_eq!(bk(&mut kms, b"t", b"", &[k, w]).0, 0);
		}
		assert_eq!(bk(&mut kms, b"t", b"", &[]).1, include_str!("testdata/bindkey_sorted.txt"));

		// zsh: bindkey -N t; bindkey -M t -R "a-f" foo; bindkey -M t -s "^Xa"
		// 'ab\$"c^A'; bindkey -M t "\\" bs; bindkey -M t -- "-x" dash;
		// bindkey -M t "^?" undefined-key; bindkey -M t -L
		let mut kms = Arc::new(Keymaps::new(false));
		bkrun(&mut kms, b"N", &[b"t"]);
		bk(&mut kms, b"t", b"R", &[b"a-f", b"foo"]);
		bk(&mut kms, b"t", b"s", &[b"^Xa", b"ab$\"c^A"]);
		bk(&mut kms, b"t", b"", &[b"\\\\", b"bs"]);
		bk(&mut kms, b"t", b"", &[b"-x", b"dash"]);
		bk(&mut kms, b"t", b"", &[b"^?", b"undefined-key"]);
		assert_eq!(
			bk(&mut kms, b"t", b"L", &[]).1,
			"bindkey -s -M t \"^Xa\" \"ab\\$\\\"c^A\"\nbindkey -M t \"-x\" dash\nbindkey -M t \
			 \"\\\\\\\\\" bs\nbindkey -R -M t \"a\"-\"f\" foo\n"
		);
		assert_eq!(
			bk(&mut kms, b"t", b"", &[]).1,
			"\"^Xa\" \"ab\\$\\\"c^A\"\n\"-x\" dash\n\"\\\\\\\\\" bs\n\"a\"-\"f\" foo\n"
		);
		// zsh: bindkey -M t "\M-a" "x y"; bindkey -LM t "\M-a"
		bk(&mut kms, b"t", b"", &[b"\\M-a", b"x y"]);
		assert_eq!(bk(&mut kms, b"t", b"L", &[b"\\M-a"]).1, "bindkey -M t \"\\M-a\" 'x y'\n");
		// zsh: bindkey -A t main; bindkey -- -x y; bindkey -L | head -1
		bkrun(&mut kms, b"A", &[b"t", b"main"]);
		bk(&mut kms, b"main", b"", &[b"-x", b"y"]);
		assert!(
			bk(&mut kms, b"main", b"L", &[])
				.1
				.contains("bindkey -- \"-x\" y\n")
		);
	}

	#[test]
	fn unbinding_restores_single_keys() {
		let mut kms = Arc::new(Keymaps::new(false));
		let before = listing(&kms, b"emacs", true);
		bk(&mut kms, b"emacs", b"", &[b"ab", b"foo"]);
		let id = kms.open(b"emacs").expect("emacs");
		let km = kms.keymap(id).expect("emacs");
		assert!(km.is_prefix(b"a"));
		assert_eq!(km.lookup(b"a"), Some(&Bind::widget("self-insert")));
		assert_eq!(km.lookup(b"ab"), Some(&Bind::widget("foo")));
		bk(&mut kms, b"emacs", b"r", &[b"ab"]);
		assert_eq!(listing(&kms, b"emacs", true), before);
		// zsh: bindkey -rp "^X"; bindkey -p "^X" prints nothing, "^X" is unbound.
		bk(&mut kms, b"emacs", b"rp", &[b"^X"]);
		assert_eq!(bk(&mut kms, b"emacs", b"p", &[b"^X"]).1, "");
		assert_eq!(bk(&mut kms, b"emacs", b"", &[b"^X"]).1, "\"^X\" undefined-key\n");
		let km = kms.get(b"emacs").expect("emacs");
		assert!(!km.is_prefix(b"\x18"));
		assert!(km.is_prefix(b"\x1b"));
		assert!(km.is_prefix(b"\x1b[2"));
		assert!(!km.is_prefix(b"\x1b[200~"));
		assert!(km.is_prefix(b""));
	}

	#[test]
	fn meta_bindings_like_zsh() {
		// zsh: bindkey -m 2>/dev/null; bindkey -L
		let mut kms = Arc::new(Keymaps::new(false));
		assert_eq!(
			bk(&mut kms, b"main", b"m", &[]),
			(0, "W:warning: `bindkey -m' disables multibyte support\n".into())
		);
		assert_eq!(listing(&kms, b"main", true), include_str!("testdata/bindkey_m_emacs.txt"));
	}

	#[test]
	fn reset_restores_defaults() {
		let mut kms = Arc::new(Keymaps::new(false));
		bkrun(&mut kms, b"N", &[b"t"]);
		bkrun(&mut kms, b"D", &[b"emacs"]);
		assert_eq!(bkrun(&mut kms, b"d", &[]), (0, String::new()));
		assert!(!kms.exists(b"t"));
		assert_eq!(listing(&kms, b"emacs", true), include_str!("testdata/bindkey_L_emacs.txt"));
		assert!(kms.same(b"main", b"emacs"));
	}

	#[test]
	fn key_strings_round_trip() {
		for (arg, raw, shown) in [
			(&b"^X^B"[..], &b"\x18\x02"[..], &b"\"^X^B\""[..]),
			(b"\\e", b"\x1b", b"\"^[\""),
			(b"\\C-a", b"\x01", b"\"^A\""),
			(b"\\M-a", b"\xe1", b"\"\\M-a\""),
			(b"\\M-^?", b"\xff", b"\"\\M-^?\""),
			(b"\\M-\\C-x", b"\x98", b"\"\\M-^X\""),
			(b"^?", b"\x7f", b"\"^?\""),
			(b"\\\\", b"\\", b"\"\\\\\\\\\""),
			(b"\"", b"\"", b"\"\\\"\""),
			(b"$", b"$", b"\"\\$\""),
			(b"^\\^", b"\x1e", b"\"^\\^\""),
			(b"\\x41\\101", b"AA", b"\"AA\""),
			(b"-", b"-", b"\"-\""),
		] {
			assert_eq!(getkeys(arg), raw, "{}", String::from_utf8_lossy(arg));
			assert_eq!(bindztrdup(raw, false), shown, "{}", String::from_utf8_lossy(arg));
			// zsh `bindkey` accepts its own listing back once the shell
			// has removed the double quotes.
			assert_eq!(getkeys(&dequote(shown)), raw, "{}", String::from_utf8_lossy(arg));
		}
		// CSH_JUNKIE_QUOTES: zsh -f -c 'setopt cshjunkiequotes; bindkey -s x
		// "a\"b"; bindkey x'
		assert_eq!(bindztrdup(b"a\"b", true), b"\"a\"\\\"\"b\"");
	}

	/// The shell's reading of double-quoted word `s` (`\` quotes `\`, `"`,
	/// `$` and `` ` `` only).
	fn dequote(s: &[u8]) -> Vec<u8> {
		let s = &s[1..s.len() - 1];
		let mut out = Vec::new();
		let mut i = 0;
		while i < s.len() {
			if s[i] == b'\\' && matches!(s.get(i + 1), Some(b'\\' | b'"' | b'$' | b'`')) {
				i += 1;
			}
			out.push(s[i]);
			i += 1;
		}
		out
	}

	#[test]
	fn default_main_follows_visual_and_editor() {
		assert!(default_main_vi(Some(&b"vim"[..]), None));
		assert!(default_main_vi(None, Some(&b"nvi"[..])));
		assert!(default_main_vi(Some(&b"emacs"[..]), Some(&b"vi"[..])));
		assert!(!default_main_vi(Some(&b"true"[..]), Some(&b"emacs"[..])));
		assert!(!default_main_vi(None, None));
		assert!(Keymaps::new(true).same(b"main", b"viins"));
		assert!(Keymaps::new(false).same(b"main", b"emacs"));
	}
}
