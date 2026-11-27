//! `dirs`, `pushd` and `popd` (bash `builtins/pushd.def`) over the
//! directory-stack record, and the `DIRSTACK` / `~N` views of it.
//!
//! The record holds the stack top first, without the current directory:
//! entry `i` is `DIRSTACK[i + 1]` and `~(i + 1)`.

use bstr::{BString, ByteSlice};

use super::{Ctx, R, dir, done, io::invalid_number, number};
use crate::bash::{
	store::{Key, KeyBuf, Record, StateStore, StoreError},
	vm::{Kernel, proc::Vproc, state},
};

/// The stack, top first, without the current directory.
pub fn entries(store: &mut dyn StateStore, vp: &Vproc) -> Result<Vec<BString>, StoreError> {
	Ok(match state::record(store, vp, Key::DirStack)? {
		Some(Record::DirStack(v)) => v.clone(),
		_ => Vec::new(),
	})
}

/// Replace the stack (also zsh's `cd`/`pushd`/`popd`/`dirs`).
pub fn store_entries(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	entries: Vec<BString>,
) {
	let rec = (!entries.is_empty()).then_some(Record::DirStack(entries));
	state::store_record(&mut k.root, store, vp, KeyBuf::DirStack, rec);
}

/// `DIRSTACK`'s value (bash `get_directory_stack`): the current
/// directory, then the stack top first.
pub fn dirstack_value(store: &mut dyn StateStore, vp: &Vproc) -> Result<Vec<BString>, StoreError> {
	let mut v = vec![vp.cwd.clone()];
	v.extend(entries(store, vp)?);
	Ok(v)
}

/// `DIRSTACK[index]=value` (bash `set_dirstack_element`): replaces stack
/// entry `index`; index 0 (the current directory) and indexes outside the
/// stack are ignored.
pub fn set_element(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	index: i64,
	value: BString,
) -> Result<(), StoreError> {
	let mut list = entries(store, vp)?;
	if let Some(slot) = usize::try_from(index)
		.ok()
		.and_then(|i| i.checked_sub(1))
		.and_then(|i| list.get_mut(i))
	{
		*slot = value;
		store_entries(k, store, vp, list);
	}
	Ok(())
}

/// Where `±N` points (bash `get_dirstack_index`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Slot {
	/// The current directory.
	Cwd,
	/// Stack entry (top first).
	Entry(usize),
	/// Outside the stack.
	Out,
}

/// bash `get_dirstack_index` for `+N` (`plus`) or `-N` over `len` entries.
fn slot(n: i64, plus: bool, len: usize) -> Slot {
	let len_i = i64::try_from(len).unwrap_or(i64::MAX);
	if n < 0 || n > len_i {
		return Slot::Out;
	}
	// `+N` counts from the current directory, `-N` from the bottom.
	let from_top = if plus { n } else { len_i - n };
	if from_top == 0 {
		Slot::Cwd
	} else {
		Slot::Entry((from_top - 1) as usize)
	}
}

/// `~N`, `~+N`, `~-N` (bash `get_dirstack_from_string`): the directory,
/// `None` when `spec` is not a number or is outside the stack. The
/// current directory is `$PWD`.
pub fn tilde(
	k: &Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
	spec: &[u8],
) -> Result<Option<BString>, StoreError> {
	let (plus, digits) = match spec.first() {
		Some(b'-') => (false, &spec[1..]),
		Some(b'+') => (true, &spec[1..]),
		_ => (true, spec),
	};
	let Some(n) = number(digits) else {
		return Ok(None);
	};
	let list = entries(store, vp)?;
	Ok(match slot(n, plus, list.len()) {
		Slot::Cwd => {
			state::lookup(&k.root, store, vp, b"PWD")?.and_then(|v| v.as_scalar().map(BString::from))
		},
		Slot::Entry(i) => list.get(i).cloned(),
		Slot::Out => None,
	})
}

/// bash `ISOPTION(word, c)`.
const fn is_option(word: &[u8], c: u8) -> bool {
	word.len() == 2 && word[0] == b'-' && word[1] == c
}

/// bash `pushd_error`.
fn stack_error(ctx: &mut Ctx<'_, '_>, len: usize, arg: &[u8]) {
	if len == 0 {
		ctx.usage("directory stack empty");
	} else {
		ctx.usage(format!("{}: directory stack index out of range", arg.as_bstr()));
	}
}

/// `±N`: an invalid number is reported with the usage line.
fn index_arg(ctx: &mut Ctx<'_, '_>, word: &[u8], usage: &[u8]) -> Result<i64, i32> {
	number(&word[1..]).ok_or_else(|| {
		ctx.usage(invalid_number(word));
		ctx.out_fd(2, usage);
		2
	})
}

/// An invalid option with the usage line.
fn bad_option(ctx: &mut Ctx<'_, '_>, word: &[u8], usage: &[u8]) -> R {
	ctx.usage(format!("{}: invalid option", word.as_bstr()));
	ctx.out_fd(2, usage);
	done(2)
}

/// The current directory as `dirs` shows it: `~` for `$HOME` unless
/// `long` (bash `polite_directory_format`).
pub fn polite(home: Option<&[u8]>, dir: &[u8], long: bool) -> BString {
	if !long
		&& let Some(home) = home.filter(|h| h.len() > 1)
		&& let Some(rest) = dir.strip_prefix(home)
		&& (rest.is_empty() || rest[0] == b'/')
	{
		let mut out = BString::from("~");
		out.extend_from_slice(rest);
		return out;
	}
	BString::from(dir)
}

const DIRS_USAGE: &[u8] = b"dirs: usage: dirs [-clpv] [+N] [-N]\n";
const PUSHD_USAGE: &[u8] = b"pushd: usage: pushd [-n] [+N | -N | dir]\n";
const POPD_USAGE: &[u8] = b"popd: usage: popd [-n] [+N | -N]\n";

/// `dirs [-clpv] [+N] [-N]`.
pub fn dirs(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let (mut long, mut clear, mut vflag) = (false, false, 0u8);
	let mut want: Option<(i64, bool, &[u8])> = None;
	for word in args {
		if is_option(word, b'l') {
			long = true;
		} else if is_option(word, b'c') {
			clear = true;
		} else if is_option(word, b'v') {
			vflag |= 2;
		} else if is_option(word, b'p') {
			vflag |= 1;
		} else if is_option(word, b'-') {
			break;
		} else if matches!(word.first(), Some(b'+' | b'-')) {
			let n = match index_arg(ctx, word, DIRS_USAGE) {
				Ok(n) => n,
				Err(st) => return done(st),
			};
			want = Some((n, word[0] == b'+', &word[1..]));
		} else {
			return bad_option(ctx, word, DIRS_USAGE);
		}
	}
	if clear {
		store_entries(ctx.k, ctx.cx.store, ctx.vp, Vec::new());
		return done(0);
	}
	let list = entries(ctx.cx.store, ctx.vp)?;
	let home = ctx.scalar(b"HOME")?;
	let show = |dir: &[u8]| polite(home.as_ref().map(|h| h.as_slice()), dir, long);
	let cwd = ctx.vp.cwd.clone();
	let mut out = Vec::new();
	if let Some((n, plus, digits)) = want {
		let (text, pos) = match slot(n, plus, list.len()) {
			Slot::Out => {
				stack_error(ctx, list.len(), digits);
				return done(1);
			},
			Slot::Cwd => (show(&cwd), 0),
			Slot::Entry(i) => (show(&list[i]), i + 1),
		};
		if vflag & 2 != 0 {
			out.extend_from_slice(format!("{pos:2}  ").as_bytes());
		}
		out.extend_from_slice(&text);
		out.push(b'\n');
		ctx.out(&out);
		return done(0);
	}
	if vflag & 2 != 0 {
		out.extend_from_slice(b" 0  ");
	}
	out.extend_from_slice(&show(&cwd));
	for (i, dir) in list.iter().enumerate() {
		if vflag >= 2 {
			out.extend_from_slice(format!("\n{:2}  ", i + 1).as_bytes());
		} else {
			out.push(if vflag & 1 != 0 { b'\n' } else { b' ' });
		}
		out.extend_from_slice(&show(dir));
	}
	out.push(b'\n');
	ctx.out(&out);
	done(0)
}

/// `cd -- dir` through the `cd` builtin (its diagnostics carry this
/// builtin's name); the status.
fn cd_to(ctx: &mut Ctx<'_, '_>, dir: &[u8]) -> Result<i32, super::Need> {
	Ok(dir::cd(ctx, &[BString::from("--"), BString::from(dir)])?.status)
}

/// `pushd [-n] [+N | -N | dir]`.
pub fn pushd(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let skipopt = args.first().is_some_and(|a| is_option(a, b'-'));
	let mut rest = if skipopt { &args[1..] } else { args };
	let mut list = entries(ctx.cx.store, ctx.vp)?;
	let cwd = ctx.vp.cwd.clone();
	if rest.is_empty() {
		// Swap the current directory and the top of the stack.
		let Some(top) = list.first().cloned() else {
			ctx.usage("no other directory");
			return done(1);
		};
		list[0] = cwd;
		let st = cd_to(ctx, &top)?;
		store_entries(ctx.k, ctx.cx.store, ctx.vp, list);
		if st == 0 {
			return dirs(ctx, &[]);
		}
		return done(st);
	}
	let mut nocd = false;
	let mut rotate = None;
	if !skipopt {
		while let Some(word) = rest.first() {
			if is_option(word, b'n') {
				nocd = true;
			} else if is_option(word, b'-') {
				rest = &rest[1..];
				break;
			} else if word.as_slice() == b"-" {
				break;
			} else if matches!(word.first(), Some(b'+' | b'-')) {
				let n = match index_arg(ctx, word, PUSHD_USAGE) {
					Ok(n) => n,
					Err(st) => return done(st),
				};
				let len = i64::try_from(list.len()).unwrap_or(i64::MAX);
				let n = if word[0] == b'-' { len - n } else { n };
				if n > len || n < 0 {
					stack_error(ctx, list.len(), word);
					return done(1);
				}
				rotate = Some(n as usize);
			} else {
				break;
			}
			rest = &rest[1..];
		}
	}
	if let Some(n) = rotate {
		if n == 0 {
			if nocd {
				return done(0);
			}
			let st = cd_to(ctx, &cwd)?;
			return if st == 0 { dirs(ctx, &[]) } else { done(st) };
		}
		// Rotate the ring [cwd, top, …] so element `n` leads.
		let mut ring = Vec::with_capacity(list.len() + 1);
		ring.push(cwd);
		ring.append(&mut list);
		ring.rotate_left(n);
		let front = ring.remove(0);
		if nocd {
			store_entries(ctx.k, ctx.cx.store, ctx.vp, ring);
			return done(0);
		}
		let st = cd_to(ctx, &front)?;
		store_entries(ctx.k, ctx.cx.store, ctx.vp, ring);
		return if st == 0 { dirs(ctx, &[]) } else { done(st) };
	}
	let Some(dir) = rest.first() else {
		return done(0);
	};
	if !nocd {
		let cd_args = if skipopt { args } else { rest };
		let st = dir::cd(ctx, cd_args)?.status;
		if st != 0 {
			return done(1);
		}
	}
	list.insert(0, if nocd { dir.clone() } else { cwd });
	store_entries(ctx.k, ctx.cx.store, ctx.vp, list);
	dirs(ctx, &[])
}

/// `popd [-n] [+N | -N]`.
pub fn popd(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let mut nocd = false;
	let mut which: i64 = 0;
	let mut plus = true;
	let mut which_word: &[u8] = b"";
	for word in args {
		if is_option(word, b'n') {
			nocd = true;
		} else if is_option(word, b'-') {
			break;
		} else if matches!(word.first(), Some(b'+' | b'-')) {
			which = match index_arg(ctx, word, POPD_USAGE) {
				Ok(n) => n,
				Err(st) => return done(st),
			};
			plus = word[0] == b'+';
			which_word = word;
		} else if !word.is_empty() {
			ctx.usage(format!("{}: invalid argument", word.as_bstr()));
			ctx.out_fd(2, POPD_USAGE);
			return done(2);
		} else {
			break;
		}
	}
	let mut list = entries(ctx.cx.store, ctx.vp)?;
	let len = i64::try_from(list.len()).unwrap_or(i64::MAX);
	if which > len || which < -len || (len == 0 && which == 0) {
		stack_error(ctx, list.len(), which_word);
		return done(1);
	}
	// Entry index from the top: `+N` is the Nth entry, `-N` counts from
	// the bottom (bash's list index N).
	let from_top = if plus { which } else { len - which };
	if from_top == 0 {
		// The top entry: change to it.
		if !nocd {
			let top = list[0].clone();
			let st = cd_to(ctx, &top)?;
			if st != 0 {
				return done(st);
			}
		}
		list.remove(0);
	} else {
		let Some(i) = from_top
			.checked_sub(1)
			.and_then(|i| usize::try_from(i).ok())
			.filter(|&i| i < list.len())
		else {
			stack_error(ctx, list.len(), which_word);
			return done(1);
		};
		list.remove(i);
	}
	store_entries(ctx.k, ctx.cx.store, ctx.vp, list);
	dirs(ctx, &[])
}

#[cfg(test)]
mod tests {
	use super::*;

	// bash `get_dirstack_index` over a stack of 3 below the cwd.
	#[test]
	fn indexes_count_from_the_cwd_or_the_bottom() {
		assert_eq!(slot(0, true, 3), Slot::Cwd);
		assert_eq!(slot(1, true, 3), Slot::Entry(0));
		assert_eq!(slot(3, true, 3), Slot::Entry(2));
		assert_eq!(slot(0, false, 3), Slot::Entry(2));
		assert_eq!(slot(3, false, 3), Slot::Cwd);
		assert_eq!(slot(4, true, 3), Slot::Out);
		assert_eq!(slot(9, false, 3), Slot::Out);
		assert_eq!(slot(0, false, 0), Slot::Cwd);
	}

	#[test]
	fn home_prefix_becomes_a_tilde() {
		assert_eq!(polite(Some(b"/home/u"), b"/home/u/x", false), "~/x");
		assert_eq!(polite(Some(b"/home/u"), b"/home/u", false), "~");
		assert_eq!(polite(Some(b"/home/u"), b"/home/ux", false), "/home/ux");
		assert_eq!(polite(Some(b"/home/u"), b"/home/u/x", true), "/home/u/x");
		assert_eq!(polite(Some(b"/"), b"/x", false), "/x");
	}
}
