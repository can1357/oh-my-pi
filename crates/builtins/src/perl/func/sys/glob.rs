//! Perl's csh-style filename expansion (perlop, perlfunc, File::Glob).

use std::{collections::VecDeque, rc::Rc};

use crate::perl::{ast::Call, interp::{Cx, Flow, Interp, PResult, Ret}, value::{PStr, Value}};

use super::{list, nul_in_name, one, topic};

#[derive(Clone, Eq, Hash, PartialEq)]
pub(super) enum Site { Expr(usize), Location(Rc<str>, u32) }

/// Expand filenames, using the current source location as the scalar call-site key.
pub(in crate::perl) fn glob(interp: &mut Interp<'_>, pattern: PStr, cx: Cx) -> PResult<Ret> {
	let loc = interp.location();
	at(interp, Site::Location(loc.file, loc.line), pattern, cx)
}

/// Expand filenames at a stable AST site (including distinct globs on one line).
pub(in crate::perl) fn glob_at(interp: &mut Interp<'_>, site: usize, pattern: PStr, cx: Cx) -> PResult<Ret> {
	at(interp, Site::Expr(site), pattern, cx)
}

pub(super) fn call(interp: &mut Interp<'_>, call: &Call, cx: Cx) -> PResult<Ret> {
	let value = match list(interp, call)?.into_iter().next() { Some(v) => v, None => topic(interp)? };
	let pattern = interp.stringify(&value)?;
	glob_at(interp, call as *const Call as usize, pattern, cx)
}

fn at(interp: &mut Interp<'_>, site: Site, pattern: PStr, cx: Cx) -> PResult<Ret> {
	if nul_in_name(interp, "glob", "pattern", &pattern.bytes) {
		interp.sys.glob_sites.remove(&site);
		return Ok(if cx == Cx::List { Ret::Many(Vec::new()) } else { one(Value::Undef) });
	}
	if cx == Cx::List {
		interp.sys.glob_sites.remove(&site);
		return Ok(Ret::Many(expand(interp, pattern)?));
	}
	if let Some(active) = interp.sys.glob_sites.get_mut(&site) {
		if let Some(v) = active.pop_front() { return Ok(one(v)); }
		interp.sys.glob_sites.remove(&site);
		return Ok(one(Value::Undef));
	}
	let mut expanded = VecDeque::from(expand(interp, pattern)?);
	let Some(first) = expanded.pop_front() else { return Ok(one(Value::Undef)); };
	interp.sys.glob_sites.insert(site, expanded);
	Ok(one(first))
}

/// File::Glob option bits that change expansion (values from bsd_glob.h).
#[derive(Clone, Copy)]
struct Opts {
	brace: bool,
	tilde: bool,
	/// Return the pattern itself when nothing matches.
	nocheck: bool,
	/// Return a pattern without wildcards itself when nothing matches.
	nomagic: bool,
	/// Append `/` to directories.
	mark: bool,
	/// `None` keeps directory order; `Some(true)` sorts case-insensitively first.
	sort: Option<bool>,
	nocase: bool,
	/// Stop at the first unreadable directory.
	err: bool,
}

/// Perl's built-in `glob`: File::Glob's csh_glob flags.
const CSH: Opts = Opts { brace: true, tilde: true, nocheck: false, nomagic: true, mark: false, sort: Some(true), nocase: false, err: false };

/// File::Glob::bsd_glob: expand one pattern (no word splitting) under the
/// bsd_glob.h `flags` (GLOB_ERR 0x4, MARK 0x8, NOCHECK 0x10, NOSORT 0x20,
/// BRACE 0x80, NOMAGIC 0x200, QUOTE 0x400, TILDE 0x800, NOCASE 0x1000,
/// ALPHASORT 0x2000). Errors set `$!` and return what matched so far.
pub(in crate::perl) fn bsd_glob(interp: &mut Interp<'_>, pattern: &[u8], flags: i32) -> PResult<Vec<Value>> {
	let opts = Opts {
		brace: flags & 0x80 != 0, tilde: flags & 0x800 != 0, nocheck: flags & 0x10 != 0, nomagic: flags & 0x200 != 0,
		mark: flags & 0x8 != 0, sort: (flags & 0x20 == 0).then_some(flags & 0x2000 != 0), nocase: flags & 0x1000 != 0,
		err: flags & 0x4 != 0,
	};
	// Without GLOB_QUOTE a backslash is an ordinary character.
	let word = if flags & 0x400 != 0 { pattern.to_vec() } else {
		let mut escaped = Vec::with_capacity(pattern.len());
		for &b in pattern { if b == b'\\' { escaped.push(b'\\'); } escaped.push(b); }
		escaped
	};
	let mut results = Vec::new();
	expand_word(interp, word, opts, false, &mut results)?;
	Ok(results)
}

fn expand(interp: &mut Interp<'_>, pattern: PStr) -> PResult<Vec<Value>> {
	let mut results = Vec::new();
	for word in words(&pattern.bytes) {
		expand_word(interp, word, CSH, pattern.utf8, &mut results)?;
	}
	Ok(results)
}

fn expand_word(interp: &mut Interp<'_>, word: Vec<u8>, opts: Opts, utf8: bool, results: &mut Vec<Value>) -> PResult<()> {
	{
		let mut pending = vec![word];
		while let Some(word) = pending.pop() {
			if interp.is_cancelled() { return Err(Flow::Cancelled); }
			if opts.brace && let Some((start, end, commas)) = braces(&word) {
				let mut bound = end;
				for left in commas.into_iter().rev().chain(std::iter::once(start)) {
					let mut item = Vec::with_capacity(word.len() - (end - start) + bound - left);
					item.extend_from_slice(&word[..start]);
					item.extend_from_slice(&word[left + 1..bound]);
					item.extend_from_slice(&word[end + 1..]);
					pending.push(item);
					bound = left;
				}
				continue;
			}
			let word = if opts.tilde { tilde(interp, word) } else { word };
			let mut matched = files(interp, &word, opts)?;
			if matched.is_empty() && (opts.nocheck || opts.nomagic && !wildcard(&word)) {
				matched.push(unquote(&word));
			}
			match opts.sort {
				Some(true) => matched.sort_unstable_by(|a, b| {
					a.iter().map(u8::to_ascii_lowercase).cmp(b.iter().map(u8::to_ascii_lowercase)).then_with(|| a.cmp(b))
				}),
				Some(false) => matched.sort_unstable(),
				None => {},
			}
			if opts.mark {
				for name in &mut matched {
					let path = interp.resolve_path(name);
					if !name.ends_with(b"/") && interp.host().fs().metadata(path).is_ok_and(|m| m.is_dir()) {
						name.push(b'/');
					}
				}
			}
			results.extend(matched.into_iter().map(|bytes| {
				let utf8 = utf8 && std::str::from_utf8(&bytes).is_ok();
				Value::Str(PStr::new(bytes, utf8))
			}));
		}
	}
	Ok(())
}

fn words(pattern: &[u8]) -> Vec<Vec<u8>> {
	let mut out = Vec::new();
	let mut word = Vec::new();
	let mut quote = None;
	let mut started = false;
	let mut it = pattern.iter().copied();
	while let Some(b) = it.next() {
		if b == b'\\' {
			word.push(b);
			if let Some(next) = it.next() { word.push(next); }
			started = true;
		} else if quote.is_some_and(|(q, _)| q == b) {
			quote = None;
		} else if quote.is_none() && matches!(b, b'\'' | b'"') {
			quote = Some((b, word.len()));
			started = true;
		} else if quote.is_none() && b.is_ascii_whitespace() {
			if started { out.push(std::mem::take(&mut word)); }
			started = false;
		} else {
			word.push(b);
			started = true;
		}
	}
	if let Some((quote, at)) = quote { word.insert(at, quote); }
	if started { out.push(word); }
	out
}

fn braces(word: &[u8]) -> Option<(usize, usize, Vec<usize>)> {
	let (mut start, mut depth, mut commas) = (0, 0usize, Vec::new());
	let mut bytes = word.iter().copied().enumerate();
	while let Some((i, ch)) = bytes.next() {
		match ch {
			b'\\' => { bytes.next(); },
			b'{' => { if depth == 0 { start = i; } depth += 1; },
			b'}' if depth > 0 => {
				depth -= 1;
				if depth == 0 {
					if i > start + 1 { return Some((start, i, commas)); }
					commas.clear();
				}
			},
			b',' if depth == 1 => commas.push(i),
			_ => {},
		}
	}
	None
}

fn tilde(interp: &mut Interp<'_>, word: Vec<u8>) -> Vec<u8> {
	if word.first() != Some(&b'~') { return word; }
	let end = memchr::memchr(b'/', &word).unwrap_or(word.len());
	let name = &word[1..end];
	let home = if name.is_empty() {
		interp.env_pairs().into_iter().find(|(n, _)| n == b"HOME").map(|(_, value)| value)
	} else {
		#[cfg(unix)]
		{
			std::str::from_utf8(name).ok().and_then(|name| nix::unistd::User::from_name(name).ok().flatten())
				.map(|user| user.dir.into_os_string().into_encoded_bytes())
		}
		#[cfg(not(unix))]
		{ None }
	};
	let Some(home) = home else { return word; };
	let mut expanded = Vec::with_capacity(home.len() + word.len() - end);
	for ch in home {
		if matches!(ch, b'*' | b'?' | b'[' | b'\\') { expanded.push(b'\\'); }
		expanded.push(ch);
	}
	expanded.extend_from_slice(&word[end..]);
	expanded
}

fn files(interp: &mut Interp<'_>, pattern: &[u8], opts: Opts) -> PResult<Vec<Vec<u8>>> {
	if !wildcard(pattern) {
		// csh_glob returns a literal word whether or not it exists (GLOB_NOMAGIC).
		let word = unquote(pattern);
		if opts.nomagic || opts.nocheck { return Ok(vec![word]); }
		let path = interp.resolve_path(&word);
		let exists = interp.host().fs().symlink_metadata(path).is_ok();
		return Ok(if exists { vec![word] } else { Vec::new() });
	}
	let mut heads = vec![Vec::new()];
	let mut parts = pattern.split(|&c| c == b'/').peekable();
	while let Some(part) = parts.next() {
		let slash = parts.peek().is_some();
		if !wildcard(part) {
			let word = unquote(part);
			for head in &mut heads {
				head.extend_from_slice(&word);
				if slash { head.push(b'/'); }
			}
			continue;
		}
		let dot = part.starts_with(b".") || part.starts_with(b"\\.");
		let mut next = Vec::new();
		for head in heads {
			if interp.is_cancelled() { return Err(Flow::Cancelled); }
			let parent = interp.resolve_path(if head.is_empty() { b"." } else { &head });
			let entries = match interp.host().fs().read_dir(parent) {
				Ok(entries) => entries,
				Err(e) if opts.err => { super::set_io_errno(interp, &e); return Ok(Vec::new()); },
				Err(_) => continue,
			};
			let append = |next: &mut Vec<Vec<u8>>, name: &[u8]| {
				if (dot || name.first() != Some(&b'.')) && matches(part, name, opts.nocase) {
					let mut full = Vec::with_capacity(head.len() + name.len() + usize::from(slash));
					full.extend_from_slice(&head);
					full.extend_from_slice(name);
					if slash { full.push(b'/'); }
					next.push(full);
				}
			};
			if dot {
				append(&mut next, b".");
				append(&mut next, b"..");
			}
			for entry in entries {
				if interp.is_cancelled() { return Err(Flow::Cancelled); }
				let Ok(entry) = entry else { continue };
				append(&mut next, entry.file_name().as_encoded_bytes());
			}
		}
		heads = next;
		if heads.is_empty() { break; }
	}
	let directory = pattern.ends_with(b"/");
	heads.retain(|head| {
		let path = interp.resolve_path(head);
		if directory { interp.host().fs().metadata(path).is_ok_and(|m| m.is_dir()) }
		else { interp.host().fs().symlink_metadata(path).is_ok() }
	});
	Ok(heads)
}

fn wildcard(pat: &[u8]) -> bool {
	let mut i = 0;
	while let Some(&b) = pat.get(i) {
		match b {
			b'\\' => i += 1,
			b'*' | b'?' => return true,
			b'[' if bracket(&pat[i..], 0).is_some() => return true,
			_ => {},
		}
		i += 1;
	}
	false
}

fn unquote(pat: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(pat.len());
	let mut it = pat.iter().copied();
	while let Some(b) = it.next() { out.push(if b == b'\\' { it.next().unwrap_or(b) } else { b }); }
	out
}

fn matches(pattern: &[u8], name: &[u8], nocase: bool) -> bool {
	let mut p = 0;
	let mut n = 0;
	let mut star = None;
	while n < name.len() {
		let byte = name[n];
		let same = |b: u8| if nocase { b.eq_ignore_ascii_case(&byte) } else { b == byte };
		match pattern.get(p) {
			Some(b'*') => { p += 1; star = Some((p, n)); continue; },
			Some(b'?') => { p += 1; n += 1; continue; },
			Some(b'[') => match bracket(&pattern[p..], byte) {
				Some((used, true)) => { p += used; n += 1; continue; },
				Some((used, false)) if nocase && byte.is_ascii_alphabetic()
					&& bracket(&pattern[p..], byte ^ 0x20).is_some_and(|(_, hit)| hit) => { p += used; n += 1; continue; },
				None if byte == b'[' => { p += 1; n += 1; continue; },
				_ => {},
			},
			Some(b'\\') if same(pattern.get(p + 1).copied().unwrap_or(b'\\')) => {
				p += if p + 1 < pattern.len() { 2 } else { 1 }; n += 1; continue;
			},
			Some(&b) if same(b) && b != b'\\' => { p += 1; n += 1; continue; },
			_ => {},
		}
		let Some((after, retry)) = star else { return false; };
		p = after;
		n = retry + 1;
		star = Some((p, n));
	}
	pattern[p..].iter().all(|&b| b == b'*')
}

fn bracket(pattern: &[u8], byte: u8) -> Option<(usize, bool)> {
	let mut i = 1;
	let negate = matches!(pattern.get(i), Some(b'!' | b'^'));
	if negate { i += 1; }
	let first = i;
	let mut hit = false;
	while let Some(&b) = pattern.get(i) {
		if b == b']' && i > first { return Some((i + 1, hit != negate)); }
		let lo = if b == b'\\' { i += 1; *pattern.get(i)? } else { b };
		i += 1;
		if pattern.get(i) == Some(&b'-') && pattern.get(i + 1).is_some_and(|&c| c != b']') {
			i += 1;
			if pattern.get(i) == Some(&b'\\') { i += 1; }
			let hi = *pattern.get(i)?;
			i += 1;
			hit |= (lo..=hi).contains(&byte);
		} else { hit |= lo == byte; }
	}
	None
}
