//! POSIX time, arithmetic, conversion, locale and process-status routines.

use std::{collections::HashSet, f64::consts};

use super::{calendar::{self, DAY, Fields}, hires, locale, posix_exports::{HEADERS, OPTIONAL_TAGGED, OPTIONAL_UNTAGGED}};
use crate::perl::{
	interp::{Cx, Flow, Interp, NativeFn, PResult, Ret},
	modules::{alias, arg, boolean, constant, define, export, export_tag, exporter, version},
	value::{HKey, PStr, Sv, Value, new_sv, parse_number},
};

const PKG: &str = "POSIX";
const TZNAMES: &str = "POSIX::_omp_tznames";
const TZSOURCE: &str = "POSIX::_omp_tzsource";
const NULL: &str = "NULL";

/// Install the supported POSIX functions and their header export tags.
pub(super) fn load(interp: &mut Interp<'_>) -> PResult<()> {
	version(interp, PKG, "1.97");
	let funcs: &[(&str, NativeFn)] = &[("asctime", asctime), ("ctime", ctime), ("clock", clock),
		("difftime", difftime), ("mktime", mktime), ("strftime", strftime), ("tzname", tzname), ("tzset", tzset),
		("_exit", exit), ("exit", exit), ("strtod", strtod), ("strtol", strtol), ("strtoul", strtoul),
		("localeconv", locale::localeconv), ("setlocale", locale::setlocale), ("strcoll", locale::strcoll), ("strxfrm", locale::strxfrm),
		("errno", errno), ("strerror", strerror), ("getenv", getenv), ("getcwd", getcwd), ("assert", assert),
		("getpid", getpid),
		#[cfg(unix)] ("uname", uname),
		#[cfg(unix)] ("getppid", getppid),
		#[cfg(unix)] ("getuid", getuid),
		#[cfg(unix)] ("geteuid", geteuid),
		#[cfg(unix)] ("getgid", getgid),
		#[cfg(unix)] ("getegid", getegid),
		("WEXITSTATUS", wexitstatus), ("WIFEXITED", wifexited), ("WIFSIGNALED", wifsignaled),
		("WIFSTOPPED", wifstopped), ("WTERMSIG", wtermsig), ("WSTOPSIG", wexitstatus)];
	define(interp, PKG, funcs);
	define(interp, PKG, MATH);
	for &(name, n) in INT { constant(interp, &format!("{PKG}::{name}"), Value::Int(n)); }
	for &(name, n) in FLOAT { constant(interp, &format!("{PKG}::{name}"), Value::Num(n)); }
	constant(interp, "POSIX::NULL", Value::Int(0));
	constant(interp, "POSIX::ULONG_MAX", Value::UInt(libc::c_ulong::MAX as u64));
	locale::constants(interp);
	platform_constants(interp);

	interp.require_module("Errno")?;
	interp.require_module("Fcntl")?;
	let mut defaults = Vec::new();
	let mut optional = Vec::new();
	let mut seen = HashSet::new();
	for &(tag, symbols) in HEADERS {
		// Realtime signal handler state needs a tied hash, not a scalar macro.
		let symbols: Vec<_> = symbols.split_ascii_whitespace().filter(|&name| name != "%SIGRT").collect();
		export_tag(interp, PKG, tag, &symbols);
		for name in symbols {
			if matches!(tag, "errno_h" | "fcntl_h" | "sys_stat_h") {
				let source = if tag == "errno_h" { "Errno" } else { "Fcntl" };
				let to = format!("{PKG}::{name}");
				let from = format!("{source}::{name}");
				if interp.glob(&to).code.borrow().is_none() && interp.glob(&from).code.borrow().is_some() {
					alias(interp, &from, &to, b'&');
				}
			}
			if seen.insert(name) {
				let exports = if OPTIONAL_TAGGED.binary_search(&name).is_ok() { &mut optional } else { &mut defaults };
				exports.push(name);
			}
		}
	}
	for name in OPTIONAL_UNTAGGED.iter().copied().chain(funcs.iter().map(|x| x.0))
		.chain(INT.iter().map(|x| x.0)).chain(MATH.iter().map(|x| x.0)).chain(FLOAT.iter().map(|x| x.0)).chain([NULL]) {
		if seen.insert(name) { optional.push(name); }
	}
	for &name in defaults.iter().chain(&optional) {
		let qualified = format!("{PKG}::{name}");
		if interp.glob(&qualified).code.borrow().is_none() {
			if name.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_') {
				interp.define_native_proto(&qualified, missing_macro, "");
			} else { interp.define_native(&qualified, unsupported); }
		}
	}
	export(interp, PKG, &defaults, &optional);
	interp.define_native("POSIX::import", import);
	Ok(())
}

fn import(interp: &mut Interp<'_>, mut args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	for sv in args.iter_mut().skip(1) {
		let spec = interp.read_sv(sv)?.to_pstr();
		let spec = spec.to_string_lossy();
		let (prefix, tag) = spec.strip_prefix('!').map_or(("", spec.as_ref()), |tag| ("!", tag));
		if HEADERS.iter().any(|&(name, _)| tag == name) {
			*sv = new_sv(Value::str(&format!("{prefix}:{tag}")));
		}
	}
	exporter::import(interp, args, cx)
}

fn missing_macro(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let qualified = interp.current_sub_name();
	let name = qualified.as_deref().and_then(|s| s.rsplit("::").next()).unwrap_or_default();
	Err(interp.die_msg(format!("Your vendor has not defined POSIX macro {name}, used")))
}
fn unsupported(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let name = interp.current_sub_name();
	let name = name.as_deref().and_then(|s| s.rsplit("::").next()).unwrap_or_default();
	Err(interp.die_msg(format!("Unimplemented: POSIX::{name}()")))
}

fn platform_constants(interp: &mut Interp<'_>) {
	#[cfg(unix)]
	{
		macro_rules! native { ($($name:ident)*) => { $(
			constant(interp, concat!("POSIX::", stringify!($name)), Value::Int(libc::$name as i64));
		)* }; }
		native!(STDIN_FILENO STDOUT_FILENO STDERR_FILENO
			SIGABRT SIGALRM SIGBUS SIGCHLD SIGCONT SIGFPE SIGHUP SIGILL SIGINT SIGKILL SIGPIPE SIGPROF SIGQUIT SIGSEGV
			SIGSTOP SIGSYS SIGTERM SIGTRAP SIGTSTP SIGTTIN SIGTTOU SIGURG SIGUSR1 SIGUSR2 SIGVTALRM SIGXCPU SIGXFSZ
			SIG_BLOCK SIG_DFL SIG_ERR SIG_IGN SIG_SETMASK SIG_UNBLOCK
			SA_NOCLDSTOP SA_NOCLDWAIT SA_NODEFER SA_ONSTACK SA_RESETHAND SA_RESTART SA_SIGINFO
			PRIO_PROCESS PRIO_PGRP PRIO_USER MSG_CTRUNC MSG_DONTROUTE MSG_EOR MSG_OOB MSG_PEEK MSG_TRUNC MSG_WAITALL
			EAI_AGAIN EAI_BADFLAGS EAI_FAIL EAI_FAMILY EAI_MEMORY EAI_NONAME EAI_OVERFLOW EAI_SERVICE EAI_SOCKTYPE EAI_SYSTEM
			B0 B110 B1200 B134 B150 B1800 B19200 B200 B2400 B300 B38400 B4800 B50 B600 B75 B9600
			BRKINT CLOCAL CREAD CS5 CS6 CS7 CS8 CSIZE CSTOPB ECHO ECHOE ECHOK ECHONL HUPCL ICANON ICRNL IEXTEN IGNBRK
			IGNCR IGNPAR INLCR INPCK ISIG ISTRIP IXOFF IXON NCCS NOFLSH OPOST PARENB PARMRK PARODD TCIFLUSH TCIOFF
			TCIOFLUSH TCION TCOFLUSH TCOOFF TCOON TCSADRAIN TCSAFLUSH TCSANOW TOSTOP VEOF VEOL VERASE VINTR VKILL
			VMIN VQUIT VSTART VSTOP VSUSP VTIME);
	}
	#[cfg(not(unix))]
	let _ = interp;
}

const INT: &[(&str, i64)] = &[
	("CLOCKS_PER_SEC", 1_000_000), ("CLK_TCK", 100), ("EXIT_SUCCESS", 0), ("EXIT_FAILURE", 1),
	("WNOHANG", 1), ("WUNTRACED", 2), ("SEEK_SET", 0), ("SEEK_CUR", 1), ("SEEK_END", 2),
	("EOF", -1), ("F_OK", 0), ("R_OK", 4), ("W_OK", 2), ("X_OK", 1),
	("CHAR_BIT", 8), ("CHAR_MAX", libc::c_char::MAX as i64), ("CHAR_MIN", libc::c_char::MIN as i64),
	("SCHAR_MAX", i8::MAX as i64), ("SCHAR_MIN", i8::MIN as i64), ("UCHAR_MAX", u8::MAX as i64),
	("SHRT_MAX", i16::MAX as i64), ("SHRT_MIN", i16::MIN as i64), ("USHRT_MAX", u16::MAX as i64),
	("INT_MAX", i32::MAX as i64), ("INT_MIN", i32::MIN as i64), ("UINT_MAX", u32::MAX as i64),
	("LONG_MAX", libc::c_long::MAX as i64), ("LONG_MIN", libc::c_long::MIN as i64), ("INT8_MAX", i8::MAX as i64),
	("SSIZE_MAX", isize::MAX as i64), ("FLT_RADIX", f64::RADIX as i64), ("FLT_ROUNDS", 1),
	("FLT_DIG", f32::DIGITS as i64), ("DBL_DIG", f64::DIGITS as i64),
	("FLT_MANT_DIG", f32::MANTISSA_DIGITS as i64), ("DBL_MANT_DIG", f64::MANTISSA_DIGITS as i64),
	("FLT_MIN_EXP", f32::MIN_EXP as i64), ("DBL_MIN_EXP", f64::MIN_EXP as i64),
	("FLT_MAX_EXP", f32::MAX_EXP as i64), ("DBL_MAX_EXP", f64::MAX_EXP as i64),
	("FLT_MIN_10_EXP", f32::MIN_10_EXP as i64), ("DBL_MIN_10_EXP", f64::MIN_10_EXP as i64),
	("FLT_MAX_10_EXP", f32::MAX_10_EXP as i64), ("DBL_MAX_10_EXP", f64::MAX_10_EXP as i64),
	("FP_NAN", if cfg!(target_os = "macos") { 1 } else { 0 }),
	("FP_INFINITE", if cfg!(target_os = "macos") { 2 } else { 1 }),
	("FP_ZERO", if cfg!(target_os = "macos") { 3 } else { 2 }),
	("FP_SUBNORMAL", if cfg!(target_os = "macos") { 5 } else { 3 }),
	("FP_NORMAL", 4),
	("FP_ILOGB0", i32::MIN as i64), ("FP_ILOGBNAN", i32::MIN as i64),
];
const FLOAT: &[(&str, f64)] = &[
	("M_PI", consts::PI), ("M_PI_2", consts::FRAC_PI_2), ("M_PI_4", consts::FRAC_PI_4),
	("M_1_PI", consts::FRAC_1_PI), ("M_2_PI", consts::FRAC_2_PI), ("M_2_SQRTPI", consts::FRAC_2_SQRT_PI),
	("M_E", consts::E), ("M_LN2", consts::LN_2), ("M_LN10", consts::LN_10),
	("M_LOG2E", consts::LOG2_E), ("M_LOG10E", consts::LOG10_E), ("M_SQRT2", consts::SQRT_2),
	("M_SQRT1_2", consts::FRAC_1_SQRT_2), ("DBL_MAX", f64::MAX), ("DBL_MIN", f64::MIN_POSITIVE),
	("DBL_EPSILON", f64::EPSILON), ("FLT_MAX", f32::MAX as f64), ("FLT_MIN", f32::MIN_POSITIVE as f64),
	("FLT_EPSILON", f32::EPSILON as f64), ("HUGE_VAL", f64::INFINITY), ("INFINITY", f64::INFINITY),
	("Inf", f64::INFINITY), ("NAN", f64::NAN), ("NaN", f64::NAN),
];

fn usage(interp: &mut Interp<'_>, name: &str, sig: &str) -> Flow { interp.die_msg(format!("Usage: POSIX::{name}({sig})")) }
fn one(v: Value) -> PResult<Ret> { Ok(Ret::One(v)) }

fn calendar_args(interp: &mut Interp<'_>, a: &[Sv], default: i64) -> PResult<Fields> {
	let mut values = [default; 9];
	values[8] = -1;
	for (value, sv) in values.iter_mut().zip(a) { *value = interp.read_sv(sv)?.to_i64(); }
	let [sec, min, hour, day, month, year, weekday, yearday, dst] = values;
	Ok(Fields { sec, min, hour, day, month, year: year.saturating_add(1900), weekday, yearday, dst })
}
fn strftime(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !(7..=10).contains(&a.len()) { return Err(usage(interp, "strftime", "fmt, sec, min, hour, mday, mon, year, wday = -1, yday = -1, isdst = -1")); }
	let original = calendar_args(interp, &a[1..], -1)?;
	let Some(naive) = original.epoch_naive() else { return one(Value::str("")); };
	let tz = calendar::timezone(interp);
	update_tzname(interp, &tz);
	let Some(epoch) = calendar::local_epoch_for_naive(&tz, naive, original.dst) else { return one(Value::str("")); };
	let Some(civil) = calendar::zoned(naive, jiff::tz::TimeZone::UTC) else { return one(Value::str("")); };
	let Some(z) = calendar::zoned(epoch, tz.clone()) else { return one(Value::str("")); };
	let info = tz.to_offset_info(z.timestamp());
	let mut fields = Fields::from_zoned(&civil);
	let offset = if original.dst < 0 { None } else { i32::try_from(naive - epoch).ok() };
	fields.dst = original.dst;
	let abbr = if original.dst < 0 || info.dst().is_dst() == (original.dst > 0) { info.abbreviation() }
	else if let Some(other) = calendar::zoned(naive - i64::from(info.offset().seconds()), tz.clone()) {
		return one(Value::Str(calendar::strftime(&arg(&a, 0).to_pstr(), &fields, epoch,
			tz.to_offset_info(other.timestamp()).abbreviation(), offset)));
	} else { info.abbreviation() };
	one(Value::Str(calendar::strftime(&arg(&a, 0).to_pstr(), &fields, epoch, abbr, offset)))
}
fn asctime(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !(6..=9).contains(&a.len()) { return Err(usage(interp, "asctime", "sec, min, hour, mday, mon, year, wday = 0, yday = 0, isdst = -1")); }
	let zone = calendar::timezone(interp);
	update_tzname(interp, &zone);
	one(Value::str(&format!("{}\n", calendar_args(interp, &a, 0)?.ctime())))
}
fn ctime(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if a.len() != 1 { return Err(usage(interp, "ctime", "time")); }
	let zone = calendar::timezone(interp);
	update_tzname(interp, &zone);
	one(calendar::zoned(arg(&a, 0).to_i64(), zone).map_or(Value::Undef, |z| Value::str(&Fields::from_zoned(&z).ctime())))
}
fn mktime(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !(6..=9).contains(&a.len()) { return Err(usage(interp, "mktime", "sec, min, hour, mday, mon, year, wday = 0, yday = 0, isdst = -1")); }
	let fields = calendar_args(interp, &a, 0)?;
	let tz = calendar::timezone(interp);
	update_tzname(interp, &tz);
	one(match fields.epoch_naive().and_then(|n| calendar::local_epoch_for_naive(&tz, n, fields.dst)) {
		None | Some(-1) => Value::Undef,
		Some(0) => Value::str("0 but true"),
		Some(n) => Value::Int(n),
	})
}
fn tzset(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(usage(interp, "tzset", "")); }
	let zone = calendar::timezone(interp);
	update_tzname(interp, &zone);
	one(Value::Undef)
}
fn tzname(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(usage(interp, "tzname", "")); }
	let cached = interp.av(TZNAMES);
	let names = cached.elems();
	let name = |n| names.get(n).map_or_else(|| Value::str("   "), |s: &Sv| s.get());
	if cx == Cx::List { Ok(Ret::Many(vec![name(0), name(1)])) }
	else { one(name(1)) }
}

fn update_tzname(interp: &mut Interp<'_>, tz: &jiff::tz::TimeZone) {
	let current = interp.hv("main::ENV").entries().get(&*calendar::TZ).map_or_else(PStr::default, |s| s.get().to_pstr());
	let marker = interp.sv(TZSOURCE);
	let cached = interp.av(TZNAMES);
	if matches!(marker.get(), Value::Str(p) if p == current) && !cached.elems().is_empty() { return; }
	marker.set(Value::Str(current));
	let now = calendar::now_epoch();
	let mut names = [None, None];
	for delta in [0, -90 * DAY, 90 * DAY, -180 * DAY, 180 * DAY] {
		if let Ok(t) = jiff::Timestamp::from_second(now + delta) {
			let info = tz.to_offset_info(t);
			names[usize::from(info.dst().is_dst())].get_or_insert_with(|| Value::str(info.abbreviation()));
		}
		if names.iter().all(Option::is_some) { break; }
	}
	cached.replace_elems(names.into_iter().map(|name| new_sv(name.unwrap_or_else(|| Value::str("   ")))).collect());
}
fn clock(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int((hires::cpu_seconds() * 1e6) as i64)) }
fn exit(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Err(Flow::Exit(arg(&a, 0).to_i64() as i32)) }
fn getpid(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(usage(interp, "getpid", "")); }
	one(Value::Int(i64::from(std::process::id())))
}
/// Same value as the core `getppid`: the shell is the script's logical parent.
#[cfg(unix)]
fn getppid(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(usage(interp, "getppid", "")); }
	one(Value::Int(crate::perl::func::sys::logical_ppid(interp)))
}
#[cfg(unix)]
macro_rules! process_id {
	($name:ident) => {
		fn $name(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
			if !a.is_empty() { return Err(usage(interp, stringify!($name), "")); }
			one(Value::Int(i64::from(rustix::process::$name().as_raw())))
		}
	};
}
#[cfg(unix)] process_id!(getuid);
#[cfg(unix)] process_id!(geteuid);
#[cfg(unix)] process_id!(getgid);
#[cfg(unix)] process_id!(getegid);
fn wexitstatus(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int((arg(&a, 0).to_i64() >> 8) & 255)) }
fn wifexited(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(arg(&a, 0).to_i64() & 127 == 0)) }
fn wifsignaled(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(matches!(arg(&a, 0).to_i64() & 127, 1..=126))) }
fn wifstopped(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(arg(&a, 0).to_i64() & 255 == 127)) }
fn wtermsig(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int(arg(&a, 0).to_i64() & 127)) }

fn errno(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(usage(interp, "errno", "")); }
	one(Value::Int(interp.sv("main::!").get().to_i64()))
}
fn strerror(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if a.len() != 1 { return Err(usage(interp, "strerror", "errno")); }
	let code = interp.read_sv(&a[0])?.to_i64() as i32;
	let text = std::io::Error::from_raw_os_error(code).to_string();
	one(Value::str(text.rsplit_once(" (os error ").map_or(text.as_str(), |(message, _)| message)))
}
fn assert(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if a.len() != 1 { return Err(usage(interp, "assert", "expr")); }
	if !interp.read_sv(&a[0])?.truthy() { return Err(interp.die_msg("Assertion failed")); }
	one(Value::Undef)
}
fn getenv(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if a.len() != 1 { return Err(usage(interp, "getenv", "name")); }
	let key = HKey::new(&interp.read_sv(&a[0])?.to_pstr());
	one(interp.hv("main::ENV").entries().get(&key).map_or(Value::Undef, |sv| sv.get()))
}
fn getcwd(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(usage(interp, "getcwd", "")); }
	one(Value::bytes(interp.resolve_path(b".").as_os_str().as_encoded_bytes()))
}
#[cfg(unix)]
fn uname(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(usage(interp, "uname", "")); }
	let name = rustix::system::uname();
	if cx != Cx::List { return one(Value::bytes(name.machine().to_bytes())); }
	Ok(Ret::Many([name.sysname(), name.nodename(), name.release(), name.version(), name.machine()]
		.into_iter().map(|part| Value::bytes(part.to_bytes())).collect()))
}

fn number_ret(v: Value, rest: usize, cx: Cx) -> PResult<Ret> {
	if cx == Cx::List { Ok(Ret::Many(vec![v, Value::Int(rest as i64)])) } else { one(v) }
}
fn strtod(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if a.len() != 1 { return Err(usage(interp, "strtod", "str")); }
	let s = arg(&a, 0).to_pstr();
	let input = s.bytes.split(|&b| b == 0).next().unwrap_or_default();
	let (v, n) = if let Some(parsed) = parse_hex_double(input) { parsed }
	else {
		let trimmed = input.trim_ascii_start();
		let decimal = if trimmed.starts_with(b"0 but true") { &input[..input.len() - trimmed.len() + 1] } else { input };
		let (v, n) = parse_number(decimal);
		(v.to_f64(), n)
	};
	if v.is_infinite() && input.iter().all(|b| !matches!(b, b'i' | b'I')) { interp.set_errno_code(libc::ERANGE); }
	number_ret(Value::Num(v), input.len().saturating_sub(n), cx)
}
fn parse_hex_double(s: &[u8]) -> Option<(f64, usize)> {
	let tail = s.trim_ascii_start();
	let start = s.len() - tail.len();
	let negative = tail.first() == Some(&b'-');
	let sign = usize::from(matches!(tail.first(), Some(b'+' | b'-')));
	let mantissa = tail.get(sign..)?;
	let mantissa = mantissa.strip_prefix(b"0x").or_else(|| mantissa.strip_prefix(b"0X"))?;
	let mut i = 0;
	let mut significant = 0;
	let mut exponent = 0i32;
	let mut n = 0.0;
	let mut after_point = false;
	let mut digits = 0;
	while let Some(&d) = mantissa.get(i) {
		if d == b'.' && !after_point { after_point = true; i += 1; continue; }
		let Some(d) = char::from(d).to_digit(16) else { break; };
		digits += 1;
		i += 1;
		if significant < 16 {
			n = n * 16.0 + f64::from(d);
			if n > 0.0 { significant += 1; }
			if after_point { exponent = exponent.saturating_sub(4); }
		} else if !after_point { exponent = exponent.saturating_add(4); }
	}
	if digits == 0 { return None; }
	if matches!(mantissa.get(i), Some(b'p' | b'P')) {
		let extra = &mantissa[i + 1..];
		let negative = extra.first() == Some(&b'-');
		let j = usize::from(matches!(extra.first(), Some(b'-' | b'+')));
		let mut k = j;
		let mut additional = 0i32;
		while let Some(&d) = extra.get(k).filter(|d| d.is_ascii_digit()) {
			k += 1;
			additional = additional.saturating_mul(10).saturating_add(i32::from(d - b'0'));
		}
		if k != j {
			i += 1 + k;
			exponent = exponent.saturating_add(if negative { -additional } else { additional });
		}
	}
	let scaled = if n == 0.0 { n }
	else if exponent < -1022 { (n * f64::MIN_POSITIVE) * 2.0_f64.powi(exponent + 1022) }
	else { n * 2.0_f64.powi(exponent) };
	Some((if negative { -scaled } else { scaled }, start + sign + 2 + i))
}

fn int_conversion(interp: &mut Interp<'_>, a: &[Sv], cx: Cx, signed: bool) -> PResult<Ret> {
	if !(1..=2).contains(&a.len()) { return Err(usage(interp, if signed { "strtol" } else { "strtoul" }, "str, base = 0")); }
	let mut radix = arg(a, 1).to_i64() as u32;
	if radix != 0 && !(2..=36).contains(&radix) { interp.set_errno_code(libc::EINVAL); return number_ret(Value::Int(0), 0, cx); }
	let s = arg(a, 0).to_pstr();
	let input = s.bytes.split(|&b| b == 0).next().unwrap_or_default();
	let mut i = input.iter().take_while(|b| b.is_ascii_whitespace()).count();
	let negative = input.get(i) == Some(&b'-');
	i += usize::from(matches!(input.get(i), Some(b'+' | b'-')));
	if matches!(radix, 0 | 16) && input.get(i) == Some(&b'0') && matches!(input.get(i + 1), Some(b'x' | b'X')) && input.get(i + 2).is_some_and(u8::is_ascii_hexdigit) {
		radix = 16;
		i += 2;
	}
	if radix == 0 { radix = if input.get(i) == Some(&b'0') { 8 } else { 10 }; }
	let first = i;
	let limit = if !signed { u64::MAX } else if negative { 1_u64 << 63 } else { i64::MAX as u64 };
	let mut n: u64 = 0;
	let mut overflow = false;
	while let Some(digit) = input.get(i).and_then(|b| char::from(*b).to_digit(radix)) {
		i += 1;
		if let Some(value) = n.checked_mul(radix.into()).and_then(|n| n.checked_add(digit.into())).filter(|&x| x <= limit) { n = value; }
		else { n = limit; overflow = true; }
	}
	if overflow { interp.set_errno_code(libc::ERANGE); }
	if negative && (signed || !overflow) { n = n.wrapping_neg(); }
	let value = if signed || n <= i64::MAX as u64 { Value::Int(n as i64) } else { Value::UInt(n) };
	let rest = if first == i { input.len() } else { input.len() - i };
	number_ret(value, rest, cx)
}
fn strtol(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { int_conversion(interp, &a, cx, true) }
fn strtoul(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { int_conversion(interp, &a, cx, false) }

macro_rules! math1 {
	($name:ident, $method:ident) => { math1!($name, |x: f64| x.$method(), Value::Num); };
	($name:ident, $op:expr, $ret:expr) => {
		fn $name(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
			if a.len() != 1 { return Err(usage(i, stringify!($name), "x")); }
			one($ret(($op)(arg(&a, 0).to_f64())))
		}
	};
}
macro_rules! math2 {
	($name:ident, $method:ident) => { math2!($name, |x: f64, y| x.$method(y), Value::Num); };
	($name:ident, $op:expr, $ret:expr) => {
		fn $name(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
			if a.len() != 2 { return Err(usage(i, stringify!($name), "x, y")); }
			one($ret(($op)(arg(&a, 0).to_f64(), arg(&a, 1).to_f64())))
		}
	};
}
math1!(floor, floor); math1!(ceil, ceil); math1!(fabs, abs); math1!(trunc, trunc); math1!(round, round);
math1!(lrint, |x: f64| x.round_ties_even() as i64, Value::Int); math1!(lround, |x: f64| x.round() as i64, Value::Int);
math1!(rint, round_ties_even); math1!(nearbyint, round_ties_even);
math1!(acos, acos); math1!(asin, asin); math1!(atan, atan); math1!(acosh, acosh); math1!(asinh, asinh); math1!(atanh, atanh);
math1!(sin, sin); math1!(cos, cos); math1!(exp, exp); math1!(log, ln); math1!(sqrt, sqrt);
math2!(atan2, atan2);
math1!(cosh, cosh); math1!(sinh, sinh); math1!(tan, tan); math1!(tanh, tanh); math1!(cbrt, cbrt);
math1!(exp2, exp2); math1!(expm1, exp_m1); math1!(log10, log10); math1!(log2, log2); math1!(log1p, ln_1p);
math1!(isfinite, |x: f64| i64::from(x.is_finite()), Value::Int); math1!(isinf, |x: f64| i64::from(x.is_infinite()), Value::Int);
math1!(isnan, |x: f64| i64::from(x.is_nan()), Value::Int); math1!(isnormal, |x: f64| i64::from(x.is_normal()), Value::Int);
math1!(signbit, |x: f64| i64::from(x.is_sign_negative()), Value::Int);
math1!(ilogb, exponent, Value::Int); math1!(logb, |x: f64| if x.is_nan() { x } else if x.is_infinite() { f64::INFINITY } else if x == 0.0 { f64::NEG_INFINITY } else { exponent(x) as f64 }, Value::Num);
math2!(copysign, copysign); math2!(fmax, max); math2!(fmin, min); math2!(hypot, hypot); math2!(pow, powf);
math2!(nextafter, toward, Value::Num); math2!(nexttoward, toward, Value::Num);
fn toward(x: f64, y: f64) -> f64 {
	if x.is_nan() || y.is_nan() { x + y } else if x == y { y }
	else if x < y { x.next_up() } else { x.next_down() }
}
math2!(fmod, |x, y| x % y, Value::Num); math2!(difftime, |x, y| x - y, Value::Num);
math2!(remainder, |x: f64, y: f64| if y.is_infinite() && x.is_finite() { x } else { x - (x / y).round_ties_even() * y }, Value::Num);
math2!(fdim, |x: f64, y: f64| if x.is_nan() || y.is_nan() { f64::NAN } else { (x - y).max(0.0) }, Value::Num);
math2!(ldexp, scale_pow2, Value::Num);
math2!(scalbn, scale_pow2, Value::Num);
fn scale_pow2(x: f64, exp: f64) -> f64 {
	if x == 0.0 || !x.is_finite() { return x; }
	let e = (exp as i32).clamp(-2200, 2200);
	let mut value = x;
	let mut left = e;
	while left > 1023 { value *= 2.0_f64.powi(1023); left -= 1023; }
	while left < -1022 { value *= f64::MIN_POSITIVE; left += 1022; }
	value * 2.0_f64.powi(left)
}
math2!(isgreater, |x, y| i64::from(x > y), Value::Int); math2!(isgreaterequal, |x, y| i64::from(x >= y), Value::Int);
math2!(isless, |x, y| i64::from(x < y), Value::Int); math2!(islessequal, |x, y| i64::from(x <= y), Value::Int);
math2!(islessgreater, |x: f64, y: f64| i64::from(!x.is_nan() && !y.is_nan() && x != y), Value::Int);
math2!(isunordered, |x: f64, y: f64| i64::from(x.is_nan() || y.is_nan()), Value::Int);
fn fpclassify(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	use std::num::FpCategory::*;
	if a.len() != 1 { return Err(usage(interp, "fpclassify", "x")); }
	let name = match arg(&a, 0).to_f64().classify() { Nan => "FP_NAN", Infinite => "FP_INFINITE", Zero => "FP_ZERO", Subnormal => "FP_SUBNORMAL", Normal => "FP_NORMAL" };
	one(Value::Int(INT.iter().find(|&&x| x.0 == name).map_or(0, |x| x.1)))
}
fn fma(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if a.len() != 3 { return Err(usage(interp, "fma", "x, y, z")); }
	one(Value::Num(arg(&a, 0).to_f64().mul_add(arg(&a, 1).to_f64(), arg(&a, 2).to_f64())))
}
fn nan(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Num(f64::NAN)) }
fn exponent(x: f64) -> i64 {
	let bits = x.abs().to_bits();
	let exp = ((bits >> 52) & 0x7ff) as i64;
	match exp { 0 if bits == 0 => i32::MIN.into(), 0 => -1011 - i64::from(bits.leading_zeros()),
		0x7ff if x.is_nan() => i32::MIN.into(), 0x7ff => i32::MAX.into(), _ => exp - 1023 }
}
fn modf(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if a.len() != 1 { return Err(usage(interp, "modf", "x")); }
	let x = arg(&a, 0).to_f64();
	let int = Value::Num(x.trunc());
	if cx != Cx::List { return one(int); }
	Ok(Ret::Many(vec![Value::Num(if x.is_infinite() { 0.0_f64.copysign(x) } else { x.fract() }), int]))
}
fn frexp(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if a.len() != 1 { return Err(usage(interp, "frexp", "x")); }
	let x = arg(&a, 0).to_f64();
	let (f, n) = if !x.is_finite() || x == 0.0 { (x, 0) } else {
		let n = exponent(x) + 1;
		let k = n.clamp(-1022, 1023);
		(x / 2.0_f64.powi(k as i32) / 2.0_f64.powi((n - k) as i32), n)
	};
	if cx == Cx::List { Ok(Ret::Many(vec![Value::Num(f), Value::Int(n)])) } else { one(Value::Int(n)) }
}

const MATH: &[(&str, NativeFn)] = &[
	("floor", floor), ("ceil", ceil), ("fabs", fabs), ("trunc", trunc), ("round", round),
	("rint", rint), ("lrint", lrint), ("lround", lround), ("nearbyint", nearbyint),
	("acos", acos), ("asin", asin), ("atan", atan), ("acosh", acosh), ("asinh", asinh), ("atanh", atanh),
	("sin", sin), ("cos", cos), ("exp", exp), ("log", log), ("sqrt", sqrt), ("atan2", atan2), ("abs", fabs),
	("cosh", cosh), ("sinh", sinh), ("tan", tan), ("tanh", tanh), ("cbrt", cbrt),
	("exp2", exp2), ("expm1", expm1), ("log10", log10), ("log2", log2), ("log1p", log1p),
	("isfinite", isfinite), ("isinf", isinf), ("isnan", isnan), ("isnormal", isnormal), ("signbit", signbit),
	("copysign", copysign), ("fmax", fmax), ("fmin", fmin), ("hypot", hypot), ("pow", pow),
	("fmod", fmod), ("remainder", remainder), ("fdim", fdim), ("ldexp", ldexp), ("scalbn", scalbn),
	("isgreater", isgreater), ("isgreaterequal", isgreaterequal), ("isless", isless), ("islessequal", islessequal),
	("islessgreater", islessgreater), ("isunordered", isunordered), ("fma", fma), ("nan", nan),
	("ilogb", ilogb), ("logb", logb), ("fpclassify", fpclassify), ("modf", modf), ("frexp", frexp),
	("nextafter", nextafter), ("nexttoward", nexttoward),
];
