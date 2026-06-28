// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

mod access;
mod delete;
mod empty;
mod entry;
pub mod exec;
pub mod fs;
mod glob;
mod group;
mod lname;
mod logical_matchers;
mod ls;
mod name;
mod path;
mod perm;
mod printer;
mod printf;
mod prune;
mod quit;
mod regex;
mod samefile;
mod size;
#[cfg(unix)]
mod stat;
pub mod time;
mod type_matcher;
mod user;

use std::{
	error::Error,
	fs::{File, Metadata},
	io::{Read, Write},
	path::Path,
	str::FromStr,
	time::SystemTime,
};

use ::regex::Regex;
use chrono::{DateTime, Datelike, NaiveDateTime, Utc};
pub use entry::{FileType, WalkEntry, WalkError};
use fs::FileSystemMatcher;
use ls::Ls;

#[cfg(unix)]
use self::stat::{InodeMatcher, LinksMatcher};
use self::{
	access::AccessMatcher,
	delete::DeleteMatcher,
	empty::EmptyMatcher,
	exec::{MultiExecMatcher, SingleExecMatcher},
	group::{GroupMatcher, NoGroupMatcher},
	lname::LinkNameMatcher,
	logical_matchers::{
		AndMatcherBuilder, FalseMatcher, ListMatcherBuilder, NotMatcher, TrueMatcher,
	},
	name::NameMatcher,
	path::PathMatcher,
	perm::PermMatcher,
	printer::{PrintDelimiter, Printer},
	printf::Printf,
	prune::PruneMatcher,
	quit::QuitMatcher,
	regex::RegexMatcher,
	samefile::SameFileMatcher,
	size::SizeMatcher,
	time::{
		FileAgeRangeMatcher, FileTimeMatcher, FileTimeType, NewerMatcher, NewerOptionMatcher,
		NewerOptionType, NewerTimeMatcher,
	},
	type_matcher::{TypeMatcher, XtypeMatcher},
	user::{NoUserMatcher, UserMatcher},
};
use super::{Config, Dependencies};

/// Symlink following mode.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Follow {
	/// Never follow symlinks (-P; default).
	Never,
	/// Follow symlinks on root paths only (-H).
	Roots,
	/// Always follow symlinks (-L).
	Always,
}

impl Follow {
	/// Check whether to follow a path of the given depth.
	pub fn follow_at_depth(self, depth: usize) -> bool {
		match self {
			Self::Never => false,
			Self::Roots => depth == 0,
			Self::Always => true,
		}
	}

	/// Get metadata for a [WalkEntry].
	pub fn metadata(self, entry: &WalkEntry) -> Result<Metadata, WalkError> {
		if self.follow_at_depth(entry.depth()) == entry.follow() {
			// Same follow flag, re-use cached metadata
			entry.metadata().cloned()
		} else if !entry.follow() && !entry.file_type().is_symlink() {
			// Not a symlink, re-use cached metadata
			entry.metadata().cloned()
		} else if entry.follow() && entry.file_type().is_symlink() {
			// Broken symlink, re-use cached metadata
			entry.metadata().cloned()
		} else {
			self.metadata_at_depth(entry.path(), entry.depth())
		}
	}

	/// Get metadata for a path from the command line.
	pub fn root_metadata(self, path: impl AsRef<Path>) -> Result<Metadata, WalkError> {
		self.metadata_at_depth(path, 0)
	}

	/// Get metadata for a path, following symlinks as necessary.
	pub fn metadata_at_depth(
		self,
		path: impl AsRef<Path>,
		depth: usize,
	) -> Result<Metadata, WalkError> {
		let path = path.as_ref();

		if self.follow_at_depth(depth) {
			match path.metadata().map_err(WalkError::from) {
				Ok(meta) => return Ok(meta),
				Err(e) if !e.is_not_found() => return Err(e),
				_ => {},
			}
		}

		Ok(path.symlink_metadata()?)
	}
}

/// Struct holding references to outputs and any inputs that can't be derived
/// from the file/directory info.
pub struct MatcherIO<'a> {
	should_skip_dir: bool,
	exit_code:       i32,
	quit:            bool,
	deps:            &'a dyn Dependencies,
}

impl MatcherIO<'_> {
	pub fn new(deps: &dyn Dependencies) -> MatcherIO<'_> {
		MatcherIO { should_skip_dir: false, exit_code: 0, quit: false, deps }
	}

	pub fn mark_current_dir_to_be_skipped(&mut self) {
		self.should_skip_dir = true;
	}

	#[must_use]
	pub fn should_skip_current_dir(&self) -> bool {
		self.should_skip_dir
	}

	pub fn set_exit_code(&mut self, code: i32) {
		self.exit_code = code;
	}

	#[must_use]
	pub fn exit_code(&self) -> i32 {
		self.exit_code
	}

	pub fn quit(&mut self) {
		self.quit = true;
	}

	#[must_use]
	pub fn should_quit(&self) -> bool {
		self.quit
	}

	#[must_use]
	pub fn now(&self) -> SystemTime {
		self.deps.now()
	}
}

/// A basic interface that can be used to determine whether a directory entry
/// is what's being searched for. To a first order approximation, find consists
/// of building a chain of Matcher objects, and then walking a directory tree,
/// passing each entry to the chain of Matchers.
pub trait Matcher: 'static {
	/// Boxes this matcher as a trait object.
	fn into_box(self) -> Box<dyn Matcher>
	where
		Self: Sized,
	{
		Box::new(self)
	}

	/// Returns whether the given file matches the object's predicate.
	fn matches(&self, entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool;

	/// Returns whether the matcher has any side-effects (e.g. executing a
	/// command, deleting a file). Iff no such matcher exists in the chain, then
	/// the filename will be printed to stdout. While this is a compile-time
	/// fact for most matchers, it's run-time for matchers that contain a
	/// collection of sub-Matchers.
	fn has_side_effects(&self) -> bool {
		// most matchers don't have side-effects, so supply a default implementation.
		false
	}

	/// Notification that find is leaving a given directory.
	fn finished_dir(&self, _finished_directory: &Path, _matcher_io: &mut MatcherIO) {}

	/// Notification that find has finished processing all directories -
	/// allowing for any cleanup that isn't suitable for destructors (e.g.
	/// blocking calls, I/O etc.)
	fn finished(&self, _matcher_io: &mut MatcherIO) {}
}

impl Matcher for Box<dyn Matcher> {
	fn into_box(self) -> Box<dyn Matcher> {
		self
	}

	fn matches(&self, entry: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		(**self).matches(entry, matcher_io)
	}

	fn has_side_effects(&self) -> bool {
		(**self).has_side_effects()
	}

	fn finished_dir(&self, finished_directory: &Path, matcher_io: &mut MatcherIO) {
		(**self).finished_dir(finished_directory, matcher_io);
	}

	fn finished(&self, matcher_io: &mut MatcherIO) {
		(**self).finished(matcher_io);
	}
}

#[derive(Debug, Eq, PartialEq)]
pub enum ComparableValue {
	MoreThan(u64),
	EqualTo(u64),
	LessThan(u64),
}

impl ComparableValue {
	fn matches(&self, value: u64) -> bool {
		match *self {
			Self::MoreThan(limit) => value > limit,
			Self::EqualTo(limit) => value == limit,
			Self::LessThan(limit) => value < limit,
		}
	}

	/// same as matches, but takes a signed value
	fn imatches(&self, value: i64) -> bool {
		match *self {
			Self::MoreThan(limit) => value >= 0 && (value as u64) > limit,
			Self::EqualTo(limit) => value >= 0 && (value as u64) == limit,
			Self::LessThan(limit) => value < 0 || (value as u64) < limit,
		}
	}
}

/// Builds a single `AndMatcher` containing the Matcher objects corresponding
/// to the passed in predicate arguments.
pub fn build_top_level_matcher(
	args: &[&str],
	config: &mut Config,
) -> Result<Box<dyn Matcher>, Box<dyn Error>> {
	let (_, top_level_matcher) = (build_matcher_tree(args, config, 0, false))?;

	// if the matcher doesn't have any side-effects, then we default to printing
	if !top_level_matcher.has_side_effects() {
		let mut new_and_matcher = AndMatcherBuilder::new();
		new_and_matcher.new_and_condition(top_level_matcher);
		new_and_matcher.new_and_condition(Printer::new(PrintDelimiter::Newline, None));
		return Ok(new_and_matcher.build());
	}
	Ok(top_level_matcher)
}

/// Helper function for `build_matcher_tree`.
fn are_more_expressions(args: &[&str], index: usize) -> bool {
	(index < args.len() - 1) && args[index + 1] != ")"
}

fn convert_arg_to_number(
	option_name: &str,
	value_as_string: &str,
) -> Result<usize, Box<dyn Error>> {
	match value_as_string.parse::<usize>() {
		Ok(val) => Ok(val),
		_ => Err(From::from(format!(
			"Expected a positive decimal integer argument to {option_name}, but got \
			 `{value_as_string}'"
		))),
	}
}

fn convert_arg_to_comparable_value(
	option_name: &str,
	value_as_string: &str,
) -> Result<ComparableValue, Box<dyn Error>> {
	let re = Regex::new(r"^([-+]?)[-+]?(\d+)$")?;
	if let Some(groups) = re.captures(value_as_string)
		&& let Ok(val) = groups[2].parse::<u64>()
	{
		return Ok(match &groups[1] {
			"+" => ComparableValue::MoreThan(val),
			"-" => ComparableValue::LessThan(val),
			_ => ComparableValue::EqualTo(val),
		});
	}
	Err(From::from(format!(
		"Expected a decimal integer (with optional + or - prefix) argument to {option_name}, but \
		 got `{value_as_string}'"
	)))
}

fn convert_arg_to_comparable_value_and_suffix(
	option_name: &str,
	value_as_string: &str,
) -> Result<(ComparableValue, String), Box<dyn Error>> {
	let re = Regex::new(r"([-+]?)[-+]?(\d+)(.*)$")?;
	if let Some(groups) = re.captures(value_as_string)
		&& let Ok(val) = groups[2].parse::<u64>()
	{
		return Ok((
			match &groups[1] {
				"+" => ComparableValue::MoreThan(val),
				"-" => ComparableValue::LessThan(val),
				_ => ComparableValue::EqualTo(val),
			},
			groups[3].to_string(),
		));
	}
	Err(From::from(format!(
		"Expected a decimal integer (with optional + or - prefix) and (optional suffix) argument to \
		 {option_name}, but got `{value_as_string}'"
	)))
}

/// This is a function that converts a specific string format into a timestamp.
/// It allows converting a time string of
/// "(week abbreviation) (date), (year) (time)" to a Unix timestamp.
/// such as: "jan 01, 2025 00:00:01" -> 1735689601000
/// When (time) is not provided, it will be automatically filled in as 00:00:00
/// such as: "jan 01, 2025" = "jan 01, 2025 00:00:00" -> 1735689600000
fn parse_date_str_to_timestamps(date_str: &str) -> Option<i64> {
	let regex_pattern =
		r"^(?P<month_day>\w{3} \d{2})?(?:, (?P<year>\d{4}))?(?: (?P<time>\d{2}:\d{2}:\d{2}))?$";
	let re = Regex::new(regex_pattern);

	if let Some(captures) = re.ok()?.captures(date_str) {
		let now = Utc::now();
		let month_day = captures
			.get(1)
			.map_or(format!("{} {}", now.format("%b"), now.format("%d")), |m| m.as_str().to_string());
		// If no year input.
		let year = captures
			.get(2)
			.map_or(now.year(), |m| m.as_str().parse().unwrap());
		// If the user does not enter a specific time, it will be filled with 0
		let time_str = captures.get(3).map_or("00:00:00", |m| m.as_str());
		let date_time_str = format!("{month_day}, {year} {time_str}");
		let datetime = NaiveDateTime::parse_from_str(&date_time_str, "%b %d, %Y %H:%M:%S").ok()?;
		let utc_datetime = DateTime::<Utc>::from_naive_utc_and_offset(datetime, Utc);
		Some(utc_datetime.timestamp_millis())
	} else {
		None
	}
}

/// This function implements the function of matching substrings of
/// X and Y from the -newerXY string.
/// X and Y are constrained to a/B/c/m and t.
/// such as: "-neweraB" -> Some(a, B) "-neweraD" -> None
///
/// Additionally, there is support for the -anewer and -cnewer short arguments.
/// as follows:
/// 1. -anewer is equivalent to -neweram
/// 2. -cnewer is equivalent to - newercm
///
/// If -newer is used it will be resolved to -newermm.
fn parse_str_to_newer_args(input: &str) -> Option<(String, String)> {
	if input.is_empty() {
		return None;
	}

	if input == "-newer" {
		return Some(("m".to_string(), "m".to_string()));
	}

	if input == "-anewer" {
		return Some(("a".to_string(), "m".to_string()));
	}

	if input == "-cnewer" {
		return Some(("c".to_string(), "m".to_string()));
	}

	let re = Regex::new(r"-newer([aBcm])([aBcmt])").unwrap();
	if let Some(captures) = re.captures(input) {
		let x = captures.get(1)?.as_str().to_string();
		let y = captures.get(2)?.as_str().to_string();
		Some((x, y))
	} else {
		None
	}
}

/// Creates a file if it doesn't exist.
/// If it does exist, it will be overwritten.
fn get_or_create_file(path: &str) -> Result<File, Box<dyn Error>> {
	let file = File::create(pi_uutils_ctx::resolve(path))?;
	Ok(file)
}

/// The main "translate command-line args into a matcher" function. Will call
/// itself recursively if it encounters an opening bracket. A successful return
/// consists of a tuple containing the new index into the args array to use (if
/// called recursively) and the resulting matcher.
fn build_matcher_tree(
	args: &[&str],
	config: &mut Config,
	arg_index: usize,
	mut expecting_bracket: bool,
) -> Result<(usize, Box<dyn Matcher>), Box<dyn Error>> {
	let mut top_level_matcher = ListMatcherBuilder::new();

	let mut regex_type = regex::RegexType::default();

	// can't use getopts for a variety or reasons:
	// order of arguments is important
	// arguments can start with + as well as -
	// multiple-character flags don't start with a double dash
	let mut i = arg_index;
	let mut invert_next_matcher = false;
	while i < args.len() {
		let possible_submatcher = match args[i] {
			"-print" => Some(Printer::new(PrintDelimiter::Newline, None).into_box()),
			"-print0" => Some(Printer::new(PrintDelimiter::Null, None).into_box()),
			"-printf" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(Printf::new(args[i], None)?.into_box())
			},
			"-fprint" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;

				let file = get_or_create_file(args[i])?;
				Some(Printer::new(PrintDelimiter::Newline, Some(file)).into_box())
			},
			"-fprintf" => {
				if i >= args.len() - 2 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}

				// Action: -fprintf file format
				// Args + 1: output file path
				// Args + 2: format string
				i += 1;
				let file = get_or_create_file(args[i])?;
				i += 1;
				Some(Printf::new(args[i], Some(file))?.into_box())
			},
			"-fprint0" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;

				let file = get_or_create_file(args[i])?;
				Some(Printer::new(PrintDelimiter::Null, Some(file)).into_box())
			},
			"-ls" => Some(Ls::new(None).into_box()),
			"-fls" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;

				let file = get_or_create_file(args[i])?;
				Some(Ls::new(Some(file)).into_box())
			},
			"-true" => Some(TrueMatcher.into_box()),
			"-false" => Some(FalseMatcher.into_box()),
			"-lname" | "-ilname" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(LinkNameMatcher::new(args[i], args[i - 1].starts_with("-i")).into_box())
			},
			"-name" | "-iname" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(NameMatcher::new(args[i], args[i - 1].starts_with("-i")).into_box())
			},
			"-path" | "-ipath" | "-wholename" | "-iwholename" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(PathMatcher::new(args[i], args[i - 1].starts_with("-i")).into_box())
			},
			"-readable" => Some(AccessMatcher::Readable.into_box()),
			"-regextype" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				regex_type = regex::RegexType::from_str(args[i])?;
				Some(TrueMatcher.into_box())
			},
			"-regex" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(RegexMatcher::new(regex_type, args[i], false)?.into_box())
			},
			"-iregex" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(RegexMatcher::new(regex_type, args[i], true)?.into_box())
			},
			"-type" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(TypeMatcher::new(args[i])?.into_box())
			},
			"-xtype" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(XtypeMatcher::new(args[i])?.into_box())
			},
			"-fstype" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(FileSystemMatcher::new(args[i].to_string()).into_box())
			},
			"-delete" => {
				// -delete implicitly requires -depth
				config.depth_first = true;
				Some(DeleteMatcher::new().into_box())
			},
			"-newer" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(NewerMatcher::new(args[i], config.follow)?.into_box())
			},
			"-mtime" | "-atime" | "-ctime" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				let file_time_type = match args[i] {
					"-atime" => FileTimeType::Accessed,
					"-ctime" => FileTimeType::Changed,
					"-mtime" => FileTimeType::Modified,
					// This shouldn't be possible. We've already checked the value
					// is one of those three values.
					_ => unreachable!("Encountered unexpected value {}", args[i]),
				};
				let days = convert_arg_to_comparable_value(args[i], args[i + 1])?;
				i += 1;
				Some(FileTimeMatcher::new(file_time_type, days, config.today_start).into_box())
			},
			"-amin" | "-cmin" | "-mmin" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				let file_time_type = match args[i] {
					"-amin" => FileTimeType::Accessed,
					"-cmin" => FileTimeType::Changed,
					"-mmin" => FileTimeType::Modified,
					_ => unreachable!("Encountered unexpected value {}", args[i]),
				};
				let minutes = convert_arg_to_comparable_value(args[i], args[i + 1])?;
				i += 1;
				Some(FileAgeRangeMatcher::new(file_time_type, minutes, config.today_start).into_box())
			},
			"-size" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				let (size, unit) = convert_arg_to_comparable_value_and_suffix(args[i], args[i + 1])?;
				i += 1;
				Some(SizeMatcher::new(size, &unit)?.into_box())
			},
			"-empty" => Some(EmptyMatcher::new().into_box()),
			"-exec" | "-execdir" => {
				let mut arg_index = i + 1;
				while arg_index < args.len()
					&& args[arg_index] != ";"
					&& (args[arg_index - 1] != "{}" || args[arg_index] != "+")
				{
					arg_index += 1;
				}
				let required_arg = if arg_index < args.len() && args[arg_index] == "+" {
					3
				} else {
					2
				};
				if arg_index < i + required_arg || arg_index == args.len() {
					// at the minimum we need the executable and the ';'
					// or the executable and the '{} +'
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				let expression = args[i];
				let executable = args[i + 1];
				let exec_args = &args[i + 2..arg_index];
				i = arg_index;
				match args[arg_index] {
					";" => Some(
						SingleExecMatcher::new(executable, exec_args, expression == "-execdir")?
							.into_box(),
					),
					"+" => {
						if exec_args.iter().filter(|x| matches!(**x, "{}")).count() == 1 {
							Some(
								MultiExecMatcher::new(
									executable,
									&exec_args[0..exec_args.len() - 1],
									expression == "-execdir",
								)?
								.into_box(),
							)
						} else {
							return Err(From::from(
								"Only one instance of {} is supported with -execdir ... +",
							));
						}
					},
					_ => unreachable!("Encountered unexpected value {}", args[arg_index]),
				}
			},
			#[cfg(unix)]
			"-inum" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				let inum = convert_arg_to_comparable_value(args[i], args[i + 1])?;
				i += 1;
				Some(InodeMatcher::new(inum).into_box())
			},
			#[cfg(not(unix))]
			"-inum" => {
				return Err(From::from("Inode numbers are not available on this platform"));
			},
			#[cfg(unix)]
			"-links" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				let inum = convert_arg_to_comparable_value(args[i], args[i + 1])?;
				i += 1;
				Some(LinksMatcher::new(inum).into_box())
			},
			#[cfg(not(unix))]
			"-links" => {
				return Err(From::from("Link counts are not available on this platform"));
			},
			"-samefile" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				let path = args[i];
				let matcher =
					SameFileMatcher::new(path, config.follow).map_err(|e| format!("{path}: {e}"))?;
				Some(matcher.into_box())
			},
			"-user" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}

				let user = args[i + 1];

				if user.is_empty() {
					return Err(From::from("The argument to -user should not be empty"));
				}

				i += 1;
				let matcher = UserMatcher::from_user_name(user)
					.or_else(|| Some(UserMatcher::from_uid(user.parse::<u32>().ok()?)))
					.ok_or_else(|| format!("{user} is not the name of a known user"))?;
				Some(matcher.into_box())
			},
			"-nouser" => Some(NoUserMatcher {}.into_box()),
			"-uid" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				// check if the argument is a number
				let uid = convert_arg_to_comparable_value(args[i], args[i + 1])?;
				i += 1;
				Some(UserMatcher::from_comparable(uid).into_box())
			},
			"-group" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}

				let group = args[i + 1];

				if group.is_empty() {
					return Err(From::from("Argument to -group is empty, but should be a group name"));
				}

				i += 1;
				let matcher = GroupMatcher::from_group_name(group)
					.or_else(|| Some(GroupMatcher::from_gid(group.parse::<u32>().ok()?)))
					.ok_or_else(|| format!("{group} is not the name of an existing group"))?;
				Some(matcher.into_box())
			},
			"-nogroup" => Some(NoGroupMatcher {}.into_box()),
			"-gid" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				// check if the argument is a number
				let gid = convert_arg_to_comparable_value(args[i], args[i + 1])?;
				i += 1;
				Some(GroupMatcher::from_comparable(gid).into_box())
			},
			"-executable" => Some(AccessMatcher::Executable.into_box()),
			"-perm" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				i += 1;
				Some(PermMatcher::new(args[i])?.into_box())
			},
			"-prune" => Some(PruneMatcher::new().into_box()),
			"-quit" => Some(QuitMatcher.into_box()),
			"-writable" => Some(AccessMatcher::Writable.into_box()),
			"-not" | "!" => {
				if !are_more_expressions(args, i) {
					return Err(From::from(format!("expected an expression after {}", args[i])));
				}
				invert_next_matcher = !invert_next_matcher;
				None
			},
			"-and" | "-a" => {
				if !are_more_expressions(args, i) {
					return Err(From::from(format!("expected an expression after {}", args[i])));
				}
				top_level_matcher.check_new_and_condition()?;
				None
			},
			"-or" | "-o" => {
				if !are_more_expressions(args, i) {
					return Err(From::from(format!("expected an expression after {}", args[i])));
				}
				top_level_matcher.new_or_condition(args[i])?;
				None
			},
			"," => {
				if !are_more_expressions(args, i) {
					return Err(From::from(format!("expected an expression after {}", args[i])));
				}
				top_level_matcher.new_list_condition()?;
				None
			},
			"(" => {
				let (new_arg_index, sub_matcher) = build_matcher_tree(args, config, i + 1, true)?;
				i = new_arg_index;
				Some(sub_matcher)
			},
			")" => {
				if !expecting_bracket {
					return Err(From::from(
						"invalid expression: expected expression before closing parentheses ')'.",
					));
				}

				let bracket = args[i - 1];
				if bracket == "(" {
					return Err(From::from("invalid expression; empty parentheses are not allowed."));
				}

				return Ok((i, top_level_matcher.build()));
			},
			"-follow" => {
				// This option affects multiple matchers.
				// 1. It will use noleaf by default. (but -noleaf No change of behavior)
				// Unless -L or -H is specified:
				// 2. changes the behaviour of the -newer predicate.
				// 3. consideration applies to -newerXY, -anewer and -cnewer
				// 4. -type predicate will always match against the type of the file that a
				//    symbolic link points to rather than the link itself.
				//
				// 5. causes the -lname and -ilname predicates always to return false. (unless
				//    they happen to match broken symbolic links)
				config.follow = Follow::Always;
				config.no_leaf_dirs = true;
				Some(TrueMatcher.into_box())
			},
			"-daystart" => {
				config.today_start = true;
				Some(TrueMatcher.into_box())
			},
			"-noleaf" => {
				// No change of behavior
				config.no_leaf_dirs = true;
				Some(TrueMatcher.into_box())
			},
			"-d" | "-depth" => {
				// TODO add warning if it appears after actual testing criterion
				config.depth_first = true;
				Some(TrueMatcher.into_box())
			},
			"-mount" | "-xdev" => {
				// TODO add warning if it appears after actual testing criterion
				config.same_file_system = true;
				Some(TrueMatcher.into_box())
			},
			"-sorted" => {
				// TODO add warning if it appears after actual testing criterion
				config.sorted_output = true;
				Some(TrueMatcher.into_box())
			},
			"-maxdepth" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				config.max_depth = convert_arg_to_number(args[i], args[i + 1])?;
				i += 1;
				Some(TrueMatcher.into_box())
			},
			"-mindepth" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				config.min_depth = convert_arg_to_number(args[i], args[i + 1])?;
				i += 1;
				Some(TrueMatcher.into_box())
			},
			"-help" | "--help" => {
				config.help_requested = true;
				None
			},
			"-version" | "--version" => {
				config.version_requested = true;
				None
			},
			"-files0-from" => {
				if i >= args.len() - 1 {
					return Err(From::from(format!("missing argument to {}", args[i])));
				}
				let _ = config.files0_argument.insert(args[i + 1].to_string());
				i += 1;
				Some(TrueMatcher.into_box())
			},

			_ => {
				match parse_str_to_newer_args(args[i]) {
					Some((x_option, y_option)) => {
						if i >= args.len() - 1 {
							return Err(From::from(format!("missing argument to {}", args[i])));
						}
						#[cfg(target_os = "linux")]
						if x_option == "B" {
							return Err(From::from(
								"find: This system does not provide a way to find the birth time of a \
								 file.",
							));
						}
						if y_option == "t" {
							let time = args[i + 1];
							let newer_time_type = NewerOptionType::from_str(x_option.as_str());
							// Convert args to unix timestamps. (expressed in numeric types)
							let Some(comparable_time) = parse_date_str_to_timestamps(time) else {
								return Err(From::from(format!(
									"find: I cannot figure out how to interpret ‘{}’ as a date or time",
									args[i + 1]
								)));
							};
							i += 1;
							Some(NewerTimeMatcher::new(newer_time_type, comparable_time).into_box())
						} else {
							let file_path = args[i + 1];
							i += 1;
							Some(NewerOptionMatcher::new(&x_option, &y_option, file_path)?.into_box())
						}
					},
					None => return Err(From::from(format!("Unrecognized flag: '{}'", args[i]))),
				}
			},
		};
		i += 1;
		if config.help_requested || config.version_requested {
			// Ignore anything, even invalid expressions, after -help/-version
			expecting_bracket = false;
			break;
		}
		if let Some(submatcher) = possible_submatcher {
			if invert_next_matcher {
				top_level_matcher.new_and_condition(NotMatcher::new(submatcher));
				invert_next_matcher = false;
			} else {
				top_level_matcher.new_and_condition(submatcher);
			}
		}
	}
	if expecting_bracket {
		return Err(From::from(
			"invalid expression; I was expecting to find a ')' somewhere but did not see one.",
		));
	}
	if config.files0_argument.is_some() {
		parse_files0_args(config)?;
	}
	Ok((i, top_level_matcher.build()))
}

// https://www.gnu.org/software/findutils/manual/html_node/find_html/Starting-points.html
// This allows users to take the entry point for find from stdin (eg. pipe) or
// from a text file. eg. dummy | find -files0-from -
// eg. find -files0-from rust.txt -name "cargo"
fn parse_files0_args(config: &mut Config) -> Result<(), Box<dyn Error>> {
	let mode = config.files0_argument.as_ref().unwrap();
	let mut buffer = Vec::new();
	let new_paths = config.new_paths.insert(Vec::new());

	if mode == "-" {
		pi_uutils_ctx::stdin().read_to_end(&mut buffer)?;
	} else {
		let mut file = File::open(pi_uutils_ctx::resolve(mode))
			.map_err(|e| format!("cannot open '{}' for reading: {}", mode, e))?;
		file.read_to_end(&mut buffer)?;
	}

	let mut buffer_split: Vec<&[u8]> = buffer.split(|&b| b == 0).collect();
	// if the pipe/file ends with ASCII NULL
	if buffer_split.last().is_some_and(|s| s.is_empty()) {
		buffer_split.remove(buffer_split.len() - 1);
	}

	let mut string_segments: Vec<String> = buffer_split
		.iter()
		.filter_map(|s| std::str::from_utf8(s).ok())
		.map(|s| s.to_string())
		.collect();
	// empty starting point checker
	if string_segments.iter().any(|s| s.is_empty()) {
		let _ = writeln!(pi_uutils_ctx::stderr(), "find: invalid zero-length file name");
		// remove the empty ones so as to avoid file not found error
		string_segments.retain(|s| !s.is_empty());
	}

	new_paths.extend(string_segments);
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::find::tests::{FakeDependencies, fix_up_slashes};

	/// Helper function for tests to get a [WalkEntry] object. root should
	/// probably be a string starting with `test_data/` (cargo's tests run with
	/// a working directory set to the root findutils folder).
	pub fn get_dir_entry_for(root: &str, path: &str) -> WalkEntry {
		get_dir_entry_follow(root, path, Follow::Never)
	}

	/// Get a [WalkEntry] with an explicit [Follow] flag.
	pub fn get_dir_entry_follow(root: &str, path: &str, follow: Follow) -> WalkEntry {
		let root = fix_up_slashes(root);
		let root = Path::new(&root);

		let path = fix_up_slashes(path);
		let path = if path.is_empty() {
			root.to_owned()
		} else {
			root.join(path)
		};

		let depth = path.components().count() - root.components().count();
		WalkEntry::new(path, depth, follow)
	}

	#[test]
	fn build_top_level_matcher_name() {
		let abbbc_lower = get_dir_entry_for("./test_data/simple", "abbbc");
		let abbbc_upper = get_dir_entry_for("./test_data/simple/subdir", "ABBBC");
		let mut config = Config::default();
		let deps = FakeDependencies::new();

		let matcher = build_top_level_matcher(&["-name", "a*c"], &mut config).unwrap();

		assert!(matcher.matches(&abbbc_lower, &mut deps.new_matcher_io()));
		assert!(!matcher.matches(&abbbc_upper, &mut deps.new_matcher_io()));
		assert_eq!(deps.get_output_as_string(), fix_up_slashes("./test_data/simple/abbbc\n"));
	}

	#[test]
	fn build_top_level_matcher_iname() {
		let abbbc_lower = get_dir_entry_for("./test_data/simple", "abbbc");
		let abbbc_upper = get_dir_entry_for("./test_data/simple/subdir", "ABBBC");
		let mut config = Config::default();
		let deps = FakeDependencies::new();

		let matcher = build_top_level_matcher(&["-iname", "a*c"], &mut config).unwrap();

		assert!(matcher.matches(&abbbc_lower, &mut deps.new_matcher_io()));
		assert!(matcher.matches(&abbbc_upper, &mut deps.new_matcher_io()));
		assert_eq!(
			deps.get_output_as_string(),
			fix_up_slashes("./test_data/simple/abbbc\n./test_data/simple/subdir/ABBBC\n")
		);
	}

	#[test]
	fn build_top_level_matcher_not() {
		for arg in &["-not", "!"] {
			let abbbc_lower = get_dir_entry_for("./test_data/simple", "abbbc");
			let mut config = Config::default();
			let deps = FakeDependencies::new();

			let matcher =
				build_top_level_matcher(&[arg, "-name", "does_not_exist"], &mut config).unwrap();

			assert!(matcher.matches(&abbbc_lower, &mut deps.new_matcher_io()));
			assert_eq!(deps.get_output_as_string(), fix_up_slashes("./test_data/simple/abbbc\n"));
		}
	}

	#[test]
	fn build_top_level_matcher_not_needs_expression() {
		for arg in &["-not", "!"] {
			let mut config = Config::default();

			if let Err(e) = build_top_level_matcher(&[arg], &mut config) {
				assert!(e.to_string().contains("expected an expression"));
			} else {
				panic!("parsing argument lists that end in -not should fail");
			}
		}
	}

	#[test]
	fn build_top_level_matcher_not_double_negation() {
		for arg in &["-not", "!"] {
			let abbbc_lower = get_dir_entry_for("./test_data/simple", "abbbc");
			let mut config = Config::default();
			let deps = FakeDependencies::new();

			let matcher = build_top_level_matcher(&[arg, arg, "-name", "abbbc"], &mut config).unwrap();

			assert!(matcher.matches(&abbbc_lower, &mut deps.new_matcher_io()));
			assert_eq!(deps.get_output_as_string(), fix_up_slashes("./test_data/simple/abbbc\n"));

			config = Config::default();
			let matcher =
				build_top_level_matcher(&[arg, arg, "-name", "does_not_exist"], &mut config).unwrap();

			assert!(!matcher.matches(&abbbc_lower, &mut deps.new_matcher_io()));
		}
	}

	#[test]
	fn build_top_level_matcher_missing_args() {
		for arg in &["-iname", "-name", "-type"] {
			let mut config = Config::default();

			if let Err(e) = build_top_level_matcher(&[arg], &mut config) {
				assert!(e.to_string().contains("missing argument to"));
				assert!(e.to_string().contains(arg));
			} else {
				panic!("parsing argument lists that end in -not should fail");
			}
		}
	}

	#[test]
	fn build_top_level_matcher_or_without_expr1() {
		for arg in &["-or", "-o"] {
			let mut config = Config::default();

			if let Err(e) = build_top_level_matcher(&[arg, "-true"], &mut config) {
				assert!(e.to_string().contains("you have used a binary operator"));
			} else {
				panic!("parsing argument list that begins with -or should fail");
			}
		}
	}

	#[test]
	fn build_top_level_matcher_or_without_expr2() {
		for arg in &["-or", "-o"] {
			let mut config = Config::default();

			if let Err(e) = build_top_level_matcher(&["-true", arg], &mut config) {
				assert!(e.to_string().contains("expected an expression"));
			} else {
				panic!("parsing argument list that ends with -or should fail");
			}
		}
	}

	#[test]
	fn build_top_level_matcher_and_without_expr1() {
		let mut config = Config::default();

		if let Err(e) = build_top_level_matcher(&["-a", "-true"], &mut config) {
			assert!(e.to_string().contains("you have used a binary operator"));
		} else {
			panic!("parsing argument list that begins with -a should fail");
		}
	}

	#[test]
	fn build_top_level_matcher_and_without_expr2() {
		let mut config = Config::default();

		if let Err(e) = build_top_level_matcher(&["-true", "-a"], &mut config) {
			assert!(e.to_string().contains("expected an expression"));
		} else {
			panic!("parsing argument list that ends with -or should fail");
		}
	}

	#[test]
	fn build_top_level_matcher_dash_a_works() {
		for arg in &["-a", "-and"] {
			let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");
			let mut config = Config::default();
			let deps = FakeDependencies::new();

			// build a matcher using an explicit -a argument
			let matcher = build_top_level_matcher(&["-true", arg, "-true"], &mut config).unwrap();
			assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
			assert_eq!(deps.get_output_as_string(), fix_up_slashes("./test_data/simple/abbbc\n"));
		}
	}

	#[test]
	fn build_top_level_matcher_or_works() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");
		for args in &[["-true", "-o", "-false"], ["-false", "-o", "-true"], ["-true", "-o", "-true"]]
		{
			let mut config = Config::default();
			let deps = FakeDependencies::new();

			let matcher = build_top_level_matcher(args, &mut config).unwrap();

			assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
			assert_eq!(deps.get_output_as_string(), fix_up_slashes("./test_data/simple/abbbc\n"));
		}

		let mut config = Config::default();
		let deps = FakeDependencies::new();

		let matcher = build_top_level_matcher(&["-false", "-o", "-false"], &mut config).unwrap();

		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		assert_eq!(deps.get_output_as_string(), "");
	}

	#[test]
	fn build_top_level_matcher_and_works() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");
		for args in &[["-true", "-false"], ["-false", "-true"], ["-false", "-false"]] {
			let mut config = Config::default();
			let deps = FakeDependencies::new();

			let matcher = build_top_level_matcher(args, &mut config).unwrap();

			assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
			assert_eq!(deps.get_output_as_string(), "");
		}

		let mut config = Config::default();
		let deps = FakeDependencies::new();

		let matcher = build_top_level_matcher(&["-true", "-true"], &mut config).unwrap();

		assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		assert_eq!(deps.get_output_as_string(), fix_up_slashes("./test_data/simple/abbbc\n"));
	}

	#[test]
	fn build_top_level_matcher_list_works() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");
		let args = ["-true", "-print", "-false", ",", "-print", "-false"];
		let mut config = Config::default();
		let deps = FakeDependencies::new();

		let matcher = build_top_level_matcher(&args, &mut config).unwrap();

		// final matcher returns false, so list matcher should too
		assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		// two print matchers means doubled output
		assert_eq!(
			deps.get_output_as_string(),
			fix_up_slashes("./test_data/simple/abbbc\n./test_data/simple/abbbc\n")
		);
	}

	#[test]
	fn build_top_level_matcher_list_without_expr1() {
		let mut config = Config::default();

		if let Err(e) = build_top_level_matcher(&[",", "-true"], &mut config) {
			assert!(e.to_string().contains("you have used a binary operator"));
		} else {
			panic!("parsing argument list that begins with , should fail");
		}

		if let Err(e) = build_top_level_matcher(&["-true", "-o", ",", "-true"], &mut config) {
			assert!(e.to_string().contains("you have used a binary operator"));
		} else {
			panic!("parsing argument list that contains '-o  ,' should fail");
		}
	}

	#[test]
	fn build_top_level_matcher_list_without_expr2() {
		let mut config = Config::default();

		if let Err(e) = build_top_level_matcher(&["-true", ","], &mut config) {
			assert!(e.to_string().contains("expected an expression"));
		} else {
			panic!("parsing argument list that ends with , should fail");
		}
	}

	#[test]
	fn build_top_level_matcher_not_enough_brackets() {
		let mut config = Config::default();

		if let Err(e) = build_top_level_matcher(&["-true", "("], &mut config) {
			assert!(e.to_string().contains("I was expecting to find a ')'"));
		} else {
			panic!("parsing argument list with not enough closing brackets should fail");
		}
	}

	#[test]
	fn build_top_level_matcher_too_many_brackets() {
		let mut config = Config::default();

		if let Err(e) =
			build_top_level_matcher(&["-type", "f", "(", "-name", "*.txt", ")", ")"], &mut config)
		{
			assert!(
				e.to_string()
					.contains("expected expression before closing parentheses ')'")
			);
		} else {
			panic!("parsing argument list with too many closing brackets should fail");
		}
	}

	#[test]
	fn build_top_level_matcher_can_use_bracket_as_arg() {
		let mut config = Config::default();
		// make sure that if we use a bracket as an argument (e.g. to -name)
		// then it isn't viewed as a bracket
		build_top_level_matcher(&["-name", "("], &mut config).unwrap();
		build_top_level_matcher(&["-name", ")"], &mut config).unwrap();
	}

	#[test]
	fn build_top_level_matcher_brackets_work() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");
		// same as true | ( false & false) = true
		let args_without = ["-true", "-o", "-false", "-false"];
		// same as (true | false) & false = false
		let args_with = ["(", "-true", "-o", "-false", ")", "-false"];
		let mut config = Config::default();
		let deps = FakeDependencies::new();

		{
			let matcher = build_top_level_matcher(&args_without, &mut config).unwrap();
			assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		}
		{
			let matcher = build_top_level_matcher(&args_with, &mut config).unwrap();
			assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		}
	}

	#[test]
	fn build_top_level_matcher_not_and_brackets_work() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");
		// same as (true & !(false)) | true = true
		let args_without = ["-true", "-not", "-false", "-o", "-true"];
		// same as true & !(false | true) = false
		let args_with = ["-true", "-not", "(", "-false", "-o", "-true", ")"];
		let mut config = Config::default();
		let deps = FakeDependencies::new();

		{
			let matcher = build_top_level_matcher(&args_without, &mut config).unwrap();
			assert!(matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		}
		{
			let matcher = build_top_level_matcher(&args_with, &mut config).unwrap();
			assert!(!matcher.matches(&abbbc, &mut deps.new_matcher_io()));
		}
	}

	#[test]
	fn build_top_level_matcher_expression_empty_parentheses() {
		let mut config = Config::default();

		if let Err(e) = build_top_level_matcher(&["-true", "(", ")"], &mut config) {
			assert!(e.to_string().contains("empty parentheses are not allowed"));
		} else {
			panic!("parsing argument list with empty parentheses in an expression should fail");
		}
	}

	#[test]
	fn build_top_level_matcher_follow_config() {
		let mut config = Config::default();

		build_top_level_matcher(&["-follow"], &mut config).unwrap();

		assert_eq!(config.follow, Follow::Always);
	}

	#[test]
	fn comparable_value_matches() {
		assert!(!ComparableValue::LessThan(0).matches(0), "0 should not be less than 0");
		assert!(ComparableValue::LessThan(u64::MAX).matches(0), "0 should be less than max_value");
		assert!(
			!ComparableValue::LessThan(0).matches(u64::MAX),
			"max_value should not be less than 0"
		);
		assert!(
			!ComparableValue::LessThan(u64::MAX).matches(u64::MAX),
			"max_value should not be less than max_value"
		);

		assert!(ComparableValue::EqualTo(0).matches(0), "0 should be equal to 0");
		assert!(!ComparableValue::EqualTo(u64::MAX).matches(0), "0 should not be equal to max_value");
		assert!(!ComparableValue::EqualTo(0).matches(u64::MAX), "max_value should not be equal to 0");
		assert!(
			ComparableValue::EqualTo(u64::MAX).matches(u64::MAX),
			"max_value should be equal to max_value"
		);

		assert!(!ComparableValue::MoreThan(0).matches(0), "0 should not be more than 0");
		assert!(
			!ComparableValue::MoreThan(u64::MAX).matches(0),
			"0 should not be more than max_value"
		);
		assert!(ComparableValue::MoreThan(0).matches(u64::MAX), "max_value should be more than 0");
		assert!(
			!ComparableValue::MoreThan(u64::MAX).matches(u64::MAX),
			"max_value should not be more than max_value"
		);
	}

	#[test]
	fn comparable_value_imatches() {
		assert!(!ComparableValue::LessThan(0).imatches(0), "0 should not be less than 0");
		assert!(ComparableValue::LessThan(u64::MAX).imatches(0), "0 should be less than max_value");
		assert!(
			!ComparableValue::LessThan(0).imatches(i64::MAX),
			"max_value should not be less than 0"
		);
		assert!(
			ComparableValue::LessThan(u64::MAX).imatches(i64::MAX),
			"max_value should be less than max_value"
		);
		assert!(ComparableValue::LessThan(0).imatches(i64::MIN), "min_value should be less than 0");
		assert!(
			ComparableValue::LessThan(u64::MAX).imatches(i64::MIN),
			"min_value should be less than max_value"
		);

		assert!(ComparableValue::EqualTo(0).imatches(0), "0 should be equal to 0");
		assert!(
			!ComparableValue::EqualTo(u64::MAX).imatches(0),
			"0 should not be equal to max_value"
		);
		assert!(
			!ComparableValue::EqualTo(0).imatches(i64::MAX),
			"max_value should not be equal to 0"
		);
		assert!(
			!ComparableValue::EqualTo(u64::MAX).imatches(i64::MAX),
			"max_value should not be equal to i64::max_value"
		);
		assert!(
			ComparableValue::EqualTo(i64::MAX as u64).imatches(i64::MAX),
			"i64::max_value should be equal to i64::max_value"
		);
		assert!(
			!ComparableValue::EqualTo(0).imatches(i64::MIN),
			"min_value should not be equal to 0"
		);
		assert!(
			!ComparableValue::EqualTo(u64::MAX).imatches(i64::MIN),
			"min_value should not be equal to max_value"
		);

		assert!(!ComparableValue::MoreThan(0).imatches(0), "0 should not be more than 0");
		assert!(
			!ComparableValue::MoreThan(u64::MAX).imatches(0),
			"0 should not be more than max_value"
		);
		assert!(ComparableValue::MoreThan(0).imatches(i64::MAX), "max_value should be more than 0");
		assert!(
			!ComparableValue::MoreThan(u64::MAX).imatches(i64::MAX),
			"max_value should not be more than max_value"
		);
		assert!(
			!ComparableValue::MoreThan(0).imatches(i64::MIN),
			"min_value should not be more than 0"
		);
		assert!(
			!ComparableValue::MoreThan(u64::MAX).imatches(i64::MIN),
			"min_value should not be more than max_value"
		);
	}

	#[test]
	fn build_top_level_matcher_bad_ctime_value() {
		let mut config = Config::default();

		if let Err(e) = build_top_level_matcher(&["-ctime", "-123."], &mut config) {
			assert!(e.to_string().contains("Expected a decimal integer"), "bad description: {e}");
		} else {
			panic!("parsing a bad ctime value should fail");
		}
	}

	#[test]
	fn build_top_level_exec_not_enough_args() {
		let mut config = Config::default();

		if let Err(e) = build_top_level_matcher(&["-exec"], &mut config) {
			assert!(e.to_string().contains("missing argument"));
		} else {
			panic!("parsing argument list with exec and no executable or semi-colon should fail");
		}

		if let Err(e) = build_top_level_matcher(&["-exec", ";"], &mut config) {
			assert!(e.to_string().contains("missing argument"));
		} else {
			panic!("parsing argument list with exec and no executable should fail");
		}

		if let Err(e) = build_top_level_matcher(&["-exec", "foo"], &mut config) {
			assert!(e.to_string().contains("missing argument"));
		} else {
			panic!("parsing argument list with exec and no executable should fail");
		}

		if let Err(e) = build_top_level_matcher(&["-exec", "+"], &mut config) {
			assert!(e.to_string().contains("missing argument"));
		} else {
			panic!("parsing argument list with exec and no executable should fail");
		}

		if let Err(e) = build_top_level_matcher(&["-exec", "foo", "+"], &mut config) {
			assert!(e.to_string().contains("missing argument"));
		} else {
			panic!("parsing argument list with exec and no brackets should fail");
		}

		if let Err(e) = build_top_level_matcher(&["-exec", "{}", "+"], &mut config) {
			assert!(e.to_string().contains("missing argument"));
		} else {
			panic!("parsing argument list with exec and no executable should fail");
		}

		if let Err(e) = build_top_level_matcher(&["-exec", "foo", "{}", "foo", "+"], &mut config) {
			assert!(e.to_string().contains("missing argument"));
		} else {
			panic!("parsing argument list with exec and + not following {{}} should fail");
		}
	}

	#[test]
	fn build_top_level_exec_should_eat_args() {
		let mut config = Config::default();
		build_top_level_matcher(&["-exec", "foo", "-o", "(", ";"], &mut config)
			.expect("parsing argument list with exec that takes brackets and -os should work");
	}

	#[test]
	fn build_top_level_exec_plus_semicolon() {
		let mut config = Config::default();
		build_top_level_matcher(&["-exec", "foo", "{}", "foo", "+", ";"], &mut config)
			.expect("only {} + should be considered a multi-exec");
	}

	#[test]
	fn build_top_level_multi_exec_too_many_holders() {
		let mut config = Config::default();
		if let Err(e) =
			build_top_level_matcher(&["-exec", "foo", "{}", "foo", "{}", "+", ";"], &mut config)
		{
			assert!(e.to_string().contains("Only one instance of {}"));
		} else {
			panic!("parsing argument list with more than one {{}} for + should fail");
		}
	}

	#[test]
	#[cfg(unix)]
	fn build_top_level_matcher_perm() {
		let abbbc = get_dir_entry_for("./test_data/simple", "abbbc");
		let mut config = Config::default();

		// this should match: abbbc is readable
		let matcher_readable = build_top_level_matcher(&["-perm", "-u+r"], &mut config).unwrap();
		// this shouldn't match: abbbc isn't executable
		let matcher_executable = build_top_level_matcher(&["-perm", "-u+x"], &mut config).unwrap();

		let deps = FakeDependencies::new();
		assert!(matcher_readable.matches(&abbbc, &mut deps.new_matcher_io()));
		assert_eq!(deps.get_output_as_string(), "./test_data/simple/abbbc\n");

		let deps = FakeDependencies::new();
		assert!(!matcher_executable.matches(&abbbc, &mut deps.new_matcher_io()));
		assert_eq!(deps.get_output_as_string(), "");
	}

	#[test]
	#[cfg(unix)]
	fn build_top_level_matcher_perm_bad() {
		let mut config = Config::default();
		if let Err(e) = build_top_level_matcher(&["-perm", "foo"], &mut config) {
			assert!(e.to_string().contains("invalid operator"));
		} else {
			panic!("-perm with bad mode pattern should fail");
		}

		if let Err(e) = build_top_level_matcher(&["-perm"], &mut config) {
			assert!(e.to_string().contains("missing argument"));
		} else {
			panic!("-perm with no mode pattern should fail");
		}
	}

	#[test]
	#[cfg(not(unix))]
	fn build_top_level_matcher_perm_not_unix() {
		let mut config = Config::default();
		if let Err(e) = build_top_level_matcher(&["-perm", "444"], &mut config) {
			assert!(e.to_string().contains("not available"));
		} else {
			panic!("-perm on non-unix systems shouldn't be available");
		}

		if let Err(e) = build_top_level_matcher(&["-perm"], &mut config) {
			assert!(e.to_string().contains("missing argument"));
		} else {
			panic!("-perm with no mode pattern should fail");
		}
	}

	#[test]
	fn convert_arg_to_comparable_value_test() {
		assert_eq!(
			convert_arg_to_comparable_value("test", "10").unwrap(),
			ComparableValue::EqualTo(10),
		);
		assert_eq!(
			convert_arg_to_comparable_value("test", "+10").unwrap(),
			ComparableValue::MoreThan(10),
		);
		assert_eq!(
			convert_arg_to_comparable_value("test", "-10").unwrap(),
			ComparableValue::LessThan(10),
		);

		assert_eq!(
			convert_arg_to_comparable_value("test", "-+10").unwrap(),
			ComparableValue::LessThan(10),
		);
		assert_eq!(
			convert_arg_to_comparable_value("test", "++10").unwrap(),
			ComparableValue::MoreThan(10),
		);
	}

	#[test]
	fn convert_exception_arg_to_comparable_value_test() {
		let exception_args = ["1%2", "1%2%3", "1a2", "1%2a", "abc", "-", "+", "%"];

		for arg in exception_args {
			let comparable = convert_arg_to_comparable_value("test", arg);
			assert!(comparable.is_err(), "{} should be parse to Comparable correctly", arg);
		}
	}

	#[test]
	fn parse_date_str_to_timestamps_test() {
		let full_date_timestamps = parse_date_str_to_timestamps("jan 01, 2025 00:00:01").unwrap();
		assert!(full_date_timestamps.to_string().contains("1735689601000"));

		let not_include_time_date_timestamps = parse_date_str_to_timestamps("jan 01, 2025").unwrap();
		assert!(
			not_include_time_date_timestamps
				.to_string()
				.contains("1735689600000")
		);

		// pass if return current time.
		let none_date_timestamps = parse_date_str_to_timestamps("");
		let now_but_zero_hour_min_sec = Utc::now()
			.date_naive()
			.and_hms_opt(0, 0, 0)
			.unwrap()
			.and_utc()
			.timestamp_millis();
		assert_eq!(none_date_timestamps, Some(now_but_zero_hour_min_sec));
	}

	#[test]
	fn parse_str_to_newer_args_test() {
		// test for error case
		let arg = parse_str_to_newer_args("");
		assert!(arg.is_none());

		// test for short options
		// -newer equivalent to -newermm
		let arg = parse_str_to_newer_args("-newer").unwrap();
		assert_eq!(("m".to_string(), "m".to_string()), arg);

		// -anewer equivalent to -neweram
		let arg = parse_str_to_newer_args("-anewer").unwrap();
		assert_eq!(("a".to_string(), "m".to_string()), arg);

		// -cnewer equivalent to - newercm
		let arg = parse_str_to_newer_args("-cnewer").unwrap();
		assert_eq!(("c".to_string(), "m".to_string()), arg);

		let x_options = ["a", "B", "c", "m"];
		let y_options = ["a", "B", "c", "m", "t"];

		for &x in &x_options {
			for &y in &y_options {
				let eq: (String, String) = (String::from(x), String::from(y));
				let arg = parse_str_to_newer_args(&format!("-newer{x}{y}").to_string()).unwrap();
				assert_eq!(eq, arg);
			}
		}
	}

	#[test]
	fn build_top_level_matcher_option_logical() {
		let mut config = Config::default();
		build_top_level_matcher(&["-maxdepth", "0", "-a", "-print"], &mut config)
			.expect("logical operators like -a should work with options");
		assert_eq!(config.max_depth, 0);
	}

	#[test]
	fn build_top_level_matcher_help_invalid() {
		let mut config = Config::default();
		build_top_level_matcher(&["(", "-help", "-a"], &mut config)
			.expect("-help should stop parsing");
		assert!(config.help_requested);
	}

	#[test]
	fn build_top_level_matcher_version_invalid() {
		let mut config = Config::default();
		build_top_level_matcher(&["(", "-version", "-o", ")", ")"], &mut config)
			.expect("-version should stop parsing");
		assert!(config.version_requested);
	}

	#[test]
	fn get_or_create_file_test() {
		use std::fs;

		// remove file if hard link file exist.
		// But you can't delete a file that doesn't exist,
		// so ignore the error returned here.
		let _ = fs::remove_file("test_data/get_or_create_file_test");

		// test create file
		let file = get_or_create_file("test_data/get_or_create_file_test");
		assert!(file.is_ok());

		let file = get_or_create_file("test_data/get_or_create_file_test");
		assert!(file.is_ok());

		// test error when file no permission
		#[cfg(unix)]
		{
			let result = get_or_create_file("/etc/shadow");
			assert!(result.is_err());
		}

		let _ = fs::remove_file("test_data/get_or_create_file_test");
	}
}
