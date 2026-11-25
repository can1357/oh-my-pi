//! Core configuration, platform constants, symbols, and container helpers.

use std::{
	cell::RefCell,
	collections::{BTreeMap, HashMap, HashSet},
	hash::{Hash, Hasher},
	rc::{Rc, Weak},
};

use crate::perl::{
	interp::{Cx, Interp, NativeFn, PResult, Ret},
	io::Handle,
	regex::{ExecOpts, Regex, RxFlags},
	pack::LONG_DOUBLE,
	value::{Gv, HKey, HashBody, HashEntries, Hv, PStr, Ref, Sv, Value, new_av, new_gv, new_sv},
};

use super::{HashAccess, arg, boolean, constant, define, export, export_tag, isa, list, text, version};

#[cfg(unix)]
use crate::perl::func::sys::by_fd;

#[cfg(any(unix, windows))]
use crate::{
	openfile::{Fd, OpenFile},
	perl::{
		func::sys::{register_host_child, remember},
		interp::Flow,
		io::{ChildContext, Io, Layers, OpenMode, ShellSpec},
	},
};

/// Install the requested core helper or platform library.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	match module {
		"Config" => load_config(interp, module),
		"Sys::Hostname" => {
			version(interp, module, "1.23");
			interp.define_native("Sys::Hostname::hostname", hostname);
			export(interp, module, &["hostname"], &[]);
		},
		"Fcntl" => load_fcntl(interp, module),
		"Errno" => load_errno(interp, module),
		"Hash::Util" => load_hash_util(interp, module),
		"Symbol" => {
			version(interp, module, "1.09");
			for (name, proto, fun) in [
				("gensym", "", gensym as NativeFn), ("geniosym", "", geniosym), ("ungensym", "$", ungensym),
				("qualify", "$;$", qualify), ("qualify_to_ref", "$;$", qualify_to_ref), ("delete_package", "$", delete_package),
			] { interp.define_native_proto(&format!("{module}::{name}"), fun, proto); }
			export(interp, module, &["gensym", "ungensym", "qualify", "qualify_to_ref"], &["delete_package", "geniosym"]);
		},
		"Tie::Hash" => { interp.load_source("Tie/Hash.pm", include_str!("pm/TieHash.pm").as_bytes())?; },
		"Tie::Array" => { interp.load_source("Tie/Array.pm", include_str!("pm/TieArray.pm").as_bytes())?; },
		"Tie::Scalar" => { interp.load_source("Tie/Scalar.pm", include_str!("pm/TieScalar.pm").as_bytes())?; },
		"Env" => load_env(interp, module)?,
		"IPC::Open2" => {
			interp.require_module("IPC::Open3")?;
			version(interp, module, "1.05");
			define(interp, module, &[("open2", open2)]);
			export(interp, module, &["open2"], &[]);
		},
		"IPC::Open3" => {
			interp.require_module("Symbol")?;
			version(interp, module, "1.21");
			define(interp, module, &[("open3", open3)]);
			export(interp, module, &["open3"], &[]);
		},
		_ => unreachable!("extra module registry: {module}"),
	}
	Ok(())
}

fn key(name: &str) -> HKey { HKey::new(&PStr::from_str(name)) }

/// `$^O` and `$Config{osname}`: perl's name for the platform this interpreter was built for.
pub(in crate::perl) fn osname() -> &'static str {
	if cfg!(target_os = "macos") { "darwin" } else if cfg!(windows) { "MSWin32" } else { std::env::consts::OS }
}

/// `$Config{archname}` in perl's Configure naming; `-I`, `use lib`, and `perl -v` use the same value.
pub(in crate::perl) fn archname() -> String {
	match osname() {
		"darwin" => "darwin-2level".to_owned(),
		"MSWin32" => format!("MSWin32-{}", if cfg!(target_arch = "x86_64") { "x64" } else { std::env::consts::ARCH }),
		os => format!("{}-{os}", std::env::consts::ARCH),
	}
}

/// `perl -V` (empty query: the configuration summary and `@INC`) and `perl -V:name` (as `Config::config_vars`),
/// written to the selected handle.
pub(in crate::perl) fn show_config(interp: &mut Interp<'_>, queries: &[Vec<u8>]) -> PResult<()> {
	interp.require_module("Config")?;
	for query in queries {
		if !query.is_empty() {
			let names = query.split(|b| b.is_ascii_whitespace()).filter(|word| !word.is_empty())
				.map(|word| new_sv(Value::bytes(word))).collect();
			config_vars(interp, names, Cx::Void)?;
			continue;
		}
		let mut text = myconfig(interp, Vec::new(), Cx::Scalar)?.scalar().to_pstr();
		text.push_bytes(b"\nCharacteristics of this binary (from libperl): \n  Compile-time options:\n");
		let mut options = bincompat();
		options.extend_from_slice(NON_BINCOMPAT_OPTIONS);
		options.sort_unstable();
		for option in options { text.push_bytes(format!("    {option}\n").as_bytes()); }
		text.push_bytes(format!("  Built under {}\n  @INC:\n", osname()).as_bytes());
		let inc = interp.av("main::INC");
		for dir in inc.elems().iter() {
			text.push_bytes(b"    ");
			text.push(&dir.get().to_pstr());
			text.push_bytes(b"\n");
		}
		let result = interp.selected().borrow_mut().write(&text);
		if let Err(e) = result { interp.set_errno(&e); }
	}
	Ok(())
}

/// Natively provided XS extensions, as `$Config{extensions}` lists them.
const EXTENSIONS: &str = "Cwd Data/Dumper Digest/MD5 Digest/SHA Encode Fcntl File/Glob Hash/Util IO List/Util MIME/Base64 POSIX Scalar/Util Storable Sys/Hostname Tie/Hash/NamedCapture Time/HiRes Time/Piece Unicode/Normalize attributes re";
const EXTENSIONS_UNIX: &str = "Cwd Data/Dumper Digest/MD5 Digest/SHA Encode Fcntl File/Glob Hash/Util IO List/Util MIME/Base64 POSIX Scalar/Util Socket Storable Sys/Hostname Tie/Hash/NamedCapture Time/HiRes Time/Piece Unicode/Normalize attributes re";

fn load_config(interp: &mut Interp<'_>, module: &str) {
	version(interp, module, "5.034001");
	let config = interp.hv("Config::Config");
	let os = osname();
	let word = if cfg!(target_pointer_width = "64") { "8" } else { "4" };
	let long = if cfg!(windows) { "4" } else { word };
	let order = if cfg!(target_endian = "little") { "12345678" } else { "87654321" };
	let long_double = LONG_DOUBLE.to_string();
	let exe = if cfg!(windows) { ".exe" } else { "" };
	let so = if cfg!(windows) { "dll" } else if cfg!(target_os = "macos") { "dylib" } else { "so" };
	let have = [
		("version", "5.34.1"), ("api_versionstring", "5.34.0"), ("api_revision", "5"), ("api_version", "34"),
		("api_subversion", "0"), ("PERL_API_REVISION", "5"), ("PERL_API_VERSION", "34"), ("PERL_API_SUBVERSION", "0"),
		("PATCHLEVEL", "34"), ("SUBVERSION", "1"), ("PERL_REVISION", "5"), ("osname", os),
		("ptrsize", word), ("ivsize", "8"), ("uvsize", "8"), ("nvsize", "8"), ("sizesize", word), ("longsize", long),
		("doublesize", "8"), ("longdblsize", &long_double), ("intsize", "4"), ("shortsize", "2"),
		("longlongsize", "8"), ("byteorder", order), ("nv_preserves_uv_bits", "53"),
		("ivtype", if long == "8" { "long" } else { "long long" }),
		("uvtype", if long == "8" { "unsigned long" } else { "unsigned long long" }), ("nvtype", "double"),
		("useshrplib", "false"),
		("extensions", if cfg!(unix) { EXTENSIONS_UNIX } else { EXTENSIONS }), ("known_extensions", if cfg!(unix) { EXTENSIONS_UNIX } else { EXTENSIONS }),
		("startperl", "#!/usr/bin/perl"), ("perlpath", "/usr/bin/perl"), ("exe_ext", exe), ("_exe", exe),
		("lib_ext", if cfg!(windows) { ".lib" } else { ".a" }), ("so", so),
		("dlext", if cfg!(target_os = "macos") { "bundle" } else { so }), ("path_sep", env_delimiter_str()),
		("dir_sep", std::path::MAIN_SEPARATOR_STR), ("prefix", "/usr"), ("prefixexp", "/usr"),
		("bin", "/usr/bin"), ("binexp", "/usr/bin"), ("installbin", "/usr/bin"), ("installscript", "/usr/bin"),
		("scriptdir", "/usr/bin"), ("cc", "rustc"), ("ccflags", ""), ("ldflags", ""), ("libs", ""),
		("CONFIG", "true"), ("PERL_VERSION", "34"), ("PERL_SUBVERSION", "1"), ("PERL_PATCHLEVEL", ""),
		("revision", "5"), ("patchlevel", "34"), ("subversion", "1"), ("ccversion", ""),
		("_o", if cfg!(windows) { ".obj" } else { ".o" }), ("obj_ext", if cfg!(windows) { ".obj" } else { ".o" }),
		("d_Gconvert", "sprintf((b),\"%.*g\",(n),(x))"), ("doublekind", if cfg!(target_endian = "little") { "3" } else { "4" }),
		("lseeksize", "8"), ("d_has_C_UTF8", "false"), ("static_ext", " "),
		("procselfexe", if cfg!(any(target_os = "linux", target_os = "android")) { "\"/proc/self/exe\"" } else { "" }),
	];
	{
		let mut map = config.entries_mut();
		map.extend(have.into_iter().map(|(name, value)| (key(name), new_sv(Value::str(value)))));
		let unix = cfg!(unix);
		let features = [
			("use64bitint", true), ("use64bitall", word == "8"), ("useithreads", false), ("usemultiplicity", true),
			("uselongdouble", false), ("useperlio", true), ("usedl", false),
			("d_alarm", true), ("d_pipe", cfg!(any(unix, windows))), ("d_waitpid", true),
			("d_fork", false), ("d_vfork", false), ("d_dlopen", false), ("d_chroot", false),
			("d_flock", false), ("d_ioctl", false), ("d_fcntl", unix), ("d_select", unix),
			("d_getpgrp", unix), ("d_setpgrp", unix), ("d_getppid", unix), ("d_getpriority", unix),
			("d_socket", unix), ("d_sockpair", unix), ("d_getsockname", unix), ("d_getpeername", unix),
			("d_symlink", unix), ("d_link", unix), ("d_readlink", unix), ("d_lstat", true),
			("d_gethostname", unix), ("d_nanosleep", true), ("d_usleep", true), ("d_clock_gettime", unix),
			("d_longdbl", true), ("d_double_style_ieee", true), ("d_double_has_inf", true),
			("d_double_has_nan", true), ("d_double_has_negative_zero", true), ("d_double_has_subnormals", true),
			("d_isinf", true), ("d_isnan", true), ("d_isfinite", true), ("d_signbit", true),
			("d_nv_preserves_uv", false), ("d_getcwd", true), ("d_crypt", unix), ("d_chown", unix),
			("d_readdir", true), ("d_telldir", true), ("d_seekdir", true), ("d_rewinddir", true),
			("d_rename", true), ("d_truncate", true), ("d_quad", true), ("d_strtod", true),
			("i_pwd", unix), ("i_grp", unix), ("uselargefiles", true), ("fflushNULL", true),
			("default_inc_excludes_dot", true), ("usecrosscompile", false), ("usedevel", false),
			("usequadmath", false), ("usefaststdio", false), ("d_faststdio", false), ("ebcdic", false),
			("d_cplusplus", false), ("usedebugging_perl", false), ("d_setlocale", false),
			("d_getpbyname", unix), ("d_getpbynumber", unix), ("d_getsbyname", unix), ("d_getsbyport", unix),
			("d_gethbyname", unix), ("d_gethbyaddr", unix), ("d_fchdir", false), ("d_fchmod", false), ("d_fchown", false), ("d_futimes", false),
			("d_dirfd", false), ("d_dir_dd_fd", false), ("d_msg", false), ("d_sem", false), ("d_shm", false),
			// How perl finds its own executable for an absolute `$^X`.
			("usensgetexecutablepath", cfg!(target_vendor = "apple")), ("d_procselfexe", cfg!(any(target_os = "linux", target_os = "android"))),
			("usekernprocpathname", cfg!(any(target_os = "freebsd", target_os = "dragonfly"))),
		];
		map.extend(features.into_iter().map(|(name, enabled)| {
			(key(name), new_sv(if enabled { Value::str("define") } else { Value::Undef }))
		}));
		config_signals(&mut map);
		map.insert(key("archname"), new_sv(Value::Str(PStr::new(archname().into_bytes(), false))));
		#[cfg(unix)]
		map.insert(key("osvers"), new_sv(Value::bytes(rustix::system::uname().release().to_bytes())));
	}
	define(interp, module, &[("config_sh", config_sh), ("config_re", config_re), ("config_vars", config_vars),
		("myconfig", myconfig), ("compile_date", compile_date), ("header_files", header_files),
		("bincompat_options", bincompat_options), ("non_bincompat_options", non_bincompat_options), ("local_patches", local_patches)]);
	export(interp, module, &["%Config"], &["header_files", "config_sh", "compile_date", "config_vars",
		"non_bincompat_options", "config_re", "bincompat_options", "myconfig", "local_patches"]);
	interp.modules.hash_locks.change(&config).read_only_container = Some("%Config::Config is read-only");
	// The native %Config is complete, so the part real perl loads lazily counts as loaded.
	interp.hv("main::INC").entries_mut().entry(key("Config_heavy.pl")).or_insert_with(|| new_sv(Value::str("Config_heavy.pl")));
}

fn config_signals(map: &mut HashEntries) {
	use std::fmt::Write;

	let mut signals = vec![("ZERO", 0)];
	#[cfg(unix)]
	signals.extend(nix::sys::signal::Signal::iterator().map(|signal| {
		let name = signal.as_str();
		(name.strip_prefix("SIG").unwrap_or(name), signal as i32)
	}));
	#[cfg(windows)]
	signals.extend([
		("ABRT", libc::SIGABRT), ("FPE", libc::SIGFPE), ("ILL", libc::SIGILL),
		("INT", libc::SIGINT), ("SEGV", libc::SIGSEGV), ("TERM", libc::SIGTERM),
	]);
	signals.sort_unstable_by_key(|&(_, number)| number);
	let mut names = String::new();
	let mut numbers = String::new();
	for (name, number) in signals {
		if !names.is_empty() {
			names.push(' ');
			numbers.push(' ');
		}
		names.push_str(name);
		let _ = write!(numbers, "{number}");
	}
	for (name, value) in [("sig_name", names), ("sig_num", numbers)] {
		map.insert(key(name), new_sv(Value::Str(PStr::new(value.into_bytes(), false))));
	}
}

fn config_value(sv: &Sv) -> PStr {
	match sv.get() {
		Value::Undef => PStr::from_bytes(b"undef"),
		Value::Str(value) => value,
		value => value.to_pstr(),
	}
}

fn config_pairs(interp: &mut Interp<'_>) -> Vec<(PStr, PStr)> {
	let mut entries: Vec<_> = interp.hv("Config::Config").entries().iter()
		.map(|(k, v)| (k.to_pstr(), config_value(v))).collect();
	entries.sort_unstable_by(|a, b| a.0.bytes.cmp(&b.0.bytes));
	entries
}

fn config_line(k: PStr, v: Option<&PStr>, with_semicolon: bool) -> PStr {
	let mut out = k;
	if out.is_empty() { out.push_bytes(b"'"); } else { out.push_bytes(b"='"); }
	if let Some(v) = v {
		for (i, part) in v.bytes.split(|&c| c == b'\'').enumerate() {
			if i != 0 { out.push_bytes(br"'\''"); }
			if v.utf8 { out.upgrade(); out.bytes.extend_from_slice(part); } else { out.push_bytes(part); }
		}
	} else { out.push_bytes(b"UNKNOWN"); }
	out.push_bytes(if with_semicolon { b"';" } else { b"'" });
	out
}

fn config_sh(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut out = PStr::default();
	for (name, value) in config_pairs(interp) { out.push(&config_line(name, Some(&value), false)); out.push_bytes(b"\n"); }
	Ok(Ret::One(Value::Str(out)))
}

fn config_pattern(interp: &mut Interp<'_>, expression: &PStr) -> PResult<Regex> {
	let mut pattern = PStr::from_bytes(b"^(?:");
	pattern.push(expression);
	pattern.push_bytes(b")=");
	Regex::new(&pattern, RxFlags::default()).map_err(|e| interp.die_msg(e))
}

fn config_re(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let expression = interp.stringify(&arg(&args, 0))?;
	let re = config_pattern(interp, &expression)?;
	let mut out = Vec::new();
	for (name, value) in config_pairs(interp) {
		let line = config_line(name, Some(&value), false);
		if re.exec(&line, 0, ExecOpts::default()).map_err(|e| interp.die_msg(e))?.is_some() { out.push(Value::Str(line)); }
	}
	Ok(list(out, cx))
}

fn config_vars(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = interp.hv("Config::Config");
	let mut out = PStr::default();
	for arg in args {
		let value = interp.read_sv(&arg)?;
		let name = interp.stringify(&value)?;
		let prefix = name.bytes.first() == Some(&b':');
		let suffix = name.bytes.last() == Some(&b':') && name.bytes.len() > usize::from(prefix);
		let name = PStr::new(name.bytes[usize::from(prefix)..name.bytes.len() - usize::from(suffix)].to_vec(), name.utf8);
		let exact = hv.entries().get(&HKey::new(&name)).map(config_value);
		let mut emit = |name: PStr, value: Option<&PStr>| {
			out.push(&config_line(if prefix { PStr::default() } else { name }, value, !suffix));
			if suffix { out.push_bytes(b" "); } else { out.push_bytes(b"\n"); }
		};
		if exact.is_some() || name.bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_') {
			emit(name, exact.as_ref());
		} else {
			let re = config_pattern(interp, &name)?;
			let mut found = false;
			for (key, value) in config_pairs(interp) {
				let mut key_test = key.clone();
				key_test.push_bytes(b"=");
				if re.exec(&key_test, 0, ExecOpts::default()).map_err(|e| interp.die_msg(e))?.is_some() {
					found = true;
					emit(key, Some(&value));
				}
			}
			if !found {
				out.push(&name);
				out.push_bytes(if suffix { b": not found " } else { b": not found;\n" });
			}
		}
	}
	let result = interp.selected().borrow_mut().write(&out);
	match result { Ok(_) => Ok(boolean(false)), Err(e) => { interp.set_errno(&e); Ok(Ret::One(Value::Undef)) } }
}

fn myconfig(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = interp.hv("Config::Config");
	let map = hv.entries();
	let prop = |name: &str| map.get(&key(name)).map_or_else(String::new, |s| config_value(s).to_string_lossy().into_owned());
	Ok(Ret::One(Value::str(&format!("Summary of my perl5 (revision 5 version 34 subversion 1) configuration:\n  Platform:\n    osname={}, osvers={}, archname={}\n    interpreter=omp, useithreads={}, usemultiplicity={}\n  Compiler:\n    cc='{}', ptrsize={}, ivsize={}, nvsize={}, byteorder={}\n",
		prop("osname"), prop("osvers"), prop("archname"), prop("useithreads"), prop("usemultiplicity"),
		prop("cc"), prop("ptrsize"), prop("ivsize"), prop("nvsize"), prop("byteorder")))))
}

fn compile_date(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(option_env!("SOURCE_DATE_EPOCH").map_or(Value::Undef, |date| Value::str(&format!("Build epoch {date}")))))
}

fn header_files(_: &mut Interp<'_>, _: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	// This interpreter does not install or expose a C extension ABI.
	Ok(if cx == Cx::List { Ret::Many(Vec::new()) } else { Ret::One(Value::Undef) })
}

/// Compile-time options affecting binary compatibility, sorted as `Config::bincompat_options` reports them.
fn bincompat() -> Vec<&'static str> {
	["HAS_TIMES", "MULTIPLICITY", "PERLIO_LAYERS", "PERL_IMPLICIT_CONTEXT", "USE_64_BIT_ALL", "USE_64_BIT_INT", "USE_LARGE_FILES", "USE_PERLIO"]
		.into_iter().filter(|&option| option != "USE_64_BIT_ALL" || cfg!(target_pointer_width = "64")).collect()
}
/// Other compile-time options: `.pmc` files are never preferred over `.pm` by this interpreter's `require`.
const NON_BINCOMPAT_OPTIONS: &[&str] = &["PERL_DISABLE_PMC", "PERL_PRESERVE_IVUV"];

fn option_list(options: &[&str], cx: Cx) -> Ret { list(options.iter().map(|o| Value::str(o)).collect(), cx) }
fn bincompat_options(_: &mut Interp<'_>, _: Vec<Sv>, cx: Cx) -> PResult<Ret> { Ok(option_list(&bincompat(), cx)) }
fn non_bincompat_options(_: &mut Interp<'_>, _: Vec<Sv>, cx: Cx) -> PResult<Ret> { Ok(option_list(NON_BINCOMPAT_OPTIONS, cx)) }
fn local_patches(_: &mut Interp<'_>, _: Vec<Sv>, cx: Cx) -> PResult<Ret> { Ok(list(Vec::new(), cx)) }

fn hostname(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !args.is_empty() { return Err(interp.die_msg("hostname() does not accepts arguments (it used to silently discard any provided)")); }
	let cache = interp.sv("Sys::Hostname::_name");
	let cached = cache.get();
	if !cached.is_undef() { return Ok(Ret::One(cached)); }
	#[cfg(unix)]
	{
		let name = rustix::system::uname();
		let bytes = name.nodename().to_bytes();
		if !bytes.is_empty() {
			let value = Value::bytes(bytes);
			cache.set(value.clone());
			return Ok(Ret::One(value));
		}
	}
	let env = interp.hv("main::ENV");
	let map = env.entries();
	for name in ["HOSTNAME", "COMPUTERNAME"] {
		if let Some(s) = map.get(&key(name)) {
			let value = s.get();
			if value.truthy() {
				cache.set(value.clone());
				return Ok(Ret::One(value));
			}
		}
	}
	Err(interp.die_msg("Cannot get host name"))
}

const FCNTL_DEFAULT: &str = "FD_CLOEXEC F_ALLOCSP F_ALLOCSP64 F_COMPAT F_DUP2FD F_DUPFD F_EXLCK F_FREESP F_FREESP64 F_FSYNC F_FSYNC64 F_GETFD F_GETFL F_GETLK F_GETLK64 F_GETOWN F_NODNY F_POSIX F_RDACC F_RDDNY F_RDLCK F_RWACC F_RWDNY F_SETFD F_SETFL F_SETLK F_SETLK64 F_SETLKW F_SETLKW64 F_SETOWN F_SHARE F_SHLCK F_UNLCK F_UNSHARE F_WRACC F_WRDNY F_WRLCK O_ACCMODE O_ALIAS O_APPEND O_ASYNC O_BINARY O_CREAT O_DEFER O_DIRECT O_DIRECTORY O_DSYNC O_EXCL O_EXLOCK O_LARGEFILE O_NDELAY O_NOCTTY O_NOFOLLOW O_NOINHERIT O_NONBLOCK O_RANDOM O_RAW O_RDONLY O_RDWR O_RSRC O_RSYNC O_SEQUENTIAL O_SHLOCK O_SYNC O_TEMPORARY O_TEXT O_TRUNC O_WRONLY";
const FCNTL_OPTIONAL: &str = "DN_ACCESS DN_ATTRIB DN_CREATE DN_DELETE DN_MODIFY DN_MULTISHOT DN_RENAME F_GETLEASE F_GETPIPE_SZ F_GETSIG F_NOTIFY F_SETLEASE F_SETPIPE_SZ F_SETSIG LOCK_MAND LOCK_READ LOCK_RW LOCK_WRITE O_ALT_IO O_EVTONLY O_IGNORE_CTTY O_NOATIME O_NOLINK O_NOSIGPIPE O_NOTRANS O_SYMLINK O_TTY_INIT";
const FCNTL_MODE: &str = "S_ISUID S_ISGID S_ISVTX S_ISTXT _S_IFMT S_IFREG S_IFDIR S_IFLNK S_IFSOCK S_IFBLK S_IFCHR S_IFIFO S_IFWHT S_ENFMT S_IRUSR S_IWUSR S_IXUSR S_IRWXU S_IRGRP S_IWGRP S_IXGRP S_IRWXG S_IROTH S_IWOTH S_IXOTH S_IRWXO S_IREAD S_IWRITE S_IEXEC S_ISREG S_ISDIR S_ISLNK S_ISSOCK S_ISBLK S_ISCHR S_ISFIFO S_ISWHT S_ISENFMT S_IFMT S_IMODE";
const FCNTL_COMPAT: &str = "FAPPEND FASYNC FCREAT FDEFER FDSYNC FEXCL FLARGEFILE FNDELAY FNONBLOCK FRSYNC FSYNC FTRUNC";
const FCNTL_FLOCK: &str = "LOCK_SH LOCK_EX LOCK_NB LOCK_UN";
const FCNTL_SEEK: &str = "SEEK_SET SEEK_CUR SEEK_END";

macro_rules! libc_constants {
	($out:expr; $($name:ident)*) => { $( $out.insert(stringify!($name), libc::$name as i64); )* };
}

fn load_fcntl(interp: &mut Interp<'_>, module: &str) {
	version(interp, module, "1.14");
	let mut values = HashMap::new();
	libc_constants!(values; O_APPEND O_CREAT O_EXCL O_RDONLY O_RDWR O_TRUNC O_WRONLY SEEK_SET SEEK_CUR SEEK_END);
	#[cfg(unix)]
	{
		libc_constants!(values; FD_CLOEXEC F_DUPFD F_GETFD F_GETFL F_GETLK F_GETOWN F_RDLCK F_SETFD F_SETFL F_SETLK F_SETLKW F_SETOWN F_UNLCK F_WRLCK
			O_ACCMODE O_ASYNC O_DIRECTORY O_DSYNC O_NOCTTY O_NOFOLLOW O_NONBLOCK O_SYNC
			LOCK_SH LOCK_EX LOCK_NB LOCK_UN S_IFREG S_IFDIR S_IFLNK S_IFSOCK S_IFBLK S_IFCHR S_IFIFO S_ISUID S_ISGID S_ISVTX
			S_IRUSR S_IWUSR S_IXUSR S_IRWXU S_IRGRP S_IWGRP S_IXGRP S_IRWXG S_IROTH S_IWOTH S_IXOTH S_IRWXO);
		values.extend([
			("_S_IFMT", i64::from(libc::S_IFMT)), ("FAPPEND", i64::from(libc::O_APPEND)), ("FASYNC", i64::from(libc::O_ASYNC)),
			("O_NDELAY", i64::from(libc::O_NONBLOCK)), ("FNDELAY", i64::from(libc::O_NONBLOCK)), ("FNONBLOCK", i64::from(libc::O_NONBLOCK)),
			("S_ISTXT", i64::from(libc::S_ISVTX)), ("S_IREAD", i64::from(libc::S_IRUSR)),
			("S_IWRITE", i64::from(libc::S_IWUSR)), ("S_IEXEC", i64::from(libc::S_IXUSR)),
		]);
	}
	#[cfg(target_os = "linux")]
	{
		libc_constants!(values; F_GETLEASE F_GETPIPE_SZ F_NOTIFY F_SETLEASE F_SETPIPE_SZ O_DIRECT O_LARGEFILE O_NOATIME O_RSYNC);
		// The libc crate lacks dnotify and F_[GS]ETSIG; these values are fixed by the Linux UAPI on every architecture.
		values.extend([("DN_ACCESS", 0x1), ("DN_MODIFY", 0x2), ("DN_CREATE", 0x4), ("DN_DELETE", 0x8), ("DN_RENAME", 0x10),
			("DN_ATTRIB", 0x20), ("DN_MULTISHOT", 0x8000_0000), ("F_SETSIG", 10), ("F_GETSIG", 11)]);
		values.extend([("LOCK_MAND", 32), ("LOCK_READ", 64), ("LOCK_WRITE", 128), ("LOCK_RW", 192)]);
		if cfg!(target_pointer_width = "64") {
			values.extend([("F_GETLK64", i64::from(libc::F_GETLK)), ("F_SETLK64", i64::from(libc::F_SETLK)), ("F_SETLKW64", i64::from(libc::F_SETLKW))]);
		}
	}
	#[cfg(target_vendor = "apple")]
	{
		libc_constants!(values; O_EVTONLY O_EXLOCK O_SHLOCK O_SYMLINK);
		values.extend([("F_SETLEASE", 106), ("F_GETLEASE", 107), ("S_IFWHT", 0o160000)]);
	}
	#[cfg(windows)]
	{
		values.extend([("O_BINARY", 0x8000), ("O_TEXT", 0x4000), ("O_NOINHERIT", 0x80), ("O_RANDOM", 0x10),
			("O_SEQUENTIAL", 0x20), ("O_TEMPORARY", 0x40), ("O_ACCMODE", 3),
			("LOCK_SH", 1), ("LOCK_EX", 2), ("LOCK_NB", 4), ("LOCK_UN", 8), ("_S_IFMT", 0o170000)]);
	}
	#[cfg(not(windows))]
	values.extend([("O_BINARY", 0), ("O_TEXT", 0)]);
	let defaults: Vec<_> = FCNTL_DEFAULT.split_ascii_whitespace().collect();
	let optional: Vec<_> = [FCNTL_OPTIONAL, FCNTL_SEEK, FCNTL_COMPAT, FCNTL_MODE, FCNTL_FLOCK].into_iter().flat_map(str::split_ascii_whitespace).collect();
	for name in defaults.iter().chain(&optional).copied() {
		let qual = format!("Fcntl::{name}");
		if let Some(&value) = values.get(name) { constant(interp, &qual, Value::Int(value)); }
		else if mode_test(name).is_some() || matches!(name, "S_IFMT" | "S_IMODE") { interp.define_native(&qual, fcntl_mode); }
		else if matches!(name, "S_ISWHT" | "S_ISENFMT") { interp.define_native(&qual, missing_fcntl); }
		else { interp.define_native_proto(&qual, missing_fcntl, ""); }
	}
	export(interp, module, &defaults, &optional);
	for (tag, names) in [("seek", FCNTL_SEEK), ("flock", FCNTL_FLOCK), ("mode", FCNTL_MODE), ("Fcompat", FCNTL_COMPAT)] {
		export_tag(interp, module, tag, &names.split_ascii_whitespace().collect::<Vec<_>>());
	}
}

fn missing_fcntl(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let qualified = interp.current_sub_name();
	let name = qualified.as_deref().and_then(|s| s.rsplit("::").next()).unwrap_or_default();
	Err(interp.die_msg(format!("Your vendor has not defined Fcntl macro {name}, used")))
}

fn mode_test(name: &str) -> Option<i64> {
	Some(match name {
		"S_ISFIFO" => 0o010000, "S_ISCHR" => 0o020000, "S_ISDIR" => 0o040000, "S_ISBLK" => 0o060000,
		"S_ISREG" => 0o100000, "S_ISLNK" => 0o120000, "S_ISSOCK" => 0o140000,
		"S_ISWHT" if cfg!(target_vendor = "apple") => 0o160000,
		_ => return None,
	})
}

fn fcntl_mode(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let qualified = interp.current_sub_name();
	let name = qualified.as_deref().and_then(|s| s.rsplit("::").next()).unwrap_or_default();
	let mode = arg(&args, 0).to_i64();
	Ok(match name {
		"S_IFMT" => Ret::One(Value::Int(if args.is_empty() { 0o170000 } else { mode & 0o170000 })),
		"S_IMODE" => Ret::One(Value::Int(mode & 0o7777)),
		_ => boolean(mode_test(name).is_some_and(|test| mode & 0o170000 == test)),
	})
}

const POSIX_ERRNO: &str = "E2BIG EACCES EADDRINUSE EADDRNOTAVAIL EAFNOSUPPORT EAGAIN EALREADY EBADF EBUSY ECHILD ECONNABORTED ECONNREFUSED ECONNRESET EDEADLK EDESTADDRREQ EDOM EDQUOT EEXIST EFAULT EFBIG EHOSTDOWN EHOSTUNREACH EINPROGRESS EINTR EINVAL EIO EISCONN EISDIR ELOOP EMFILE EMLINK EMSGSIZE ENAMETOOLONG ENETDOWN ENETRESET ENETUNREACH ENFILE ENOBUFS ENODEV ENOENT ENOEXEC ENOLCK ENOMEM ENOPROTOOPT ENOSPC ENOSYS ENOTBLK ENOTCONN ENOTDIR ENOTEMPTY ENOTSOCK ENOTTY ENXIO EOPNOTSUPP EPERM EPFNOSUPPORT EPIPE EPROCLIM EPROTONOSUPPORT EPROTOTYPE ERANGE EREMOTE EROFS ESHUTDOWN ESOCKTNOSUPPORT ESPIPE ESRCH ESTALE ETIMEDOUT ETOOMANYREFS ETXTBSY EUSERS EWOULDBLOCK EXDEV";

/// Active `%!` aliases indexed by OS errno.
pub(super) struct ErrnoState {
	current: i32,
	codes: BTreeMap<i32, Vec<Sv>>,
}

fn load_errno(interp: &mut Interp<'_>, module: &str) {
	version(interp, module, "1.33");
	let mut errors = BTreeMap::new();
	libc_constants!(errors; E2BIG EACCES EAGAIN EBADF EBUSY ECHILD EDEADLK EDOM EEXIST EFAULT EFBIG EINTR EINVAL EIO EISDIR EMFILE EMLINK
		ENAMETOOLONG ENFILE ENODEV ENOENT ENOEXEC ENOLCK ENOMEM ENOSPC ENOSYS ENOTDIR ENOTEMPTY ENOTTY ENXIO EPERM EPIPE ERANGE EROFS ESPIPE ESRCH EXDEV);
	#[cfg(unix)]
	libc_constants!(errors; EADDRINUSE EADDRNOTAVAIL EAFNOSUPPORT EALREADY EBADMSG ECANCELED ECONNABORTED ECONNREFUSED ECONNRESET EDESTADDRREQ
		EDQUOT EHOSTDOWN EHOSTUNREACH EIDRM EILSEQ EINPROGRESS EISCONN ELOOP EMSGSIZE ENETDOWN ENETRESET ENETUNREACH ENOBUFS ENOMSG ENOPROTOOPT ENOTBLK
		ENOTCONN ENOTRECOVERABLE ENOTSOCK ENOTSUP EOPNOTSUPP EOVERFLOW EOWNERDEAD EPFNOSUPPORT EPROTO EPROTONOSUPPORT EPROTOTYPE EREMOTE ESHUTDOWN
		ESOCKTNOSUPPORT ESTALE ETIMEDOUT ETOOMANYREFS ETXTBSY EUSERS EWOULDBLOCK);
	#[cfg(any(target_os = "linux", target_vendor = "apple"))]
	libc_constants!(errors; EMULTIHOP ENODATA ENOLINK ENOSR ENOSTR ETIME);
	#[cfg(target_vendor = "apple")]
	{
		libc_constants!(errors; EAUTH EBADARCH EBADEXEC EBADMACHO EBADRPC EDEVERR EFTYPE ENEEDAUTH ENOATTR ENOPOLICY EPWROFF EPROCUNAVAIL EPROCLIM EPROGMISMATCH EPROGUNAVAIL ERPCMISMATCH ESHLIBVERS);
		errors.extend([("EQFULL", 106), ("ENOTCAPABLE", 107), ("ELAST", 107)]);
	}
	#[cfg(target_os = "linux")]
	libc_constants!(errors; EADV EBADE EBADFD EBADSLT EBFONT ECHRNG ECOMM EDEADLOCK EDOTDOT EHWPOISON EISNAM EKEYEXPIRED EKEYREJECTED EKEYREVOKED EL2HLT EL2NSYNC EL3HLT EL3RST ELIBACC ELIBBAD ELIBEXEC ELIBMAX ELIBSCN ELNRNG EMEDIUMTYPE ENAVAIL ENOCSI ENOKEY ENOMEDIUM ENONET ENOPKG ENOTNAM ENOTUNIQ EREMCHG EREMOTEIO ERESTART ERFKILL ESRMNT ESTRPIPE EUCLEAN EUNATCH EXFULL);
	let current = interp.sv("main::!").get().to_i64() as i32;
	let hv = interp.hv("main::!");
	let mut codes: BTreeMap<i32, Vec<Sv>> = BTreeMap::new();
	{
		let mut values = hv.entries_mut();
		for (&name, &code) in &errors {
			constant(interp, &format!("Errno::{name}"), Value::Int(code));
			let code = code as i32;
			let cell = new_sv(Value::Int(if code == current { i64::from(code) } else { 0 }));
			values.insert(key(name), cell.clone());
			codes.entry(code).or_default().push(cell);
		}
	}
	interp.modules.errno = Some(ErrnoState { current, codes });
	interp.modules.hash_locks.change(&hv).read_only_container = Some("ERRNO hash is read only!");
	let optional: Vec<_> = errors.keys().copied().collect();
	let posix: Vec<_> = POSIX_ERRNO.split_ascii_whitespace().filter(|name| errors.contains_key(name)).collect();
	export(interp, module, &[], &optional);
	export_tag(interp, module, "POSIX", &posix);
}

/// Update live `%!` aliases after a native error or assignment to `$!`.
pub(in crate::perl) fn update_errno(interp: &mut Interp<'_>, code: i32) {
	let Some(state) = &mut interp.modules.errno else { return; };
	if state.current == code { return; }
	for (number, flag) in [(state.current, 0), (code, i64::from(code))] {
		if let Some(cells) = state.codes.get(&number) {
			for cell in cells { cell.set(Value::Int(flag)); }
		}
	}
	state.current = code;
}

fn symbol_name(interp: &Interp<'_>, args: &[Sv], name: &PStr) -> PStr {
	let bytes = &name.bytes;
	if bytes.contains(&b'\'') || bytes.windows(2).any(|w| w == b"::") { return name.clone(); }
	let one_special = bytes.len() == 1 && !bytes[0].is_ascii_alphabetic() && bytes[0].is_ascii();
	let global = one_special || matches!(bytes.as_slice(), b"STDIN" | b"STDOUT" | b"STDERR" | b"ARGV" | b"ARGVOUT" | b"INC" | b"ENV" | b"SIG");
	let mut out = if global { PStr::from_bytes(b"main") } else {
		let pkg = arg(args, 1);
		if pkg.truthy() { pkg.to_pstr() } else { PStr::from_str(&interp.package()) }
	};
	out.push_bytes(b"::");
	out.push(name);
	out
}

fn qualify(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let v = arg(&args, 0);
	Ok(Ret::One(match v {
		Value::Ref(Ref::Glob(_)) | Value::Glob(_) => v,
		v => Value::Str(symbol_name(interp, &args, &v.to_pstr())),
	}))
}

fn qualify_to_ref(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(match arg(&args, 0) {
		v @ Value::Ref(Ref::Glob(_)) => v,
		Value::Glob(gv) => Value::Ref(Ref::Glob(gv)),
		v => {
			let qual = symbol_name(interp, &args, &v.to_pstr());
			Value::Ref(Ref::Glob(interp.glob(&qual.to_string_lossy())))
		},
	}))
}

fn gensym(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(Value::Ref(Ref::Glob(fresh_symbol(interp)))))
}

fn fresh_symbol(interp: &mut Interp<'_>) -> Gv {
	let next = interp.sv("Symbol::_next");
	let n = next.get().to_i64();
	next.set(Value::Int(n.wrapping_add(1)));
	new_gv(Rc::from("Symbol"), Rc::from(format!("GEN{n}")))
}

fn geniosym(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let io = Ref::Io(Rc::new(RefCell::new(Handle::closed())));
	io.bless(Rc::from("IO::File"));
	Ok(Ret::One(Value::Ref(io)))
}

// Generated symbols are detached from their stash from the start.
fn ungensym(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::empty()) }

fn delete_package(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let package = text(&args, 0).replace('\'', "::");
	let package = package.trim_end_matches("::");
	let package = package.strip_prefix("main::").unwrap_or(package);
	if package.is_empty() { return Err(interp.die_msg("Can't use an undefined value as a symbol reference")); }
	if package == "main" { return Err(interp.die_msg("Modification of a read-only value attempted")); }
	interp.remove_package(package);
	Ok(Ret::empty())
}

#[derive(Default)]
struct Lock {
	restricted: bool,
	legal: HashSet<HKey>,
	readonly: HashSet<HKey>,
	read_only_container: Option<&'static str>,
}

/// Hash::Util's metadata for live interpreter hashes, without retaining the hashes.
#[derive(Default)]
pub(super) struct HashLocks {
	entries: HashMap<usize, (Weak<HashBody>, Lock)>,
	next_sweep: usize,
}

impl HashLocks {
	fn get(&self, hv: &Hv) -> Option<&Lock> {
		let (weak, lock) = self.entries.get(&(Rc::as_ptr(hv) as usize))?;
		(weak.strong_count() != 0).then_some(lock)
	}

	fn change(&mut self, hv: &Hv) -> &mut Lock {
		if self.entries.len() >= self.next_sweep {
			self.entries.retain(|_, (weak, _)| weak.strong_count() != 0);
			self.next_sweep = self.entries.len().saturating_mul(2).max(16);
		}
		let (weak, lock) = self.entries.entry(Rc::as_ptr(hv) as usize).or_insert_with(|| (Rc::downgrade(hv), Lock::default()));
		if weak.strong_count() == 0 { *weak = Rc::downgrade(hv); *lock = Lock::default(); }
		lock
	}
}

/// Reject illegal reads, writes, and deletion of restricted hash entries.
pub(in crate::perl) fn check_hash_access(interp: &mut Interp<'_>, hv: &Hv, key: &HKey, access: HashAccess) -> PResult<()> {
	let Some(lock) = interp.modules.hash_locks.get(hv) else { return Ok(()); };
	let error = if !matches!(access, HashAccess::Read) && let Some(message) = lock.read_only_container {
		Some(message.to_owned())
	} else if lock.restricted && !lock.legal.contains(key) {
		let key = key.to_pstr();
		let key = key.to_string_lossy();
		Some(if matches!(access, HashAccess::Delete) { format!("Attempt to delete disallowed key '{key}' from a restricted hash") }
			else { format!("Attempt to access disallowed key '{key}' in a restricted hash") })
	} else if lock.readonly.contains(key) {
		match access {
			HashAccess::Write => Some("Modification of a read-only value attempted".into()),
			HashAccess::Delete if lock.restricted => Some(format!("Attempt to delete readonly key '{}' from a restricted hash", key.to_pstr().to_string_lossy())),
			_ => None,
		}
	} else { None };
	match error { Some(error) => Err(interp.die_msg(error)), None => Ok(()) }
}

/// A wholesale replacement cannot remove a restricted hash's readonly values.
pub(in crate::perl) fn check_hash_clear(interp: &mut Interp<'_>, hv: &Hv) -> PResult<()> {
	let Some(lock) = interp.modules.hash_locks.get(hv) else { return Ok(()); };
	let message = if let Some(message) = lock.read_only_container { Some(message.to_owned()) }
	else if lock.restricted {
		hv.entries().keys().find(|key| lock.readonly.contains(*key))
			.map(|key| format!("Attempt to delete readonly key '{}' from a restricted hash", key.to_pstr().to_string_lossy()))
	} else { None };
	match message { Some(message) => Err(interp.die_msg(message)), None => Ok(()) }
}

fn load_hash_util(interp: &mut Interp<'_>, module: &str) {
	version(interp, module, "0.25");
	let fns = [
		("all_keys", "\\%\\@\\@", all_keys as NativeFn), ("lock_keys", "\\%;@", lock_keys), ("unlock_keys", "\\%", unlock_keys),
		("lock_value", "\\%$", lock_value), ("unlock_value", "\\%$", unlock_value), ("lock_hash", "\\%", lock_hash),
		("unlock_hash", "\\%", unlock_hash), ("lock_keys_plus", "\\%;@", lock_keys_plus), ("hash_locked", "\\%", hash_locked),
		("hash_unlocked", "\\%", hash_unlocked), ("hidden_keys", "\\%", hidden_keys), ("legal_keys", "\\%", legal_keys),
		("hash_seed", "", hash_seed), ("hash_value", "$;$", hash_value), ("hv_store", "\\%$$", hv_store),
		("lock_hash_recurse", "\\%", lock_hash_recurse), ("unlock_hash_recurse", "\\%", unlock_hash_recurse),
		("bucket_ratio", "\\%", bucket_ratio), ("used_buckets", "\\%", used_buckets), ("num_buckets", "\\%", num_buckets),
		("fieldhash", "\\%", no_fieldhash),
	];
	let reference: &[(&str, NativeFn)] = &[("hashref_locked", hash_locked), ("hashref_unlocked", hash_unlocked),
		("lock_ref_keys", lock_keys), ("unlock_ref_keys", unlock_keys), ("lock_ref_value", lock_value), ("unlock_ref_value", unlock_value),
		("lock_hashref", lock_hash), ("unlock_hashref", unlock_hash), ("lock_ref_keys_plus", lock_keys_plus), ("hidden_ref_keys", hidden_keys),
		("legal_ref_keys", legal_keys), ("lock_hashref_recurse", lock_hash_recurse), ("unlock_hashref_recurse", unlock_hash_recurse),
		("bucket_stats", bucket_stats), ("bucket_stats_formatted", bucket_stats_formatted), ("bucket_info", bucket_info), ("bucket_array", bucket_array),
		("hash_traversal_mask", hash_traversal_mask), ("fieldhashes", no_fieldhash)];
	for (name, proto, f) in fns { interp.define_native_proto(&format!("{module}::{name}"), f, proto); }
	define(interp, module, reference);
	let names: Vec<_> = fns.iter().map(|(name, _, _)| *name).chain(reference.iter().map(|(name, _)| *name)).collect();
	export(interp, module, &[], &names);
}

fn hash_arg(interp: &mut Interp<'_>, args: &[Sv]) -> PResult<Hv> {
	if let Value::Ref(Ref::Hash(hv)) = arg(args, 0) { Ok(hv) }
	else { Err(interp.die_msg("Not a HASH reference")) }
}

fn hash_ref(hv: Hv) -> Ret { Ret::One(Value::Ref(Ref::Hash(hv))) }

/// Report Perl's read-only container bit for a hash.
pub(in crate::perl) fn readonly_hash(interp: &Interp<'_>, hash: &Hv) -> bool {
	interp.modules.hash_locks.get(hash).is_some_and(|lock| lock.restricted || lock.read_only_container.is_some())
}

/// Set or clear the structural restriction, without locking the values.
pub(super) fn set_hash_readonly(interp: &mut Interp<'_>, hash: &Hv, on: bool) {
	if on {
		let lock = interp.modules.hash_locks.change(hash);
		if !lock.restricted {
			lock.legal = hash.entries().keys().cloned().collect();
			lock.restricted = true;
		}
	} else if interp.modules.hash_locks.get(hash).is_some() {
		interp.modules.hash_locks.change(hash).restricted = false;
	}
}

fn lock_keys_inner(interp: &mut Interp<'_>, args: Vec<Sv>, plus: bool) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let mut keys = HashSet::with_capacity(args.len().saturating_sub(1));
	for sv in args.iter().skip(1) {
		let value = interp.read_sv(sv)?;
		keys.insert(HKey::new(&interp.stringify(&value)?));
	}
	if plus {
		for key in &keys { check_hash_access(interp, &hv, key, HashAccess::Read)?; }
	}
	if plus || args.len() < 2 { keys.extend(hv.entries().keys().cloned()); }
	if !plus && let Some(k) = hv.entries().keys().find(|k| !keys.contains(*k)) {
		return Err(interp.die_msg(format!("Hash has key '{}' which is not in the new key set", k.to_pstr().to_string_lossy())));
	}
	let lock = interp.modules.hash_locks.change(&hv);
	if plus { lock.legal.extend(keys); } else { lock.legal = keys; }
	lock.restricted = true;
	Ok(hash_ref(hv))
}

fn lock_keys(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { lock_keys_inner(interp, args, false) }
fn lock_keys_plus(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { lock_keys_inner(interp, args, true) }

fn unlock_keys(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	if interp.modules.hash_locks.get(&hv).is_some() { interp.modules.hash_locks.change(&hv).restricted = false; }
	Ok(hash_ref(hv))
}

fn edit_value_lock(interp: &mut Interp<'_>, args: Vec<Sv>, set: bool) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let name = interp.stringify(&arg(&args, 1))?;
	let key = HKey::new(&name);
	let restricted = interp.modules.hash_locks.get(&hv).is_some_and(|lock| lock.restricted);
	if restricted && !interp.modules.hash_locks.get(&hv).is_some_and(|lock| lock.legal.contains(&key)) {
		return Err(interp.die_msg(format!("Attempt to access disallowed key '{}' in a restricted hash", name.to_string_lossy())));
	}
	if set && !restricted && interp.warn_on("misc") { interp.warn("Cannot usefully lock values in an unlocked hash"); }
	hv.entries_mut().entry(key.clone()).or_insert_with(|| new_sv(Value::Undef));
	let lock = interp.modules.hash_locks.change(&hv);
	if set { lock.readonly.insert(key); } else { lock.readonly.remove(&key); }
	Ok(hash_ref(hv))
}

fn lock_value(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { edit_value_lock(interp, args, true) }
fn unlock_value(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { edit_value_lock(interp, args, false) }

fn mark_hash(interp: &mut Interp<'_>, hv: &Hv, set: bool) {
	if set {
		let lock = interp.modules.hash_locks.change(hv);
		lock.restricted = true;
		lock.legal.clear();
		lock.readonly.clear();
		for key in hv.entries().keys() { lock.legal.insert(key.clone()); lock.readonly.insert(key.clone()); }
	} else if interp.modules.hash_locks.get(hv).is_some() {
		let lock = interp.modules.hash_locks.change(hv);
		lock.restricted = false;
		lock.readonly.clear();
	}
}

fn lock_hash(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	mark_hash(interp, &hv, true);
	Ok(hash_ref(hv))
}

fn unlock_hash(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	mark_hash(interp, &hv, false);
	Ok(hash_ref(hv))
}

fn recurse_hash(interp: &mut Interp<'_>, args: Vec<Sv>, set: bool) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let mut pending = vec![hv.clone()];
	let mut visited = HashSet::new();
	while let Some(h) = pending.pop() {
		if !visited.insert(Rc::as_ptr(&h)) { continue; }
		mark_hash(interp, &h, set);
		pending.extend(h.entries().values().filter_map(|v| match v.get() { Value::Ref(Ref::Hash(h)) => Some(h), _ => None }));
	}
	Ok(hash_ref(hv))
}

fn lock_hash_recurse(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { recurse_hash(interp, args, true) }
fn unlock_hash_recurse(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { recurse_hash(interp, args, false) }

fn hash_locked(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	Ok(boolean(interp.modules.hash_locks.get(&hv).is_some_and(|l| l.restricted)))
}

fn hash_unlocked(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	Ok(boolean(interp.modules.hash_locks.get(&hv).is_none_or(|l| !l.restricted)))
}

fn hash_keys(interp: &Interp<'_>, hv: &Hv) -> (Vec<Value>, Vec<Value>) {
	let map = hv.entries();
	let visible = map.keys().map(|k| Value::Str(k.to_pstr())).collect();
	let hidden = interp.modules.hash_locks.get(hv).map_or_else(Vec::new, |l| {
		l.legal.iter().filter(|k| !map.contains_key(*k)).map(|k| Value::Str(k.to_pstr())).collect()
	});
	(visible, hidden)
}

fn hidden_keys(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let map = hv.entries();
	let values = interp.modules.hash_locks.get(&hv).into_iter().flat_map(|lock| &lock.legal)
		.filter(|key| !map.contains_key(*key)).map(|key| Value::Str(key.to_pstr()));
	Ok(if cx == Cx::List { Ret::Many(values.collect()) } else { Ret::One(values.last().unwrap_or(Value::Undef)) })
}

fn legal_keys(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let (mut visible, hidden) = hash_keys(interp, &hv);
	visible.extend(hidden);
	Ok(if cx == Cx::List { Ret::Many(visible) } else { Ret::One(visible.pop().unwrap_or(Value::Undef)) })
}

fn all_keys(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let (Value::Ref(Ref::Array(visible)), Value::Ref(Ref::Array(hidden))) = (arg(&args, 1), arg(&args, 2)) else {
		return Err(interp.die_msg("Not an ARRAY reference"));
	};
	let (v, h) = hash_keys(interp, &hv);
	visible.replace_elems(v.into_iter().map(new_sv).collect());
	hidden.replace_elems(h.into_iter().map(new_sv).collect());
	Ok(hash_ref(hv))
}

fn hv_store(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let name = interp.stringify(&arg(&args, 1))?;
	let key = HKey::new(&name);
	check_hash_access(interp, &hv, &key, HashAccess::Write)?;
	if let Some(value) = args.get(2) { hv.entries_mut().insert(key, value.clone()); }
	Ok(boolean(true))
}

// IndexMap's hasher is deterministic and does not use a process seed.
fn hash_seed(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::bytes(&[]))) }

fn hash_value(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let input = interp.stringify(&arg(&args, 0))?;
	let mut hasher = rustc_hash::FxHasher::default();
	if args.len() > 1 {
		let seed = arg(&args, 1).to_pstr();
		if !seed.is_empty() && seed.bytes.len() < 32 { return Err(interp.die_msg(format!("seed len must be at least 32 long only got {} bytes", seed.bytes.len()))); }
		if !seed.is_empty() { hasher.write(&seed.bytes[..32]); }
	}
	HKey::new(&input).hash(&mut hasher);
	Ok(Ret::One(Value::Int(i64::from(hasher.finish() as u32))))
}

// IndexMap does not expose its open-addressed probe table. These diagnostics
// describe home buckets of the same hash function, not private probe slots.
struct Buckets<'a> {
	slots: BTreeMap<usize, Vec<&'a HKey>>,
	count: usize,
}

impl<'a> Buckets<'a> {
	fn for_hash(map: &'a HashEntries) -> Self {
		let count = map.capacity().saturating_add(map.capacity() / 7).next_power_of_two().max(8);
		let mut slots = BTreeMap::<usize, Vec<&HKey>>::new();
		for key in map.keys() {
			let mut hash = rustc_hash::FxHasher::default();
			key.hash(&mut hash);
			slots.entry(hash.finish() as usize & (count - 1)).or_default().push(key);
		}
		Self { slots, count }
	}

	fn histogram(&self) -> Vec<usize> {
		let deepest = self.slots.values().map(Vec::len).max().unwrap_or(0);
		let mut counts = vec![0; deepest + 1];
		counts[0] = self.count - self.slots.len();
		for chain in self.slots.values() { counts[chain.len()] += 1; }
		counts
	}
}

fn integer(n: usize) -> Value { Value::Int(n as i64) }

fn num_buckets(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let capacity = hv.entries().capacity();
	Ok(Ret::One(integer(capacity.saturating_add(capacity / 7).next_power_of_two().max(8))))
}

fn used_buckets(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	Ok(Ret::One(integer(Buckets::for_hash(&hv.entries()).slots.len())))
}

fn bucket_ratio(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let map = hv.entries();
	let buckets = Buckets::for_hash(&map);
	Ok(Ret::One(if map.is_empty() { Value::Int(0) } else { Value::str(&format!("{}/{}", buckets.slots.len(), buckets.count)) }))
}

fn bucket_info(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let map = hv.entries();
	let buckets = Buckets::for_hash(&map);
	let mut info = vec![integer(map.len()), integer(buckets.count), integer(buckets.slots.len())];
	if !map.is_empty() { info.extend(buckets.histogram().into_iter().map(integer)); }
	Ok(if cx == Cx::List { Ret::Many(info) } else { Ret::One(if map.is_empty() { Value::Int(0) } else { Value::Undef }) })
}

fn bucket_array(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hv = hash_arg(interp, &args)?;
	let map = hv.entries();
	if map.is_empty() { return Ok(Ret::One(Value::Undef)); }
	let buckets = Buckets::for_hash(&map);
	let mut out = Vec::new();
	let mut last = 0;
	for (idx, keys) in buckets.slots {
		if idx > last { out.push(integer(idx - last)); }
		out.push(Value::Ref(Ref::Array(new_av(keys.into_iter().map(|k| Value::Str(k.to_pstr())).collect()))));
		last = idx + 1;
	}
	if last < buckets.count { out.push(integer(buckets.count - last)); }
	Ok(Ret::One(Value::Ref(Ref::Array(new_av(out)))))
}

struct BucketStats {
	keys: usize,
	count: usize,
	used: usize,
	qual: f64,
	used_ratio: f64,
	collision_ratio: f64,
	mean: f64,
	stddev: f64,
	histogram: Vec<usize>,
}

impl BucketStats {
	fn new(hv: &Hv) -> Self {
		let map = hv.entries();
		let b = Buckets::for_hash(&map);
		let keys = map.len();
		let used = b.slots.len();
		let histogram = b.histogram();
		let mean = if used == 0 { 0.0 } else { keys as f64 / used as f64 };
		let sum_squares: f64 = histogram.iter().enumerate().skip(1).map(|(len, &n)| (len as f64 - mean).powi(2) * n as f64).sum();
		let stddev = if used == 0 { 0.0 } else { (sum_squares / used as f64).sqrt() };
		let collided = keys - used;
		let collision_ratio = if keys == 0 { 0.0 } else { collided as f64 / keys as f64 };
		let used_ratio = used as f64 / b.count as f64;
		let comparisons: f64 = histogram.iter().enumerate().map(|(len, &n)| len as f64 * (len + 1) as f64 / 2.0 * n as f64).sum();
		let qual = if keys == 0 { 0.0 } else { comparisons / (keys as f64 + keys as f64 * (keys - 1) as f64 / (2.0 * b.count as f64)) };
		Self { keys, count: b.count, used, qual, used_ratio, collision_ratio, mean, stddev, histogram }
	}
}

fn bucket_stats(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let s = BucketStats::new(&hash_arg(interp, &args)?);
	let mut out = vec![integer(s.keys), integer(s.count), integer(s.used)];
	if s.keys != 0 {
		out.extend([Value::Num(s.qual), Value::Num(s.used_ratio), Value::Num(s.collision_ratio), Value::Num(s.mean), Value::Num(s.stddev)]);
		out.extend(s.histogram.into_iter().map(integer));
	}
	Ok(if cx == Cx::List { Ret::Many(out) } else { Ret::One(Value::Undef) })
}

fn bucket_stats_formatted(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	use std::fmt::Write;
	let s = BucketStats::new(&hash_arg(interp, &args)?);
	let quality = if s.qual < 1.05 { "Good" } else { "Poor" };
	let optimal = s.keys.min(s.count) as f64 * 100.0 / s.count as f64;
	let mut message = format!("Keys: {} Buckets: {}/{} Quality-Score: {:.2} ({quality})\nUtilized Buckets: {:.2}% Optimal: {optimal:.2}% Keys In Collision: {:.2}%\nChain Length - mean: {:.2} stddev: {:.2}\n",
		s.keys, s.used, s.count, s.qual, s.used_ratio * 100.0, s.collision_ratio * 100.0, s.mean, s.stddev);
	if s.keys != 0 {
		let mut positions = vec![0; s.histogram.len() - 1];
		let mut position_count = 0;
		for (out, &len) in positions.iter_mut().rev().zip(s.histogram.iter().skip(1).rev()) {
			position_count += len;
			*out = position_count;
		}
		for (name, label, base, total, counts) in [
			("Buckets", "Len", 0, s.count, &s.histogram[..]), ("Keys", "Pos", 1, s.keys, &positions[..]),
		] {
			let max = total.min(64) as f64;
			let bars: Vec<_> = counts.iter().map(|&n| (n as f64 * max / total as f64).round() as usize).collect();
			let _ = write!(message, "{name:<15}{total:>7} [");
			for (i, &len) in bars.iter().enumerate() {
				let digit = char::from_digit((i + base).min(35) as u32, 36).unwrap_or('+');
				message.extend(std::iter::repeat_n(digit, len));
			}
			message.push_str("]\n");
			for (i, (&n, &len)) in counts.iter().zip(&bars).enumerate() {
				let number = i + base;
				let ratio = n as f64 * 100.0 / total as f64;
				let _ = writeln!(message, "{label} {number:>3} {ratio:>6.2}% {n:>6} [{}]", "#".repeat(len));
			}
		}
	}
	Ok(Ret::One(Value::str(&message)))
}

// IndexMap iterates in insertion order and has no perturbation mask.
fn hash_traversal_mask(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::Undef)) }

fn no_fieldhash(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Err(interp.die_msg("Field hashes require reference lifetime tracking"))
}

const fn env_delimiter_str() -> &'static str { if cfg!(windows) { ";" } else { ":" } }

fn load_env(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	version(interp, module, "1.05");
	interp.require_module("Tie::Array")?;
	isa(interp, "Env::Array", &["Tie::Array"]);
	define(interp, module, &[("import", env_import), ("TIESCALAR", tie_env), ("FETCH", fetch_env), ("STORE", store_env)]);
	define(interp, "Env::Array", &[("TIEARRAY", tie_env), ("FETCH", fetch_env_array), ("STORE", store_env_array),
		("FETCHSIZE", size_env_array), ("STORESIZE", resize_env_array), ("EXISTS", exists_env_array), ("DELETE", delete_env_array)]);
	Ok(())
}

fn env_name_valid(s: &PStr) -> bool {
	let mut chars = s.chars().map(char::from_u32);
	chars.next().flatten().is_some_and(|c| c == '_' || c.is_alphabetic())
		&& chars.all(|c| c.is_some_and(|c| c == '_' || c.is_alphanumeric()))
}

fn env_import(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let dest = interp.package();
	let env = interp.hv("main::ENV");
	let names: Vec<PStr> = if args.len() < 2 { env.entries().keys().map(HKey::to_pstr).collect() }
	else { args.iter().skip(1).map(|s| Ok(interp.read_sv(s)?.to_pstr())).collect::<PResult<_>>()? };
	for mut name in names {
		let array = name.bytes.first() == Some(&b'@');
		if array || name.bytes.first() == Some(&b'$') { name.bytes.remove(0); }
		if !env_name_valid(&name) { continue; }
		let qualified = format!("{dest}::{}", name.to_string_lossy());
		let gv = interp.glob(&qualified);
		*interp.modules.vars.entry(qualified).or_default() |= if array { 2 } else { 1 };
		let entry = env.entries().get(&HKey::new(&name)).cloned();
		if array {
			let value = entry.as_ref().map_or(Value::Undef, |v| v.get());
			gv.array.replace(new_av(split_env(value)));
		} else if let Some(cell) = entry { gv.scalar.replace(cell); }
	}
	Ok(Ret::empty())
}

fn tie_env(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let class = text(&args, 0);
	let obj = Ref::Scalar(new_sv(arg(&args, 1)));
	obj.bless(Rc::from(class));
	Ok(Ret::One(Value::Ref(obj)))
}

fn env_key(interp: &mut Interp<'_>, args: &[Sv]) -> PResult<(Hv, HKey)> {
	if let Value::Ref(Ref::Scalar(name)) = arg(args, 0) {
		let name = HKey::new(&interp.read_sv(&name)?.to_pstr());
		Ok((interp.hv("main::ENV"), name))
	} else { Err(interp.die_msg("Not a SCALAR reference")) }
}

fn fetch_env(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (env, name) = env_key(interp, &args)?;
	Ok(Ret::One(env.entries().get(&name).map_or(Value::Undef, |s| s.get())))
}

fn set_env(env: &Hv, key: HKey, value: Value) {
	let mut map = env.entries_mut();
	if value.is_undef() { map.shift_remove(&key); }
	else { map.entry(key).or_insert_with(|| new_sv(Value::Undef)).set(value); }
}

fn store_env(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (env, name) = env_key(interp, &args)?;
	let value = arg(&args, 1);
	set_env(&env, name, value.clone());
	Ok(Ret::One(value))
}

fn split_env(value: Value) -> Vec<Value> {
	let source = value.to_pstr();
	if source.is_empty() { return Vec::new(); }
	let sep = env_delimiter_str().as_bytes()[0];
	let meaningful_end = source.bytes.iter().rposition(|&c| c != sep).map_or(0, |i| i + 1);
	let mut offset = 0;
	source.bytes.split(|&c| c == sep).map(|part| {
		let value = if offset >= meaningful_end { Value::Undef } else { Value::Str(PStr::new(part.to_vec(), source.utf8)) };
		offset += part.len() + 1;
		value
	}).collect()
}

fn env_array(interp: &mut Interp<'_>, args: &[Sv]) -> PResult<(Hv, HKey, Vec<Value>)> {
	let (hv, name) = env_key(interp, args)?;
	let values = hv.entries().get(&name).map_or_else(Vec::new, |v| split_env(v.get()));
	Ok((hv, name, values))
}

fn save_env_array(hv: &Hv, name: HKey, values: &[Value]) {
	let mut out = PStr::default();
	for (i, v) in values.iter().enumerate() {
		if i > 0 { out.push_bytes(env_delimiter_str().as_bytes()); }
		out.push(&v.to_pstr());
	}
	set_env(hv, name, Value::Str(out));
}

fn env_index(args: &[Sv], len: usize) -> Option<usize> {
	let index = arg(args, 1).to_i64();
	if index < 0 { len.checked_sub(usize::try_from(index.unsigned_abs()).ok()?) } else { usize::try_from(index).ok() }
}

fn fetch_env_array(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (_, _, values) = env_array(interp, &args)?;
	Ok(Ret::One(env_index(&args, values.len()).and_then(|i| values.get(i).cloned()).unwrap_or(Value::Undef)))
}

fn store_env_array(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (hv, name, mut values) = env_array(interp, &args)?;
	let Some(i) = env_index(&args, values.len()) else { return Err(interp.die_msg("Modification of non-creatable array value attempted")); };
	let value = arg(&args, 2);
	if i >= values.len() {
		let extra = i + 1 - values.len();
		values.try_reserve(extra).map_err(|_| interp.die_msg("Out of memory extending environment array"))?;
		values.resize(i + 1, Value::Undef);
	}
	values[i] = value.clone();
	save_env_array(&hv, name, &values);
	Ok(Ret::One(value))
}

fn size_env_array(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(integer(env_array(interp, &args)?.2.len())))
}

fn resize_env_array(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (hv, name, mut values) = env_array(interp, &args)?;
	let size = arg(&args, 1).to_i64().max(0) as usize;
	values.try_reserve(size.saturating_sub(values.len())).map_err(|_| interp.die_msg("Out of memory extending environment array"))?;
	values.resize(size, Value::Undef);
	save_env_array(&hv, name, &values);
	Ok(Ret::One(integer(size)))
}

fn exists_env_array(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (_, _, values) = env_array(interp, &args)?;
	Ok(boolean(env_index(&args, values.len()).is_some_and(|i| i < values.len())))
}

fn delete_env_array(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (hv, name, mut values) = env_array(interp, &args)?;
	let Some(slot) = env_index(&args, values.len()).and_then(|i| values.get_mut(i)) else { return Ok(Ret::One(Value::Undef)); };
	let previous = std::mem::replace(slot, Value::Undef);
	while values.last().is_some_and(Value::is_undef) { values.pop(); }
	save_env_array(&hv, name, &values);
	Ok(Ret::One(previous))
}

fn open2(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { open_pipes(interp, args, false) }
fn open3(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { open_pipes(interp, args, true) }

#[cfg(any(unix, windows))]
enum Destination {
	Glob(Gv, Option<Sv>),
	Io(Io),
}

#[cfg(any(unix, windows))]
impl Destination {
	fn install(self, interp: &mut Interp<'_>, file: OpenFile, read: bool) -> PResult<()> {
		let mode = OpenMode { read, write: !read, append: false, truncate: false, create: false };
		let mut handle = Handle::from_descriptor(interp.host(), file, mode, Layers::default());
		if !read { handle.set_autoflush(true); }
		match self {
			Self::Glob(gv, cell) => {
				let io = Rc::new(RefCell::new(handle));
				let value = Value::Ref(Ref::Glob(gv.clone()));
				remember(interp, &io, value.clone(), gv.name.clone());
				interp.set_handle(&gv, io);
				if let Some(cell) = cell { interp.write_sv(&cell, value)?; }
			},
			Self::Io(io) => {
				handle.blessed.replace(io.borrow().blessed.borrow().clone());
				io.replace(handle);
				remember(interp, &io, Value::Ref(Ref::Io(io.clone())), Rc::from(""));
				interp.track_handle(&io);
			},
		}
		Ok(())
	}
}

#[cfg(any(unix, windows))]
enum Redirect {
	Pipe(Destination),
	Descriptor(Fd),
	Inherit,
}

#[cfg(any(unix, windows))]
fn bad_descriptor() -> std::io::Error { std::io::Error::from_raw_os_error(libc::EBADF) }

#[cfg(any(unix, windows))]
fn duplicate_fd(interp: &mut Interp<'_>, name: &str) -> std::io::Result<Fd> {
	let name = name.strip_prefix('*').unwrap_or(name);
	#[cfg(unix)]
	{
		let io = if let Ok(number) = name.parse::<i32>() {
			if let Some(io) = by_fd(interp, number) { io }
			else { return interp.host().paths().file(number).ok_or_else(bad_descriptor)?.to_fd(); }
		} else { interp.handle(name, false).ok_or_else(bad_descriptor)? };
		let copy = io.borrow().with_fd(|fd| fd.try_clone_to_owned().map(|fd| Fd::File(fd.into())));
		copy
	}
	#[cfg(windows)]
	{
		if let Ok(number) = name.parse::<i32>() { return interp.host().paths().file(number).ok_or_else(bad_descriptor)?.to_fd(); }
		match name {
			"STDIN" | "main::STDIN" => interp.host().stdin.file().to_fd(),
			"STDOUT" | "main::STDOUT" => interp.host().stdout_clone().to_fd(),
			"STDERR" | "main::STDERR" => interp.host().stderr_clone().to_fd(),
			_ => Err(bad_descriptor()),
		}
	}
}

#[cfg(any(unix, windows))]
fn endpoint(interp: &mut Interp<'_>, cell: &Sv, value: &Value, fd: u8) -> std::io::Result<Redirect> {
	let target = match value {
		Value::Ref(Ref::Glob(gv)) | Value::Glob(gv) => Destination::Glob(gv.clone(), None),
		Value::Ref(Ref::Io(io)) => Destination::Io(io.clone()),
		value => {
			let pstr = value.to_pstr();
			let name = pstr.to_string_lossy();
			if let Some(name) = name.strip_prefix("<&").or_else(|| name.strip_prefix(">&")) {
				let same_standard = (fd == 2 && matches!(name, "STDERR" | "main::STDERR" | "2"))
					|| (fd == 1 && matches!(name, "STDOUT" | "main::STDOUT" | "1"));
				return match duplicate_fd(interp, name) {
					Ok(fd) => Ok(Redirect::Descriptor(fd)),
					Err(e) if same_standard && (e.kind() == std::io::ErrorKind::Unsupported || e.raw_os_error() == Some(libc::EBADF)) => Ok(Redirect::Inherit),
					Err(e) => Err(e),
				};
			}
			if pstr.is_empty() {
				Destination::Glob(fresh_symbol(interp), Some(cell.clone()))
			} else if matches!(value, Value::Ref(_)) {
				return Err(bad_descriptor());
			} else {
				Destination::Glob(interp.glob(name.strip_prefix('*').unwrap_or(&name)), None)
			}
		},
	};
	Ok(Redirect::Pipe(target))
}

#[cfg(any(unix, windows))]
fn same_handle(a: &Value, b: &Value) -> bool {
	match (a, b) {
		(Value::Ref(Ref::Glob(a)) | Value::Glob(a), Value::Ref(Ref::Glob(b)) | Value::Glob(b)) => Rc::ptr_eq(a, b),
		(Value::Ref(Ref::Io(a)), Value::Ref(Ref::Io(b))) => Rc::ptr_eq(a, b),
		(Value::Str(a), Value::Str(b)) => a == b,
		_ => false,
	}
}

#[cfg(any(unix, windows))]
type PendingPipe = Option<(Destination, OpenFile)>;

#[cfg(any(unix, windows))]
fn input_channel(redirect: Redirect) -> std::io::Result<(Fd, PendingPipe)> {
	match redirect {
		Redirect::Descriptor(fd) => Ok((fd, None)),
		Redirect::Pipe(target) => {
			let (reader, writer) = std::io::pipe()?;
			Ok((Fd::from(reader), Some((target, OpenFile::from(writer)))))
		},
		Redirect::Inherit => Err(bad_descriptor()),
	}
}

#[cfg(any(unix, windows))]
fn output_channel(redirect: Redirect) -> std::io::Result<(Option<Fd>, PendingPipe)> {
	match redirect {
		Redirect::Descriptor(fd) => Ok((Some(fd), None)),
		Redirect::Pipe(target) => {
			let (reader, writer) = std::io::pipe()?;
			Ok((Some(Fd::from(writer)), Some((target, OpenFile::from(reader)))))
		},
		Redirect::Inherit => Ok((None, None)),
	}
}

#[cfg(any(unix, windows))]
fn start_pipes(interp: &mut Interp<'_>, args: &[Sv], argv: &[Vec<u8>], name: &str) -> PResult<i32> {
	use std::io;

	fn error(interp: &mut Interp<'_>, name: &str, program: &[u8], e: &io::Error) -> Flow {
		if interp.is_cancelled() { return Flow::Cancelled; }
		interp.set_errno(e);
		let message = e.to_string();
		let message = message.split(" (os error ").next().unwrap_or(&message);
		interp.die_msg(format!("{name}: exec of {} failed: {message}", String::from_utf8_lossy(program)))
	}

	let spec = match argv {
		[line] if !line.iter().all(u8::is_ascii_whitespace) => ShellSpec::Line(line),
		[_] => return Err(error(interp, name, &argv[0], &io::Error::from_raw_os_error(libc::ENOENT))),
		_ => ShellSpec::Argv(argv),
	};
	let context = ChildContext::new(interp.resolve_path(b"."), interp.env_pairs());
	let mut resolve = |e: io::Error| error(interp, name, &argv[0], &e);
	let mut cmd = context.apply(spec.exec_command().map_err(&mut resolve)?);
	let stdin = interp.read_sv(&args[0])?;
	let (stdin, input) = endpoint(interp, &args[0], &stdin, 0).and_then(input_channel)
		.map_err(|e| error(interp, name, &argv[0], &e))?;
	let stdout_value = interp.read_sv(&args[1])?;
	let (stdout, output) = endpoint(interp, &args[1], &stdout_value, 1).and_then(output_channel)
		.map_err(|e| error(interp, name, &argv[0], &e))?;
	let mut stderr_target = None;
	if let Some(stderr) = args.get(2) {
		let value = if Rc::ptr_eq(&args[1], stderr) { None } else { Some(interp.read_sv(stderr)?) };
		if let Some(value) = value.filter(|value| value.truthy() && !same_handle(&stdout_value, value)) {
			let (fd, target) = endpoint(interp, stderr, &value, 2).and_then(output_channel)
				.map_err(|e| error(interp, name, &argv[0], &e))?;
			if let Some(fd) = fd { cmd = cmd.stderr(fd); }
			stderr_target = target;
		} else {
			let fd = if let Some(stdout) = &stdout { stdout.try_clone() } else { interp.host().stdout_clone().to_fd() }
				.map_err(|e| error(interp, name, &argv[0], &e))?;
			cmd = cmd.stderr(fd);
		}
	}
	cmd = cmd.stdin(stdin);
	if let Some(stdout) = stdout { cmd = cmd.stdout(stdout); }
	let child = interp.host().spawn_command(cmd).map_err(|e| error(interp, name, &argv[0], &e))?;
	let id = register_host_child(interp, child);
	if let Some((target, file)) = input { target.install(interp, file, false)?; }
	for (target, file) in output.into_iter().chain(stderr_target) { target.install(interp, file, true)?; }
	Ok(id)
}

fn open_pipes(interp: &mut Interp<'_>, mut args: Vec<Sv>, stderr: bool) -> PResult<Ret> {
	let handles = if stderr { 3 } else { 2 };
	let name = if stderr { "open3" } else { "open2" };
	if args.len() <= handles {
		if stderr {
			let supplied = args.iter().map(|s| Ok(interp.read_sv(s)?.to_pstr().to_string_lossy().into_owned()))
				.collect::<PResult<Vec<_>>>()?.join(", ");
			return Err(interp.die_msg(format!("open3({supplied}): not enough arguments")));
		}
		interp.set_errno_code(libc::ENOENT);
		return Err(interp.die_msg("open2: exec of  failed: No such file or directory"));
	}
	#[cfg(any(unix, windows))]
	{
		// Open2 accepts output then input; Open3 accepts input then output.
		if !stderr { args.swap(0, 1); }
		let mut argv = Vec::with_capacity(args.len() - handles);
		for cell in &args[handles..] {
			let value = interp.read_sv(cell)?;
			argv.push(interp.stringify(&value)?.bytes);
		}
		interp.flush_outputs();
		start_pipes(interp, &args[..handles], &argv, name).map(|id| Ret::One(Value::Int(i64::from(id))))
	}
	#[cfg(not(any(unix, windows)))]
	{
		interp.set_errno_code(libc::ENOSYS);
		Err(interp.die_msg(format!("{name}: child pipes are not supported by this host")))
	}
}
