//! Lexical path operations, cwd resolution, and script location.

use std::{io, path::Path};

use omp_vfs::{CanonicalizeOptions, MissingHandling, ResolveMode};

use super::{cwd, env, export_tag, failure, isa, one, os, path_value};
use crate::perl::{
	interp::{Cx, Interp, NativeFn, PResult, Ret},
	modules::{arg, boolean, define, export, list, version},
	regex::{ExecOpts, Regex, RxFlags},
	value::{PStr, Ref, Sv, Value},
};

const SPEC_DEFAULT: &[&str] = &[
	"canonpath", "catdir", "catfile", "curdir", "rootdir", "updir", "no_upwards", "file_name_is_absolute", "path",
];
const SPEC_OPTIONAL: &[&str] = &[
	"devnull", "tmpdir", "splitpath", "splitdir", "catpath", "abs2rel", "rel2abs", "case_tolerant",
];

/// Install a lexical path, cwd, or script locator module.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	match module {
		"Cwd" => {
			version(interp, module, "3.80");
			let defaults = ["cwd", "getcwd", "fastcwd", "fastgetcwd"];
			let options = ["chdir", "abs_path", "fast_abs_path", "realpath", "fast_realpath"];
			for name in defaults { interp.define_native(&format!("Cwd::{name}"), getcwd); }
			define(interp, module, &[("abs_path", abs_path), ("realpath", abs_path),
				("fast_abs_path", fast_abs_path), ("fast_realpath", fast_abs_path), ("chdir", chdir)]);
			export(interp, module, &defaults, &options);
		},
		"FindBin" => {
			version(interp, module, "1.52");
			define(interp, module, &[("again", again)]);
			export(interp, module, &[], &["$Bin", "$Script", "$RealBin", "$RealScript", "$Dir", "$RealDir"]);
			find_bin(interp)?;
		},
		"File::Basename" => {
			version(interp, module, "2.85");
			define(interp, module, &[("basename", basename), ("dirname", dirname), ("fileparse", fileparse),
				("fileparse_set_fstype", set_fstype)]);
			export(interp, module, &["fileparse", "fileparse_set_fstype", "basename", "dirname"], &[]);
			interp.sv("File::Basename::Fileparse_fstype").set(Value::str("Unix"));
		},
		"File::Spec" => {
			version(interp, module, "3.80");
			install_spec(interp, "File::Spec::Unix", false);
			isa(interp, module, &["File::Spec::Unix"]);
		},
		"File::Spec::Unix" => install_spec(interp, module, false),
		"File::Spec::Functions" => {
			install_spec(interp, module, true);
			export(interp, module, SPEC_DEFAULT, SPEC_OPTIONAL);
			let all: Vec<_> = SPEC_OPTIONAL.iter().chain(SPEC_DEFAULT).copied().collect();
			export_tag(interp, module, "ALL", &all);
		},
		_ => unreachable!(),
	}
	Ok(())
}

pub(super) fn getcwd(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	canonical_path(interp, b".", MissingHandling::Existing)
}

fn abs_path(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let path = arg(&args, 0).to_pstr();
	let path = if path.is_empty() { b".".as_slice() } else { &path.bytes };
	let missing = if path.ends_with(b"/") || matches!(path.rsplit(|b| *b == b'/').next(), Some(b"." | b"..")) {
		MissingHandling::Existing
	} else {
		MissingHandling::Normal
	};
	canonical_path(interp, path, missing)
}

fn fast_abs_path(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let path = if let Some(sv) = args.first() { interp.read_sv(sv)?.to_pstr() } else { PStr::from_bytes(b".") };
	if path.is_empty() {
		return failure(interp, io::Error::from_raw_os_error(libc::ENOENT));
	}
	canonical_path(interp, &path.bytes, MissingHandling::Existing)
}

fn canonical_path(interp: &mut Interp<'_>, path: &[u8], missing: MissingHandling) -> PResult<Ret> {
	let resolved = interp.resolve_path(path);
	let options = CanonicalizeOptions::new(missing, ResolveMode::Physical);
	match interp.host().fs().canonicalize_with(resolved, &options) {
		Ok(path) => one(path_value(&path)),
		Err(err) => failure(interp, err),
	}
}

fn chdir(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut path = arg(&args, 0).to_pstr();
	if args.is_empty() {
		path = env(interp, b"HOME")?;
		if path.is_empty() { path = env(interp, b"LOGDIR")?; }
	}
	let result = if path.is_empty() {
		Err(io::Error::from_raw_os_error(libc::ENOENT))
	} else {
		let dir = interp.resolve_path(&path.bytes);
		let fs = interp.host().fs();
		fs.metadata(&dir).and_then(|meta| if meta.is_dir() {
			fs.canonicalize(&dir)
		} else {
			Err(io::Error::from_raw_os_error(libc::ENOTDIR))
		})
	};
	match result {
		Ok(dir) => {
			use crate::perl::value::{HKey, new_sv};
			interp.hv("main::ENV").entries_mut().insert(HKey::new(&PStr::from_bytes(b"PWD")), new_sv(path_value(&dir)));
			interp.set_cwd(dir);
			Ok(boolean(true))
		},
		Err(err) => { interp.set_errno(&err); Ok(boolean(false)) },
	}
}

fn again(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	find_bin(interp)?;
	Ok(Ret::empty())
}

fn find_bin(interp: &mut Interp<'_>) -> PResult<()> {
	let slot = interp.sv("main::0");
	let script = interp.read_sv(&slot)?.to_pstr();
	let path = if matches!(script.bytes.as_slice(), b"-e" | b"-") {
		let pwd = cwd(interp);
		let pwd = interp.host().fs().canonicalize(&pwd).unwrap_or(pwd);
		omp_vfs::join_path(&pwd, Path::new(&*os(&script.bytes)))
	} else {
		let path = interp.resolve_path(&script.bytes);
		if interp.host().fs().metadata(&path).is_ok_and(|m| m.is_file()) {
			path
		} else {
			let found = if script.bytes.contains(&b'/') { None } else {
				let search = env(interp, b"PATH")?;
				search.bytes.split(|b| *b == b':').find_map(|dir| {
					let parent = interp.resolve_path(if dir.is_empty() { b"." } else { dir });
					let candidate = omp_vfs::join_path(&parent, Path::new(&*os(&script.bytes)));
					interp.host().fs().metadata(&candidate).is_ok_and(|m| m.is_file()).then_some(candidate)
				})
			};
			found.ok_or_else(|| interp.die_msg(format!("Cannot find current script '{}'", script.to_string_lossy())))?
		}
	};
	let real = interp.host().fs().canonicalize(&path).unwrap_or_else(|_| path.clone());
	for (bin, alias, name, path) in [("Bin", "Dir", "Script", &path), ("RealBin", "RealDir", "RealScript", &real)] {
		let parent = omp_vfs::parent_path(path).filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
		interp.sv(&format!("FindBin::{bin}")).set(path_value(parent));
		let slot = interp.glob(&format!("FindBin::{bin}")).scalar.borrow().clone();
		interp.glob(&format!("FindBin::{alias}")).scalar.replace(slot);
		interp.sv(&format!("FindBin::{name}")).set(path.file_name().map_or(Value::Undef, |s| Value::bytes(s.as_encoded_bytes())));
	}
	Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Style { Unix, Dos, Os2, Mac, Vms }

impl Style {
	fn current(interp: &mut Interp<'_>) -> Self {
		match interp.sv("File::Basename::Fileparse_fstype").get().to_pstr().bytes.as_slice() {
			b"DOS" | b"MSWin32" => Self::Dos,
			b"OS2" => Self::Os2,
			b"MacOS" => Self::Mac,
			b"VMS" => Self::Vms,
			_ => Self::Unix,
		}
	}

	fn separator(self, byte: u8) -> bool {
		match self {
			Self::Dos | Self::Os2 => matches!(byte, b'/' | b'\\'),
			Self::Mac => byte == b':',
			Self::Vms | Self::Unix => byte == b'/',
		}
	}
}

fn set_fstype(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let slot = interp.sv("File::Basename::Fileparse_fstype");
	let previous = interp.read_sv(&slot)?;
	if !args.is_empty() {
		let name = arg(&args, 0).to_pstr().bytes.to_ascii_lowercase();
		let name = match name.as_slice() {
			b"dos" => "DOS", b"mswin32" => "MSWin32", b"os2" => "OS2", b"macos" => "MacOS", b"vms" => "VMS",
			_ => "Unix",
		};
		interp.write_sv(&slot, Value::str(name))?;
	}
	one(previous)
}

fn valid_path(interp: &mut Interp<'_>, args: &[Sv]) -> PResult<PStr> {
	let value = arg(args, 0);
	if value.is_undef() { return Err(interp.die_msg("fileparse(): need a valid pathname")); }
	interp.stringify(&value)
}

fn split_basename(path: &PStr, style: Style) -> (PStr, PStr) {
	let end = path.bytes.iter().rposition(|&b| style.separator(b)
		|| (style != Style::Unix && b == b':') || (style == Style::Vms && b == b']')).map_or(0, |n| n + 1);
	let (dir, name) = path.bytes.split_at(end);
	let dir = if dir.is_empty() {
		match style { Style::Mac => b":".to_vec(), Style::Vms => Vec::new(), _ => b"./".to_vec() }
	} else {
		let mut dir = dir.to_vec();
		if dir.ends_with(b":") {
			match style { Style::Dos => dir.extend(b".\\"), Style::Os2 => dir.push(b'/'), _ => {} }
		}
		dir
	};
	(PStr::new(name.to_vec(), path.utf8), PStr::new(dir, path.utf8))
}

fn basename(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut path = valid_path(interp, &args)?;
	let style = Style::current(interp);
	if let Some(end) = path.bytes.iter().rposition(|&b| !style.separator(b)) {
		path.bytes.truncate(end + 1);
	} else if !path.is_empty() {
		path.bytes.truncate(1);
		return one(Value::Str(path));
	}
	let (mut name, dir) = split_basename(&path, style);
	if name.is_empty() { return one(Value::Str(dir)); }
	let mut end = name.bytes.len();
	for suffix in args.iter().skip(1) {
		let suffix = interp.read_sv(suffix)?;
		let suffix = interp.stringify(&suffix)?;
		if let Some(i) = end.checked_sub(suffix.bytes.len()) {
			let tail = &name.bytes[i..end];
			if if style == Style::Unix { tail == suffix.bytes } else { tail.eq_ignore_ascii_case(&suffix.bytes) } {
				if i == 0 { return one(Value::Str(name)); }
				end = i;
			}
		}
	}
	name.bytes.truncate(end);
	one(Value::Str(name))
}

fn dirname(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut path = valid_path(interp, &args)?;
	let style = Style::current(interp);
	if let Some(end) = path.bytes.iter().rposition(|&b| !style.separator(b)) {
		if style != Style::Mac && !(matches!(style, Style::Dos | Style::Os2) && path.bytes.get(end) == Some(&b':')) {
			path.bytes.truncate(end + 1);
		} else if style == Style::Mac && end + 1 < path.bytes.len() {
			path.bytes.truncate(end + 1);
		}
	} else if !path.is_empty() {
		path.bytes.truncate(1);
		return one(Value::Str(path));
	}
	let (_, mut dir) = split_basename(&path, style);
	if style != Style::Mac {
		let keep = dir.bytes.iter().rposition(|&b| !style.separator(b)).map_or(1, |i| i + 1);
		if !(matches!(style, Style::Dos | Style::Os2) && dir.bytes.get(keep.wrapping_sub(1)) == Some(&b':')) {
			dir.bytes.truncate(keep);
		}
	}
	one(Value::Str(dir))
}

fn fileparse(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let path = valid_path(interp, &args)?;
	let style = Style::current(interp);
	let (mut name, dir) = split_basename(&path, style);
	let mut suffix = PStr::default();
	for pattern in args.iter().skip(1) {
		let value = interp.read_sv(pattern)?;
		let (source, mut flags) = match value {
			Value::Ref(Ref::Regexp(rx)) => (rx.regex.source().clone(), rx.regex.flags()),
			other => (interp.stringify(&other)?, RxFlags::default()),
		};
		flags.i |= style != Style::Unix;
		let mut pattern = PStr::from_bytes(b"(?:");
		pattern.push(&source);
		pattern.push_bytes(b")\\z");
		let rx = Regex::new(&pattern, flags).map_err(|err| interp.die_msg(err))?;
		if let Some(captures) = rx.exec(&name, 0, ExecOpts::default()).map_err(|err| interp.die_msg(err))?
			&& let Some(Some((start, _))) = captures.spans.first()
		{
			suffix = PStr::new(name.bytes.split_off(*start), name.utf8);
			break;
		}
	}
	if cx == Cx::List { Ok(Ret::Many(vec![Value::Str(name), Value::Str(dir), Value::Str(suffix)])) }
	else { one(Value::Str(name)) }
}

#[derive(Clone, Copy)]
enum Spec { Canon, CatDir, CatFile, Cur, Root, Up, NoUp, Absolute, Path, Null, Tmp, SplitPath, SplitDir, CatPath, Abs2Rel, Rel2Abs, Case }

macro_rules! install_operations {
	($interp:expr, $module:expr, $functions:expr; $($name:ident => $op:ident),+ $(,)?) => {
		let defs: &[(&str, NativeFn)] = if $functions {
			&[$((stringify!($name), |i, a, c| spec(i, &a, c, Spec::$op))),+]
		} else {
			&[$((stringify!($name), |i, a, c| spec(i, a.get(1..).unwrap_or_default(), c, Spec::$op))),+]
		};
		define($interp, $module, defs);
	};
}

fn install_spec(interp: &mut Interp<'_>, module: &str, functions: bool) {
	version(interp, module, "3.80");
	install_operations!(interp, module, functions;
		canonpath => Canon, catdir => CatDir, catfile => CatFile, curdir => Cur, rootdir => Root, updir => Up,
		no_upwards => NoUp, file_name_is_absolute => Absolute, path => Path, devnull => Null, tmpdir => Tmp,
		splitpath => SplitPath, splitdir => SplitDir, catpath => CatPath, abs2rel => Abs2Rel, rel2abs => Rel2Abs,
		case_tolerant => Case,
	);
}

/// Choose the platform's temporary directory from Perl's environment.
pub(super) fn tmpdir(interp: &mut Interp<'_>) -> PResult<PStr> {
	let temp = env(interp, b"TMPDIR")?;
	let resolved = interp.resolve_path(&temp.bytes);
	if !temp.is_empty() && interp.host().fs().metadata(resolved).is_ok_and(|m| m.is_dir()) {
		return Ok(PStr::new(canon(&temp.bytes), temp.utf8));
	}
	let dir = interp.resolve_path(b"/tmp");
	Ok(if interp.host().fs().metadata(dir).is_ok_and(|m| m.is_dir()) { PStr::from_bytes(b"/tmp") }
	else { PStr::from_bytes(b".") })
}

fn canon(path: &[u8]) -> Vec<u8> {
	if path.is_empty() { return Vec::new(); }
	let rooted = path.starts_with(b"/");
	let mut result = Vec::with_capacity(path.len());
	if rooted { result.push(b'/'); }
	for part in path.split(|b| *b == b'/').filter(|part| !part.is_empty() && *part != b".") {
		if rooted && result.len() == 1 && part == b".." { continue; }
		if !result.is_empty() && !result.ends_with(b"/") { result.push(b'/'); }
		result.extend_from_slice(part);
	}
	if result.is_empty() { result.push(b'.'); }
	result
}

fn catdir(args: &[PStr]) -> PStr {
	let mut joined = PStr::default();
	for arg in args { joined.push(arg); joined.push_bytes(b"/"); }
	PStr::new(canon(&joined.bytes), joined.utf8)
}

fn catpath(mut dir: PStr, name: &PStr) -> PStr {
	if !dir.is_empty() && !dir.bytes.ends_with(b"/") && !name.is_empty() && !name.bytes.starts_with(b"/") {
		dir.push_bytes(b"/");
	}
	dir.push(name);
	dir
}

fn rel2abs(interp: &Interp<'_>, path: &PStr, base: &PStr) -> PStr {
	if path.bytes.starts_with(b"/") { return PStr::new(canon(&path.bytes), path.utf8); }
	let mut base = if base.bytes.starts_with(b"/") { base.clone() }
	else {
		let cwd = path_value(&cwd(interp)).to_pstr();
		catpath(cwd, base)
	};
	base = catpath(base, path);
	PStr::new(canon(&base.bytes), base.utf8)
}

fn abs2rel(path: PStr, base: PStr) -> PStr {
	if path == base { return PStr::from_bytes(b"."); }
	let mut target = path.bytes.split(|b| *b == b'/').filter(|p| !p.is_empty()).peekable();
	let mut origin = base.bytes.split(|b| *b == b'/').filter(|p| !p.is_empty()).peekable();
	while target.peek().is_some() && target.peek() == origin.peek() { target.next(); origin.next(); }
	let mut count: usize = 0;
	for part in origin {
		if part == b".." {
			let Some(remaining) = count.checked_sub(1) else { return path };
			count = remaining;
		} else { count += 1; }
	}
	let mut result = Vec::with_capacity(count * 3 + path.bytes.len());
	for part in std::iter::repeat_n(b"..".as_slice(), count).chain(target) {
		if !result.is_empty() { result.push(b'/'); }
		result.extend_from_slice(part);
	}
	PStr::new(result, path.utf8)
}

fn spec(interp: &mut Interp<'_>, args: &[Sv], cx: Cx, op: Spec) -> PResult<Ret> {
	let get = |index| arg(args, index).to_pstr();
	let value = |s| Value::Str(s);
	match op {
		Spec::Cur => one(Value::bytes(b".")),
		Spec::Root => one(Value::bytes(b"/")),
		Spec::Up => one(Value::bytes(b"..")),
		Spec::Null => one(Value::bytes(b"/dev/null")),
		Spec::Case => one(Value::Int(0)),
		Spec::Absolute => one(Value::Int(i64::from(get(0).bytes.starts_with(b"/")))),
		Spec::Tmp => one(value(tmpdir(interp)?)),
		Spec::Canon => {
			let path = arg(args, 0);
			if path.is_undef() { return one(Value::Undef); }
			let path = path.to_pstr();
			one(value(PStr::new(canon(&path.bytes), path.utf8)))
		},
		Spec::CatDir | Spec::CatFile => {
			let mut parts = args.iter().map(|sv| Ok(interp.read_sv(sv)?.to_pstr())).collect::<PResult<Vec<_>>>()?;
			if matches!(op, Spec::CatDir) { return one(value(catdir(&parts))); }
			let Some(name) = parts.pop() else { return one(Value::bytes(b"")); };
			let mut dir = catdir(&parts);
			if !dir.is_empty() && !dir.bytes.ends_with(b"/") { dir.push_bytes(b"/"); }
			dir.push(&PStr::new(canon(&name.bytes), name.utf8));
			one(value(dir))
		},
		Spec::CatPath => one(value(catpath(get(1), &get(2)))),
		Spec::SplitPath => {
			let path = get(0);
			let dir_only = arg(args, 1).truthy() || path.bytes.ends_with(b"/.") || path.bytes.ends_with(b"/..");
			let end = if dir_only { path.bytes.len() }
				else { path.bytes.iter().rposition(|&b| b == b'/').map_or(0, |i| i + 1) };
			let file = value(PStr::new(path.bytes[end..].to_vec(), path.utf8));
			if cx == Cx::List {
				Ok(Ret::Many(vec![Value::bytes(b""), value(PStr::new(path.bytes[..end].to_vec(), path.utf8)), file]))
			} else { one(file) }
		},
		Spec::SplitDir => {
			let path = get(0);
			let parts = if path.is_empty() { Vec::new() }
				else { path.bytes.split(|b| *b == b'/').map(|p| value(PStr::new(p.to_vec(), path.utf8))).collect() };
			Ok(list(parts, cx))
		},
		Spec::NoUp => {
			let mut parts = Vec::new();
			for sv in args {
				let value = interp.read_sv(sv)?;
				if !matches!(value.to_pstr().bytes.as_slice(), b"." | b"..") { parts.push(value); }
			}
			Ok(list(parts, cx))
		},
		Spec::Path => {
			let path = env(interp, b"PATH")?;
			let end = path.bytes.iter().rposition(|&b| b != b':').map_or(0, |i| i + 1);
			let values = if end == 0 { Vec::new() } else {
				path.bytes[..end].split(|b| *b == b':').map(|p| {
					value(PStr::new(if p.is_empty() { b".".to_vec() } else { p.to_vec() }, path.utf8))
				}).collect()
			};
			Ok(list(values, cx))
		},
		Spec::Rel2Abs => one(value(rel2abs(interp, &get(0), &get(1)))),
		Spec::Abs2Rel => one(value(abs2rel(rel2abs(interp, &get(0), &PStr::default()), rel2abs(interp, &get(1), &PStr::default())))),
	}
}
