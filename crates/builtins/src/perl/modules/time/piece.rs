//! Time::Piece and Time::Seconds objects, calendar arithmetic and overloading.

use std::rc::Rc;

use jiff::{Timestamp, fmt::strtime::BrokenDownTime, tz::TimeZone};

use super::calendar::{self, DAY, DAYS, Fields, MONTHS};
use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	modules::{alias, arg, constant, define, export, list, text, version},
	value::{PStr, Ref, Sv, Value, new_av, new_sv},
};

const PIECE: &str = "Time::Piece";
const SECONDS: &str = "Time::Seconds";
const CONSTANTS: &[(&str, i64)] = &[
	("ONE_MINUTE", 60), ("ONE_HOUR", 3600), ("ONE_DAY", DAY), ("ONE_WEEK", 604_800),
	("ONE_MONTH", 2_629_744), ("ONE_YEAR", 31_556_930), ("ONE_FINANCIAL_MONTH", 2_592_000),
	("LEAP_YEAR", 31_622_400), ("NON_LEAP_YEAR", 31_536_000),
];

/// Install the duration object and exported conversion constants.
pub(super) fn load_seconds(interp: &mut Interp<'_>) {
	version(interp, SECONDS, "1.3401");
	define(interp, SECONDS, &[("new", seconds_new), ("copy", seconds_copy), ("pretty", pretty),
		("seconds", seconds), ("minutes", minutes), ("hours", hours), ("days", days), ("weeks", weeks),
		("months", months), ("years", years), ("financial_months", financial_months), ("add", seconds_add),
		("subtract", seconds_subtract), ("compare", seconds_compare), ("add_to", add_to), ("subtract_from", subtract_from)]);
	interp.define_native_proto("Time::Seconds::cs_sec", cs_sec, "");
	interp.define_native_proto("Time::Seconds::cs_mon", cs_mon, "");
	for &(name, value) in CONSTANTS { constant(interp, &format!("{SECONDS}::{name}"), Value::Int(value)); }
	let defaults = CONSTANTS.iter().map(|x| x.0).collect::<Vec<_>>();
	export(interp, SECONDS, &defaults, &["cs_sec", "cs_mon"]);
	overloads(interp, SECONDS, &[("\"\"", "seconds"), ("0+", "seconds"), ("+", "add"), ("-", "subtract"),
		("+=", "add"), ("-=", "subtract"), ("<=>", "compare"), ("=", "copy")]);
}

/// Install calendar objects and configure their operators and exports.
pub(super) fn load_piece(interp: &mut Interp<'_>) -> PResult<()> {
	interp.require_module(SECONDS)?;
	interp.require_module("Time::Local")?;
	version(interp, PIECE, "1.3401");
	define(interp, PIECE, &[("new", piece_new), ("localtime", localtime), ("gmtime", gmtime),
		("strftime", strftime), ("strptime", strptime), ("parse", parse), ("add_months", add_months),
		("add_years", add_years), ("truncate", truncate), ("is_leap_year", leap), ("month_last_day", last_day),
		("add", piece_add), ("subtract", piece_subtract), ("compare", piece_compare), ("str_compare", piece_str_compare),
		("cdate", cdate), ("ymd", ymd), ("mdy", mdy), ("dmy", dmy), ("hms", hms), ("datetime", datetime),
		("year", year), ("yy", yy), ("mon", mon), ("day", wdayname), ("monname", monname), ("wdayname", wdayname),
		("fullmonth", fullmonth), ("fullday", fullday), ("day_list", day_list), ("mon_list", mon_list),
		("wday", wday), ("week", week), ("julian_day", julian_day), ("mjd", mjd), ("tzoffset", tzoffset),
		("get_epochs", get_epochs), ("time_separator", time_separator), ("date_separator", date_separator),
		("use_locale", use_locale), ("c_sec", sec), ("c_min", min), ("c_hour", hour), ("c_mday", mday),
		("c_mon", raw_mon), ("c_year", raw_year), ("c_wday", raw_wday), ("c_yday", yday), ("c_isdst", isdst),
		("c_epoch", c_epoch), ("c_islocal", c_islocal)]);
	for (as_name, name) in [("date", "ymd"), ("time", "hms"), ("epoch", "c_epoch"), ("sec", "c_sec"),
		("second", "c_sec"), ("min", "c_min"), ("minute", "c_min"), ("hour", "c_hour"), ("mday", "c_mday"),
		("month", "monname"), ("yday", "c_yday"), ("isdst", "c_isdst"), ("_mon", "c_mon"), ("_year", "c_year"),
		("_wday", "c_wday"), ("day_of_month", "c_mday"), ("day_of_week", "wday"), ("day_of_year", "c_yday"),
		("daylight_savings", "c_isdst")] {
		alias(interp, &format!("{PIECE}::{name}"), &format!("{PIECE}::{as_name}"), b'&');
	}
	for &(name, _) in CONSTANTS { alias(interp, &format!("{SECONDS}::{name}"), &format!("{PIECE}::{name}"), b'&'); }
	for name in ["timegm", "timelocal"] { alias(interp, &format!("Time::Local::{name}"), &format!("{PIECE}::{name}"), b'&'); }
	interp.sv(DATE_SEP).set(Value::str("-"));
	interp.sv(TIME_SEP).set(Value::str(":"));
	export(interp, PIECE, &["localtime", "gmtime"], &[]);
	interp.define_native("Time::Piece::import", piece_import);
	overloads(interp, PIECE, &[("\"\"", "cdate"), ("+", "add"), ("-", "subtract"), ("<=>", "compare"), ("cmp", "str_compare")]);
	Ok(())
}

fn overloads(interp: &mut Interp<'_>, pkg: &str, overloads: &[(&str, &str)]) {
	for &(op, name) in overloads {
		let cv = interp.glob(&format!("{pkg}::{name}")).code.borrow().clone();
		if let Some(cv) = cv { interp.set_overload(pkg, op, Value::Ref(Ref::Code(cv))); }
	}
	interp.set_overload(pkg, "fallback", Value::Int(1));
}
fn one(v: Value) -> PResult<Ret> { Ok(Ret::One(v)) }

fn piece_import(interp: &mut Interp<'_>, mut a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let mut override_at = None;
	for (idx, sv) in a.iter().enumerate().skip(1) {
		if interp.read_sv(sv)?.to_pstr().bytes == b":override" {
			override_at = Some(idx);
			break;
		}
	}
	if let Some(idx) = override_at {
		a.remove(idx);
		for name in ["localtime", "gmtime"] { alias(interp, &format!("{PIECE}::{name}"), &format!("CORE::GLOBAL::{name}"), b'&'); }
	}
	crate::perl::modules::exporter::import(interp, a, cx)
}

fn make_seconds(class: Rc<str>, n: Value) -> Value {
	let r = Ref::Scalar(new_sv(n));
	r.bless(class);
	Value::Ref(r)
}
fn seconds_arg(v: Value) -> (Value, Rc<str>) {
	if let Value::Ref(Ref::Scalar(s)) = &v && let Some(class) = s.blessed.borrow().clone() {
		return (s.get(), class);
	}
	(v, Rc::from(SECONDS))
}
fn secval(v: Value) -> Value { seconds_arg(v).0 }
fn seconds_new(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let c = arg(&a, 0);
	let class = if let Value::Ref(r) = c { r.blessed().unwrap_or_else(|| Rc::from(SECONDS)) }
	else if c.is_undef() { Rc::from(SECONDS) }
	else { Rc::from(c.to_pstr().to_string_lossy().as_ref()) };
	let val = arg(&a, 1);
	one(make_seconds(class, if val.is_undef() { Value::Int(0) } else { val }))
}
fn seconds_copy(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, class) = seconds_arg(arg(&a, 0));
	one(make_seconds(class, v))
}
fn seconds(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(secval(arg(&a, 0))) }
macro_rules! unit {
	($name:ident, $scale:expr) => {
		fn $name(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Num(secval(arg(&a, 0)).to_f64() / $scale)) }
	};
}
unit!(minutes, 60.0); unit!(hours, 3600.0); unit!(days, 86_400.0); unit!(weeks, 604_800.0);
unit!(months, 2_629_744.0); unit!(years, 31_556_930.0); unit!(financial_months, 2_592_000.0);
fn cs_sec(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int(0)) }
fn cs_mon(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int(1)) }
fn pretty(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let n = secval(arg(&a, 0)).to_f64();
	let mut left = n.abs() as u64;
	let mut result = String::new();
	if n < 0.0 { result.push_str("minus "); }
	let mut shown = false;
	for (label, scale) in [("day", 86400), ("hour", 3600), ("minute", 60), ("second", 1)] {
		let unit = left / scale;
		left %= scale;
		if unit > 0 || shown || scale == 1 {
			use std::fmt::Write;
			if shown { result.push_str(", "); }
			let _ = write!(result, "{unit} {label}{}", if unit == 1 { "" } else { "s" });
			shown = true;
		}
	}
	one(Value::str(&result))
}
fn seconds_op(interp: &mut Interp<'_>, a: &[Sv], subtract: bool, change: bool) -> PResult<Ret> {
	let first = arg(a, 0);
	let (lhs, class) = seconds_arg(first.clone());
	let rhs = secval(arg(a, 1));
	let swap = arg(a, 2).truthy();
	let (l, r) = if swap && subtract { (rhs, lhs) } else { (lhs, rhs) };
	let op = if subtract { crate::perl::ops::sub } else { crate::perl::ops::add };
	let out = op(l.to_num(), r.to_num()).into_value();
	if change && let Value::Ref(Ref::Scalar(s)) = first {
		interp.write_sv(&s, out)?;
		return one(Value::Ref(Ref::Scalar(s)));
	}
	one(make_seconds(class, out))
}
fn seconds_add(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { seconds_op(i, &a, false, false) }
fn seconds_subtract(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { seconds_op(i, &a, true, false) }
fn add_to(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { seconds_op(i, &a, false, true) }
fn subtract_from(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { seconds_op(i, &a, true, true) }
fn comparison(lhs: f64, rhs: f64, swap: bool) -> Value {
	lhs.partial_cmp(&rhs).map_or(Value::Undef, |c| Value::Int(i64::from(if swap { c.reverse() } else { c } as i8)))
}
fn seconds_compare(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	one(comparison(secval(arg(&a, 0)).to_f64(), secval(arg(&a, 1)).to_f64(), arg(&a, 2).truthy()))
}

fn obj_cell(a: &[Sv], idx: usize) -> Value { array_part(&arg(a, 0), idx) }
fn array_part(v: &Value, idx: usize) -> Value {
	if let Value::Ref(Ref::Array(arr)) = v { arg(&arr.elems(), idx) } else { Value::Undef }
}
fn piece_info(a: &[Sv]) -> (i64, bool) { (obj_cell(a, 9).to_i64(), obj_cell(a, 10).truthy()) }
fn piece_class(v: &Value) -> Rc<str> {
	if let Value::Ref(r) = v { return r.blessed().unwrap_or_else(|| Rc::from(PIECE)); }
	if v.is_undef() || v.to_pstr().is_empty() { Rc::from(PIECE) } else { Rc::from(v.to_pstr().to_string_lossy().as_ref()) }
}
fn piece_zone(interp: &mut Interp<'_>, local: bool) -> TimeZone { if local { calendar::timezone(interp) } else { TimeZone::UTC } }
fn make_piece(interp: &mut Interp<'_>, class: Rc<str>, epoch: i64, local: bool, list_context: bool) -> PResult<Ret> {
	let Some(z) = calendar::zoned(epoch, piece_zone(interp, local)) else {
		return if list_context { Ok(Ret::Many(Vec::new())) } else { one(Value::Undef) };
	};
	let mut values = Fields::from_zoned(&z).values();
	if list_context { return Ok(Ret::Many(values)); }
	values.extend([Value::Int(epoch), Value::Int(i64::from(local))]);
	let r = Ref::Array(new_av(values));
	r.bless(class);
	one(Value::Ref(r))
}
fn piece_new(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let invocant = arg(&a, 0);
	let date = arg(&a, 1);
	if matches!(invocant, Value::Ref(Ref::Array(_))) && date.is_undef() {
		let (epoch, local) = piece_info(&a);
		return make_piece(interp, piece_class(&invocant), epoch, local, false);
	}
	let (epoch, local) = if matches!(date, Value::Ref(Ref::Array(_))) {
		(array_part(&date, 9).to_i64(), array_part(&date, 10).truthy())
	} else { (if date.is_undef() { calendar::now_epoch() } else { date.to_i64() }, true) };
	make_piece(interp, piece_class(&invocant), epoch, local, false)
}
fn piece_time(interp: &mut Interp<'_>, a: &[Sv], cx: Cx, local: bool) -> PResult<Ret> {
	let mut t = arg(a, 0);
	let class = if matches!(&t, Value::Ref(Ref::Array(_))) || t.to_pstr().bytes == b"Time::Piece" {
		let class = piece_class(&t);
		t = arg(a, 1);
		class
	} else { Rc::from(PIECE) };
	let epoch = if t.is_undef() { calendar::now_epoch() } else { t.to_i64() };
	make_piece(interp, class, epoch, local, cx == Cx::List)
}
fn localtime(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { piece_time(interp, &a, cx, true) }
fn gmtime(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { piece_time(interp, &a, cx, false) }

macro_rules! field {
	($($name:ident => $i:literal),* $(,)?) => { $(fn $name(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(obj_cell(&a, $i)) })* };
}
field!(sec => 0, min => 1, hour => 2, mday => 3, raw_mon => 4, raw_year => 5, raw_wday => 6, yday => 7, isdst => 8, c_epoch => 9, c_islocal => 10);
fn numeric(a: &[Sv], idx: usize) -> i64 { obj_cell(a, idx).to_i64() }
fn year(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int(numeric(&a, 5).saturating_add(1900))) }
fn yy(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::str(&format!("{:02}", numeric(&a, 5).rem_euclid(100)))) }
fn mon(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int(numeric(&a, 4).saturating_add(1))) }
fn wday(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int(numeric(&a, 6).saturating_add(1))) }
fn leap(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int(i64::from(calendar::leap(numeric(&a, 5).saturating_add(1900))))) }
fn last_day(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Int(calendar::month_days(numeric(&a, 5).saturating_add(1900), numeric(&a, 4).saturating_add(1)))) }
fn julian_day(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Num(numeric(&a, 9) as f64 / DAY as f64 + 2_440_587.5)) }
fn mjd(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Num(numeric(&a, 9) as f64 / DAY as f64 + 40_587.0)) }

fn cdate(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (epoch, local) = piece_info(&a);
	one(calendar::zoned(epoch, piece_zone(interp, local)).map_or(Value::Undef, |z| Value::str(&Fields::from_zoned(&z).ctime())))
}
fn strftime(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (epoch, local) = piece_info(&a);
	let zone = piece_zone(interp, local);
	let Some(z) = calendar::zoned(epoch, zone.clone()) else { return one(Value::Undef); };
	let off = zone.to_offset_info(z.timestamp());
	let fmt = arg(&a, 1);
	let fmt = if fmt.is_undef() { PStr::from_bytes(b"%a, %d %b %Y %T %Z") } else { fmt.to_pstr() };
	one(Value::Str(calendar::strftime(&fmt, &Fields::from_zoned(&z), epoch, off.abbreviation(), Some(off.offset().seconds()))))
}
fn week(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (epoch, local) = piece_info(&a);
	one(calendar::zoned(epoch, piece_zone(interp, local)).map_or(Value::Undef, |z| Value::Int(i64::from(Fields::from_zoned(&z).week().1))))
}
fn tzoffset(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (epoch, local) = piece_info(&a);
	let zone = piece_zone(interp, local);
	let offset = Timestamp::from_second(epoch).map_or(0, |t| zone.to_offset(t).seconds());
	one(make_seconds(Rc::from(SECONDS), Value::Int(offset.into())))
}
fn get_epochs(_: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let l = numeric(&a, 9);
	let v = arg(&a, 1);
	let r = if matches!(v, Value::Ref(Ref::Array(_))) { array_part(&v, 9).to_i64() } else { v.to_i64() };
	if cx == Cx::List { Ok(Ret::Many(vec![Value::Int(l), Value::Int(r)])) } else { one(Value::Int(r)) }
}

const DATE_SEP: &str = "Time::Piece::_omp_date_separator";
const TIME_SEP: &str = "Time::Piece::_omp_time_separator";
fn separator(interp: &mut Interp<'_>, a: &[Sv], key: &str) -> PStr {
	let v = arg(a, 1);
	if v.is_undef() { interp.sv(key).get().to_pstr() } else { v.to_pstr() }
}
fn separator_method(interp: &mut Interp<'_>, a: &[Sv], key: &str) -> PResult<Ret> {
	let cell = interp.sv(key);
	if let Some(sv) = a.get(1) { cell.set(interp.read_sv(sv)?); }
	one(cell.get())
}
fn date_separator(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { separator_method(i, &a, DATE_SEP) }
fn time_separator(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { separator_method(i, &a, TIME_SEP) }
fn date_string(a: &[Sv], sep: &PStr, order: [usize; 3]) -> PStr {
	let values = [numeric(a, 5).saturating_add(1900), numeric(a, 4).saturating_add(1), numeric(a, 3)];
	let mut out = PStr::default();
	for (pos, idx) in order.into_iter().enumerate() {
		if pos != 0 { out.push(sep); }
		let width = if idx == 0 { 4 } else { 2 };
		out.push_bytes(format!("{:0width$}", values[idx]).as_bytes());
	}
	out
}
fn time_string(a: &[Sv], sep: &PStr) -> PStr {
	let mut out = PStr::default();
	for (i, field) in [2, 1, 0].into_iter().enumerate() {
		if i != 0 { out.push(sep); }
		out.push_bytes(format!("{:02}", numeric(a, field)).as_bytes());
	}
	out
}
fn ymd(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Str(date_string(&a, &separator(i, &a, DATE_SEP), [0, 1, 2]))) }
fn mdy(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Str(date_string(&a, &separator(i, &a, DATE_SEP), [1, 2, 0]))) }
fn dmy(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Str(date_string(&a, &separator(i, &a, DATE_SEP), [2, 1, 0]))) }
fn hms(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::Str(time_string(&a, &separator(i, &a, TIME_SEP)))) }
fn datetime(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut out = date_string(&a, &PStr::from_bytes(b"-"), [0, 1, 2]);
	out.push_bytes(b"T");
	out.push(&time_string(&a, &PStr::from_bytes(b":")));
	one(Value::Str(out))
}
const WEEKDAYS: &str = "Time::Piece::_omp_weekdays";
const MONTH_NAMES: &str = "Time::Piece::_omp_months";
fn date_names(i: &mut Interp<'_>, a: &[Sv], cx: Cx, key: &str, defaults: &[&str]) -> PResult<Ret> {
	let av = i.av(key);
	if a.len() > 1 {
		let names = a[1..].iter().map(|sv| i.read_sv(sv).map(new_sv)).collect::<PResult<Vec<_>>>()?;
		av.replace_elems(names);
	}
	let names = av.elems();
	let values = if names.is_empty() { defaults.iter().map(|name| Value::str(calendar::short(name))).collect() }
	else { names.iter().map(|v| v.get()).collect() };
	Ok(list(values, cx))
}
fn day_list(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { date_names(i, &a, cx, WEEKDAYS, &DAYS) }
fn mon_list(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { date_names(i, &a, cx, MONTH_NAMES, &MONTHS) }
fn short_name(i: &mut Interp<'_>, a: &[Sv], key: &str, names: &'static [&str], idx: usize) -> Value {
	let index = numeric(a, idx);
	let av = i.av(key);
	let values = av.elems();
	if !values.is_empty() { arg(&values, index as usize) }
	else { Value::str(calendar::short(calendar::name(names, index))) }
}
fn wdayname(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(short_name(i, &a, WEEKDAYS, &DAYS, 6)) }
fn monname(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(short_name(i, &a, MONTH_NAMES, &MONTHS, 4)) }
fn fullday(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::str(calendar::name(&DAYS, numeric(&a, 6)))) }
fn fullmonth(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { one(Value::str(calendar::name(&MONTHS, numeric(&a, 4)))) }
fn use_locale(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	// The calendar formatter has one locale, the C locale.
	interp.av(WEEKDAYS).elems_mut().clear();
	interp.av(MONTH_NAMES).elems_mut().clear();
	one(Value::Int(1))
}

fn piece_op(interp: &mut Interp<'_>, a: &[Sv], subtract: bool) -> PResult<Ret> {
	let (left, local) = piece_info(a);
	let rhs = arg(a, 1);
	if matches!(rhs, Value::Ref(Ref::Array(_))) {
		if !subtract { return Err(interp.die_msg("Cannot add two Time::Piece objects")); }
		let right = array_part(&rhs, 9).to_i64();
		return one(make_seconds(Rc::from(SECONDS), Value::Int(left.saturating_sub(right))));
	}
	let right = secval(rhs).to_i64();
	let epoch = if subtract && arg(a, 2).truthy() { right.saturating_sub(left) }
	else if subtract { left.saturating_sub(right) } else { left.saturating_add(right) };
	make_piece(interp, piece_class(&arg(a, 0)), epoch, local, false)
}
fn piece_add(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { piece_op(i, &a, false) }
fn piece_subtract(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { piece_op(i, &a, true) }
fn piece_compare(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let r = arg(&a, 1);
	let rhs = if matches!(r, Value::Ref(Ref::Array(_))) { array_part(&r, 9).to_f64() } else { r.to_f64() };
	one(comparison(numeric(&a, 9) as f64, rhs, arg(&a, 2).truthy()))
}
fn piece_str_compare(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let right = arg(&a, 1);
	if matches!(right, Value::Ref(Ref::Array(_))) { return piece_compare(interp, a, Cx::Scalar); }
	let right = interp.stringify(&right)?;
	let invert = arg(&a, 2).truthy();
	let left = cdate(interp, a, Cx::Scalar)?.scalar().to_pstr();
	let order = left.cmp(&right);
	one(Value::Int(i64::from(if invert { order.reverse() } else { order } as i8)))
}
fn recreate(interp: &mut Interp<'_>, a: &[Sv], fields: [i64; 6]) -> PResult<Ret> {
	let (_, local) = piece_info(a);
	let epoch = calendar::naive_epoch(fields).and_then(|t| if local { calendar::local_epoch_for_naive(&calendar::timezone(interp), t, -1) } else { Some(t) });
	let Some(epoch) = epoch else { return Err(interp.die_msg("Day too big")); };
	make_piece(interp, piece_class(&arg(a, 0)), epoch, local, false)
}
fn add_months(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { add_calendar(interp, a, 1) }
fn add_years(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { add_calendar(interp, a, 12) }
fn add_calendar(interp: &mut Interp<'_>, a: Vec<Sv>, scale: i64) -> PResult<Ret> {
	let mut fields: [i64; 6] = std::array::from_fn(|i| numeric(&a, i));
	fields[4] = fields[4].saturating_add(arg(&a, 1).to_i64().saturating_mul(scale));
	fields[5] = fields[5].saturating_add(1900);
	recreate(interp, &a, fields)
}
fn truncate(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if a.len() < 3 { return one(arg(&a, 0)); }
	let to = text(&a, 2);
	let precision = match to.as_str() { "second" => 0, "minute" => 1, "hour" => 2, "day" => 3, "month" => 4, "year" => 5,
		_ => return Err(interp.die_msg(format!("Invalid value of 'to' parameter: {to}"))) };
	let fields = std::array::from_fn(|i| if i == 5 { numeric(&a, i).saturating_add(1900) } else if i < precision { i64::from(i == 3) } else { numeric(&a, i) });
	recreate(interp, &a, fields)
}

fn strptime(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let invocant = arg(&a, 0);
	let input = arg(&a, 1).to_pstr();
	let fmt = arg(&a, 2);
	let error = |i: &mut Interp<'_>| i.die_msg("Error parsing time");
	if a.len() < 3 && !input.is_empty() { return Err(error(interp)); }
	let fmt = fmt.to_pstr();
	let (mut parsed, used) = parse_clock(&fmt.bytes, &input.bytes).ok_or_else(|| error(interp))?;
	if let Some(extra) = input.bytes.get(used..) && !extra.iter().all(u8::is_ascii_whitespace) {
		interp.warn(format!("Garbage at end of string in strptime: {}", String::from_utf8_lossy(extra)));
		interp.warn("Perhaps a format flag did not match the actual input?");
	}
	let local = array_part(&invocant, 10).truthy();
	let zone = piece_zone(interp, local);
	let epoch = if let Some(t) = parsed.timestamp() { t.as_second() } else {
		let mut fields = [i64::from(parsed.second().unwrap_or(0)), i64::from(parsed.minute().unwrap_or(0)),
			i64::from(parsed.hour().unwrap_or(0)), i64::from(parsed.day().unwrap_or(1)),
			i64::from(parsed.month().unwrap_or(1)) - 1, i64::from(parsed.year().unwrap_or(1970))];
		if let Some(n) = parsed.day_of_year() && parsed.month().is_none() { fields[3] = i64::from(n); }
		if parsed.meridiem().is_some() {
			if parsed.minute().is_none() { let _ = parsed.set_minute(Some(0)); }
			if parsed.second().is_none() { let _ = parsed.set_second(Some(0)); }
			if let Ok(time) = parsed.to_time() { fields[2] = i64::from(time.hour()); }
		}
		let offset = parsed.offset();
		let named = parsed.iana_time_zone().and_then(|name| TimeZone::get(name).ok());
		let iso_date = if parsed.iso_week().is_some() && parsed.iso_week_year().is_some() && let Ok(date) = parsed.to_date() { Some(date) } else { None };
		if let Some(date) = iso_date { fields[5] = date.year().into(); fields[4] = i64::from(date.month()) - 1; fields[3] = date.day().into(); }
		let naive = calendar::naive_epoch(fields).ok_or_else(|| error(interp))?;
		if let Some(offset) = offset { naive.checked_sub(i64::from(offset.seconds())).ok_or_else(|| error(interp))? }
		else if local || named.is_some() { calendar::local_epoch_for_naive(named.as_ref().unwrap_or(&zone), naive, -1).ok_or_else(|| error(interp))? }
		else { naive }
	};
	make_piece(interp, piece_class(&invocant), epoch, local, false)
}
fn parse_clock(fmt: &[u8], input: &[u8]) -> Option<(BrokenDownTime, usize)> {
	if let Ok(result) = BrokenDownTime::parse_prefix(fmt, input) { return Some(result); }
	// C strptime accepts the GMT abbreviation; Jiff's parser requires a zone
	// identifier or a numeric offset instead of a free-form abbreviation.
	let base = fmt.strip_suffix(b"%Z")?;
	let (mut parsed, used) = BrokenDownTime::parse_prefix(base, input).ok()?;
	let tail = input.get(used..)?;
	let spaces = tail.iter().take_while(|b| b.is_ascii_whitespace()).count();
	let tail = &tail[spaces..];
	if !tail.starts_with(b"GMT") { return None; }
	parsed.set_offset(Some(jiff::tz::Offset::UTC));
	Some((parsed, used + spaces + 3))
}

fn parse(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	interp.warn("parse() is deprecated, use strptime() instead.");
	let local = arg(&a, 7).truthy();
	let fields = &a[1.min(a.len())..];
	let ret = super::local_epoch(interp, fields, local, super::Year::Legacy, true)?;
	make_piece(interp, piece_class(&arg(&a, 0)), ret.scalar().to_i64(), local, false)
}
