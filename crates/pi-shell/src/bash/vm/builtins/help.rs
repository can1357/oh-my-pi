//! `help` and every builtin's `--help` (bash `builtins/help.def`) over
//! bash's documentation table.

use bstr::{BString, ByteSlice};

use super::{
	Ctx, Need, R,
	doc_table::{Entry, TABLE},
	done, misc, number, opts,
};
use crate::bash::{
	pattern::{PatOpts, glob::glob_pattern_p},
	store::OptId,
	vm::locale,
};

/// The `strmatch` loadable's entry, listed once `enable -f` loaded it.
pub static STRMATCH: Entry = Entry {
	name:    "strmatch",
	short:   "strmatch string pattern",
	long:    &["This is a builtin to test the behavior of strmatch"],
	special: false,
	command: true,
};

/// bash's `bash_copyright`.
const COPYRIGHT: &str = "Copyright (C) 2025 Free Software Foundation, Inc.";

/// bash's `bash_license` (its own trailing newline included).
const LICENSE: &str =
	"License GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>\n";

/// Indent of long documentation lines (bash `BASE_INDENT`).
const INDENT: &str = "    ";

/// The table this shell has (loaded builtins included, in bash's sorted
/// order) with each entry's enabled flag.
fn entries(ctx: &mut Ctx<'_, '_>) -> Result<Vec<(&'static Entry, bool)>, Need> {
	let mut list: Vec<&'static Entry> = TABLE.iter().collect();
	if misc::loaded(ctx, STRMATCH.name.as_bytes())? {
		list.push(&STRMATCH);
		list.sort_by_key(|e| e.name.as_bytes());
	}
	let mut out = Vec::with_capacity(list.len());
	for e in list {
		out.push((e, misc::enabled(ctx, e.name.as_bytes())?));
	}
	Ok(out)
}

/// bash `show_shell_version(0)`: `GNU bash, version V (MACHTYPE)`.
fn version_line(ctx: &mut Ctx<'_, '_>) -> Result<String, Need> {
	let version = ctx.scalar(b"BASH_VERSION")?.unwrap_or_default();
	let machtype = ctx.scalar(b"MACHTYPE")?.unwrap_or_default();
	Ok(format!("GNU bash, version {} ({})\n", version.as_bstr(), machtype.as_bstr()))
}

/// `NAME: SYNOPSIS` then the long description (bash `builtin_help` /
/// `show_longdoc`).
fn long_doc(out: &mut Vec<u8>, e: &Entry, synopsis_only: bool) {
	out.extend_from_slice(format!("{}: {}\n", e.name, e.short).as_bytes());
	if !synopsis_only {
		for line in e.long {
			out.extend_from_slice(format!("{INDENT}{line}\n").as_bytes());
		}
	}
}

/// `NAME --help`: the builtin's synopsis and description on stdout, status
/// 2 (bash `CHECK_HELPOPT`).
pub fn builtin_help(ctx: &mut Ctx<'_, '_>) -> R {
	let name = ctx.name;
	let entry = TABLE
		.iter()
		.chain(std::iter::once(&STRMATCH))
		.find(|e| e.command && e.name == name);
	if let Some(e) = entry {
		let mut out = Vec::new();
		long_doc(&mut out, e, false);
		ctx.out(&out);
	}
	done(2)
}

/// bash `dispcolumn`/`wdispcolumn`: one column of the `help` listing.
fn column(doc: &str, enabled: bool, width: usize, first: bool, utf8: bool) -> String {
	let flag = if enabled { ' ' } else { '*' };
	let chars: Vec<char> = doc.chars().collect();
	let keep = if utf8 {
		let shown = chars.len().min(width.saturating_sub(2));
		(shown + 1 >= width.saturating_sub(2))
			.then(|| shown.saturating_sub(if first { 1 } else { 2 }))
	} else {
		let limit = width.saturating_sub(if first { 3 } else { 4 });
		(chars.len() >= limit).then_some(limit)
	};
	let mut s = String::with_capacity(width);
	s.push(flag);
	match keep {
		Some(n) => {
			s.extend(&chars[..n.min(chars.len())]);
			s.push('>');
		},
		None => s.push_str(doc),
	}
	s
}

/// bash `show_builtin_command_help`: the two-column table.
fn listing(entries: &[(&Entry, bool)], columns: usize, utf8: bool) -> String {
	let mut width = columns / 2;
	width = width.min(128);
	if width <= 3 {
		width = 40;
	}
	let n = entries.len();
	let height = n.div_ceil(2);
	let mut out = String::from(
		"These shell commands are defined internally.  Type `help' to see this list.\nType `help \
		 name' to find out more about the function `name'.\nUse `info bash' to find out more about \
		 the shell in general.\nUse `man -k' or `info' to find out more about commands not in this \
		 list.\n\nA star (*) next to a name means that the command is disabled.\n\n",
	);
	for i in 0..height {
		let (e, on) = entries[i];
		let first = column(e.short, on, width, true, utf8);
		if (i << 1) >= n || i + height >= n {
			out.push_str(&first);
			out.push('\n');
			continue;
		}
		out.push_str(&first);
		for _ in first.chars().count()..width {
			out.push(' ');
		}
		let (e2, on2) = entries[i + height];
		out.push_str(&column(e2.short, on2, width, false, utf8));
		out.push('\n');
	}
	out
}

/// `help [-dms] [pattern ...]`.
pub fn help(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"dms", b"", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let (desc, man, short) = (o.has(b'd'), o.has(b'm'), o.has(b's'));
	let list = entries(ctx)?;
	let utf8 = locale::is_utf8(ctx.k, ctx.cx.store, ctx.vp);
	let mut out = Vec::new();
	if o.rest.is_empty() {
		let columns = ctx
			.scalar(b"COLUMNS")?
			.and_then(|c| number(&c))
			.and_then(|c| usize::try_from(c).ok())
			.filter(|&c| c > 0)
			.unwrap_or(80);
		out.extend_from_slice(version_line(ctx)?.as_bytes());
		out.extend_from_slice(listing(&list, columns, utf8).as_bytes());
		ctx.out(&out);
		return done(0);
	}
	if glob_pattern_p(&o.rest[0]) {
		let several = if o.rest.len() > 1 {
			"keywords"
		} else {
			"keyword"
		};
		out.extend_from_slice(format!("Shell commands matching {several} `").as_bytes());
		out.extend_from_slice(&bstr::join(", ", o.rest));
		out.extend_from_slice(b"'\n\n");
	}
	let extglob = ctx.option(OptId::Extglob)?;
	let opts = PatOpts::shell(extglob, false, utf8);
	let mut found = 0;
	let mut pattern: &[u8] = b"";
	for pat in o.rest {
		pattern = pat;
		for pass in 1..3 {
			let mut this = false;
			for &(e, _) in &list {
				let name = e.name.as_bytes();
				let matched = if pass == 1 {
					name == pat.as_slice() || ctx.k.engine.patterns().get(pat, opts).matches(name)
				} else {
					name.starts_with(pat)
				};
				if !matched {
					continue;
				}
				this = true;
				found += 1;
				if desc {
					let first = e.long.first().copied().unwrap_or_default();
					out.extend_from_slice(format!("{} - {first}\n", e.name).as_bytes());
				} else if man {
					manpage(&mut out, e, &version_line(ctx)?);
				} else {
					long_doc(&mut out, e, short);
				}
			}
			if pass == 1 && this {
				break;
			}
		}
	}
	if found == 0 {
		let p = pattern.as_bstr();
		ctx.usage(format!(
			"no help topics match `{p}'.  Try `help help' or `man -k {p}' or `info {p}'."
		));
		return done(1);
	}
	ctx.out(&out);
	done(0)
}

/// bash `show_manpage`.
fn manpage(out: &mut Vec<u8>, e: &Entry, version: &str) {
	let first = e.long.first().copied().unwrap_or_default();
	let lines = [
		"NAME".to_owned(),
		format!("{INDENT}{} - {first}", e.name),
		String::new(),
		"SYNOPSIS".to_owned(),
		format!("{INDENT}{}", e.short),
		String::new(),
		"DESCRIPTION".to_owned(),
	];
	for line in lines {
		out.extend_from_slice(line.as_bytes());
		out.push(b'\n');
	}
	for line in e.long {
		out.extend_from_slice(INDENT.as_bytes());
		out.extend_from_slice(line.as_bytes());
		out.push(b'\n');
	}
	for line in ["", "SEE ALSO", "    bash(1)", "", "IMPLEMENTATION"] {
		out.extend_from_slice(line.as_bytes());
		out.push(b'\n');
	}
	// The version line and the license carry their own newlines.
	for part in [INDENT, version, INDENT, COPYRIGHT, "\n", INDENT, LICENSE, "\n"] {
		out.extend_from_slice(part.as_bytes());
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn all() -> Vec<(&'static Entry, bool)> {
		TABLE.iter().map(|e| (e, true)).collect()
	}

	// Goldens: bash 5.3.20 `help | sed 1,8d` with COLUMNS=80 (C and UTF-8
	// locales differ only at truncation boundaries).
	#[test]
	fn listing_matches_bash_columns() {
		let c = listing(&all(), 80, false);
		let lines: Vec<&str> = c.lines().collect();
		assert_eq!(
			lines[7],
			" ! PIPELINE                              history [-c] [-d offset] [n] or hist>"
		);
		assert_eq!(lines[45], " help [-dms] [pattern ...]");
		let u = listing(&all(), 80, true);
		assert!(u.contains(
			" coproc [NAME] command [redirections]    source [-p path] filename [argument>\n"
		));
		assert!(c.contains(
			" coproc [NAME] command [redirections]    source [-p path] filename [arguments>\n"
		));
		let narrow = listing(&all(), 57, true);
		assert!(narrow.ends_with(" help [-dms] [pattern ...>\n"));
	}

	// Golden: bash 5.3.20 `help shift`.
	#[test]
	fn long_doc_indents_by_four() {
		let shift = TABLE.iter().find(|e| e.name == "shift").unwrap();
		let mut out = Vec::new();
		long_doc(&mut out, shift, false);
		let text = String::from_utf8(out).unwrap();
		assert!(text.starts_with("shift: shift [n]\n    Shift positional parameters.\n    \n"));
		assert!(text.ends_with("    Returns success unless N is negative or greater than $#.\n"));
	}
}
