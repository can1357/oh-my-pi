// Copyright 2021 Collabora, Ltd.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#[cfg(unix)]
use std::os::unix::prelude::MetadataExt;
use std::{
	borrow::Cow,
	error::Error,
	fs::{self, File},
	io::Write,
	path::Path,
	time::SystemTime,
};

use chrono::{DateTime, Local, format::StrftimeItems};

use super::{FileType, Matcher, MatcherIO, WalkEntry, WalkError};

const STANDARD_BLOCK_SIZE: u64 = 512;

#[derive(Debug, PartialEq, Eq)]
enum Justify {
	Left,
	Right,
}

#[derive(Debug, PartialEq, Eq)]
enum TimeFormat {
	/// Follow ctime(3).
	Ctime,
	/// Seconds since the epoch, as a float w/ nanosecond part.
	SinceEpoch,
	/// Follow strftime-compatible syntax
	Strftime(String),
}

impl TimeFormat {
	fn apply(&self, time: SystemTime) -> Result<Cow<'static, str>, Box<dyn Error>> {
		let formatted = match self {
			Self::SinceEpoch => {
				let duration = time.duration_since(SystemTime::UNIX_EPOCH)?;
				format!("{}.{:09}0", duration.as_secs(), duration.subsec_nanos())
			},
			Self::Ctime => {
				const CTIME_FORMAT: &str = "%a %b %d %H:%M:%S.%f0 %Y";

				DateTime::<Local>::from(time)
					.format(CTIME_FORMAT)
					.to_string()
			},
			Self::Strftime(format) => {
				// Handle a special case
				let custom_format = format.replace("%+", "%Y-%m-%d+%H:%M:%S%.f0");
				DateTime::<Local>::from(time)
					.format(&custom_format)
					.to_string()
			},
		};

		Ok(formatted.into())
	}
}

#[derive(Debug, PartialEq, Eq)]
enum PermissionsFormat {
	Octal,
	// trwxrwxrwx
	Symbolic,
}

/// A single % directive in a format string.
#[derive(Debug, PartialEq, Eq)]
enum FormatDirective {
	// %a, %Ak
	AccessTime(TimeFormat),
	// %b, %k
	Blocks { large_blocks: bool },
	// %c, %Ck
	ChangeTime(TimeFormat),
	// %d
	Depth,
	// %D
	Device,
	// %f
	Basename,
	// %F
	Filesystem,
	// %g, %G
	Group { as_name: bool },
	// %h
	Dirname,
	// %H
	StartingPoint,
	// %i
	Inode,
	// %l
	SymlinkTarget,
	// %m
	Permissions(PermissionsFormat),
	// %n
	HardlinkCount,
	// %p, %P
	Path { strip_starting_point: bool },
	// %s
	Size,
	// %S
	Sparseness,
	// %t, %Tk
	ModificationTime(TimeFormat),
	// %u, %U
	User { as_name: bool },
	// %y, %Y
	Type { follow_links: bool },
}

/// A component in a full format string.
#[derive(Debug, PartialEq, Eq)]
enum FormatComponent {
	Literal(String),
	Flush,
	Directive { directive: FormatDirective, width: Option<usize>, justify: Justify },
}

struct FormatStringParser<'a> {
	string: &'a str,
}

impl FormatStringParser<'_> {
	fn front(&self) -> Result<char, Box<dyn Error>> {
		self
			.string
			.chars()
			.next()
			.ok_or_else(|| "Unexpected EOF".into())
	}

	fn peek(&self, count: usize) -> Result<&str, Box<dyn Error>> {
		if self.string.len() < count {
			return Err("Unexpected EOF".into());
		}

		Ok(&self.string[0..count])
	}

	fn advance_one(&mut self) -> Result<char, Box<dyn Error>> {
		let c = self.front()?;
		self.string = &self.string[1..];
		Ok(c)
	}

	fn advance_by(&mut self, count: usize) -> Result<&str, Box<dyn Error>> {
		self.peek(count)?;

		let skipped = &self.string[0..count];
		self.string = &self.string[count..];
		Ok(skipped)
	}

	fn parse_escape_sequence(&mut self) -> Result<FormatComponent, Box<dyn Error>> {
		const OCTAL_LEN: usize = 3;
		const OCTAL_RADIX: u32 = 8;

		// Try parsing an octal sequence first.
		let first = self.front()?;
		if first.is_digit(OCTAL_RADIX)
			&& let Ok(code) = self.peek(OCTAL_LEN).and_then(|octal| {
				u32::from_str_radix(octal, OCTAL_RADIX).map_err(std::convert::Into::into)
			}) {
			// safe to unwrap: .peek() already succeeded above.
			let octal = self.advance_by(OCTAL_LEN).unwrap();
			return match char::from_u32(code) {
				Some(c) => Ok(FormatComponent::Literal(c.to_string())),
				None => Err(format!("Invalid character value: \\{octal}").into()),
			};
		}

		self.advance_one()?;

		if first == 'c' {
			Ok(FormatComponent::Flush)
		} else {
			let c = match first {
				'a' => "\x07",
				'b' => "\x08",
				'f' => "\x0C",
				'n' => "\n",
				'r' => "\r",
				't' => "\t",
				'v' => "\x0B",
				'0' => "\0",
				'\\' => "\\",
				c => return Err(format!("Invalid escape sequence: \\{c}").into()),
			};

			Ok(FormatComponent::Literal(c.to_string()))
		}
	}

	fn parse_format_width(&mut self) -> Option<usize> {
		let start = self.string;
		let mut digits = 0;

		while self.front().map(|c| c.is_ascii_digit()).unwrap_or(false) {
			digits += 1;
			// safe to unwrap: the front() check already succeeded above.
			self.advance_one().unwrap();
		}

		if digits > 0 {
			// safe to unwrap: we already know all the digits are valid due to
			// the above checks.
			Some((start[0..digits]).parse().unwrap())
		} else {
			None
		}
	}

	fn parse_time_specifier(&mut self, first: char) -> Result<TimeFormat, Box<dyn Error>> {
		match self.advance_one()? {
			'@' => Ok(TimeFormat::SinceEpoch),
			'S' => Ok(TimeFormat::Strftime("%S.%f0".to_string())),
			c => {
				// We can't store the parsed items inside TimeFormat, because the items
				// take a reference to the full format string, but we still try to parse
				// it here so that errors get caught early.
				let format = format!("%{c}");
				match StrftimeItems::new(&format).next() {
					None | Some(chrono::format::Item::Error) => {
						Err(format!("Invalid time specifier: %{first}{c}").into())
					},
					Some(_item) => Ok(TimeFormat::Strftime(format)),
				}
			},
		}
	}

	fn parse_format_specifier(&mut self) -> Result<FormatComponent, Box<dyn Error>> {
		let mut justify = Justify::Right;
		loop {
			match self.front()? {
				' ' => (),
				'-' => justify = Justify::Left,
				_ => break,
			}

			// safe to unwrap: .front() already succeeded above.
			self.advance_one().unwrap();
		}

		let width = self.parse_format_width();

		let first = self.advance_one()?;
		if first == '%' {
			return Ok(FormatComponent::Literal("%".to_owned()));
		}

		let directive = match first {
			'a' => FormatDirective::AccessTime(TimeFormat::Ctime),
			'A' => FormatDirective::AccessTime(self.parse_time_specifier(first)?),
			'b' => FormatDirective::Blocks { large_blocks: false },
			'c' => FormatDirective::ChangeTime(TimeFormat::Ctime),
			'C' => FormatDirective::ChangeTime(self.parse_time_specifier(first)?),
			'd' => FormatDirective::Depth,
			'D' => FormatDirective::Device,
			'f' => FormatDirective::Basename,
			'F' => FormatDirective::Filesystem,
			'g' => FormatDirective::Group { as_name: true },
			'G' => FormatDirective::Group { as_name: false },
			'h' => FormatDirective::Dirname,
			'H' => FormatDirective::StartingPoint,
			'k' => FormatDirective::Blocks { large_blocks: true },
			'i' => FormatDirective::Inode,
			'l' => FormatDirective::SymlinkTarget,
			'm' => FormatDirective::Permissions(PermissionsFormat::Octal),
			'M' => FormatDirective::Permissions(PermissionsFormat::Symbolic),
			'n' => FormatDirective::HardlinkCount,
			'p' => FormatDirective::Path { strip_starting_point: false },
			'P' => FormatDirective::Path { strip_starting_point: true },
			's' => FormatDirective::Size,
			'S' => FormatDirective::Sparseness,
			't' => FormatDirective::ModificationTime(TimeFormat::Ctime),
			'T' => FormatDirective::ModificationTime(self.parse_time_specifier(first)?),
			'u' => FormatDirective::User { as_name: true },
			'U' => FormatDirective::User { as_name: false },
			'y' => FormatDirective::Type { follow_links: false },
			'Y' => FormatDirective::Type { follow_links: true },
			// TODO: %Z
			_ => return Ok(FormatComponent::Literal(first.to_string())),
		};

		Ok(FormatComponent::Directive { directive, width, justify })
	}

	pub fn parse(&mut self) -> Result<FormatString, Box<dyn Error>> {
		let mut components = vec![];

		while let Some(i) = self.string.find(['%', '\\']) {
			if i > 0 {
				// safe to unwrap: i is an index into the string, so it cannot
				// be any shorter.
				let literal = self.advance_by(i).unwrap();
				if !literal.is_empty() {
					components.push(FormatComponent::Literal(literal.to_owned()));
				}
			}

			// safe to unwrap: we've only advanced as far as 'i', which is right
			// before the character it identified.
			let component = match self.advance_one().unwrap() {
				'\\' => self.parse_escape_sequence()?,
				'%' => self.parse_format_specifier()?,
				_ => panic!("{}", "Stopped at unexpected character: {self.string}"),
			};
			components.push(component);
		}

		if !self.string.is_empty() {
			components.push(FormatComponent::Literal(self.string.to_owned()));
		}

		Ok(FormatString { components })
	}
}

struct FormatString {
	components: Vec<FormatComponent>,
}

impl FormatString {
	fn parse(string: &str) -> Result<Self, Box<dyn Error>> {
		FormatStringParser { string }.parse()
	}
}

fn get_starting_point(file_info: &WalkEntry) -> &Path {
	file_info
		.display_path()
		.ancestors()
		.nth(file_info.depth())
		// safe to unwrap: the file's depth should never be longer than its path
		// (...right?).
		.unwrap()
}

fn format_non_link_file_type(file_type: FileType) -> char {
	match file_type {
		FileType::Regular => 'f',
		FileType::Directory => 'd',
		FileType::BlockDevice => 'b',
		FileType::CharDevice => 'c',
		FileType::Fifo => 'p',
		FileType::Socket => 's',
		_ => 'U',
	}
}

fn format_directive<'entry>(
	file_info: &'entry WalkEntry,
	directive: &FormatDirective,
) -> Result<Cow<'entry, str>, Box<dyn Error>> {
	let meta = || file_info.metadata();

	// NOTE ON QUOTING:
	// GNU find's man page claims that several directives that print names (like
	// %f) are quoted like ls; however, I could not reproduce this at all in
	// practice, thus the set of rules is undoubtedly very different (if this is
	// still done at all).

	let res: Cow<'entry, str> = match directive {
		FormatDirective::AccessTime(tf) => tf.apply(meta()?.accessed()?)?,

		FormatDirective::Basename => file_info.file_name().to_string_lossy(),

		FormatDirective::Blocks { large_blocks } => {
			#[cfg(unix)]
			let blocks = meta()?.blocks();
			#[cfg(not(unix))]
			// Estimate using a ceiling division by the block size.
			let blocks = (meta()?.len() + STANDARD_BLOCK_SIZE - 1) / STANDARD_BLOCK_SIZE;

			// GNU find says it returns the number of 512-byte blocks for %b,
			// but in reality it just returns the number of blocks, *regardless
			// of their size on the filesystem*. That behavior is copied here,
			// even though it's arguably not 100% correct.
			if *large_blocks {
				// Ceiling divide in half.
				blocks.div_ceil(2)
			} else {
				blocks
			}
			.to_string()
			.into()
		},

		#[cfg(not(unix))]
		FormatDirective::ChangeTime(tf) => tf.apply(meta()?.modified()?)?,
		#[cfg(unix)]
		FormatDirective::ChangeTime(tf) => {
			use std::time::Duration;

			let meta = meta()?;
			let ctime = SystemTime::UNIX_EPOCH
				+ Duration::from_secs(meta.ctime() as u64)
				+ Duration::from_nanos(meta.ctime_nsec() as u64);
			tf.apply(ctime)?
		},

		FormatDirective::Depth => file_info.depth().to_string().into(),

		#[cfg(not(unix))]
		FormatDirective::Device => "0".into(),
		#[cfg(unix)]
		FormatDirective::Device => meta()?.dev().to_string().into(),

		// GNU find's behavior for this is a bit...odd:
		// - Both the root directory and the paths immediately underneath return an empty string
		// - Any path without any slashes (i.e. relative to cwd) returns "."
		// - "." also returns "."
		// - ".." returns "." (???)
		// These are all (thankfully) documented on the find(1) man page.
		FormatDirective::Dirname => match file_info.display_path().parent() {
			None => "".into(),
			Some(p) if p == Path::new("/") => "".into(),
			Some(p) if p == Path::new("") => ".".into(),
			Some(parent) => parent.to_string_lossy(),
		},

		#[cfg(not(unix))]
		FormatDirective::Filesystem => "".into(),
		#[cfg(unix)]
		FormatDirective::Filesystem => {
			let dev_id = meta()?.dev().to_string();
			let fs_list = uucore::fsext::read_fs_list().expect("Could not find the filesystem info");
			fs_list
				.into_iter()
				.find(|fs| fs.dev_id == dev_id)
				.map_or_else(String::new, |fs| fs.fs_type)
				.into()
		},

		#[cfg(not(unix))]
		FormatDirective::Group { .. } => "0".into(),
		#[cfg(unix)]
		FormatDirective::Group { as_name } => {
			let gid = meta()?.gid();
			if *as_name {
				uucore::entries::gid2grp(gid).unwrap_or_else(|_| gid.to_string())
			} else {
				gid.to_string()
			}
			.into()
		},

		#[cfg(not(unix))]
		FormatDirective::HardlinkCount => "0".into(),
		#[cfg(unix)]
		FormatDirective::HardlinkCount => meta()?.nlink().to_string().into(),

		#[cfg(not(unix))]
		FormatDirective::Inode => "0".into(),
		#[cfg(unix)]
		FormatDirective::Inode => meta()?.ino().to_string().into(),

		FormatDirective::ModificationTime(tf) => tf.apply(meta()?.modified()?)?,

		FormatDirective::Path { strip_starting_point } => file_info
			.display_path()
			.strip_prefix(if *strip_starting_point {
				get_starting_point(file_info)
			} else {
				Path::new("")
			})
			// safe to unwrap: the prefix is derived *from* the path to begin
			// with, so it cannot be invalid.
			.unwrap()
			.to_string_lossy(),

		FormatDirective::Permissions(PermissionsFormat::Symbolic) => {
			uucore::fs::display_permissions(meta()?, true).into()
		},
		#[cfg(not(unix))]
		FormatDirective::Permissions(PermissionsFormat::Octal) => "777".into(),
		#[cfg(unix)]
		FormatDirective::Permissions(PermissionsFormat::Octal) => {
			format!("{:>03o}", meta()?.mode() & 0o777).into()
		},

		FormatDirective::Size => meta()?.len().to_string().into(),

		#[cfg(not(unix))]
		FormatDirective::Sparseness => "1.0".into(),
		#[cfg(unix)]
		FormatDirective::Sparseness => {
			let meta = meta()?;

			if meta.len() > 0 {
				format!(
					"{:.1}",
					// GNU find hardcodes a block size of 512 bytes, regardless
					// of the true filesystem block size.
					(meta.blocks() * STANDARD_BLOCK_SIZE) as f64 / (meta.len() as f64)
				)
				.into()
			} else {
				"1.0".into()
			}
		},

		FormatDirective::StartingPoint => get_starting_point(file_info).to_string_lossy(),

		FormatDirective::SymlinkTarget => {
			if file_info.path_is_symlink() {
				fs::read_link(file_info.path())?
					.to_string_lossy()
					.into_owned()
					.into()
			} else {
				"".into()
			}
		},

		FormatDirective::Type { follow_links } => if file_info.path_is_symlink() {
			if *follow_links {
				match file_info.path().metadata().map_err(WalkError::from) {
					Ok(meta) => format_non_link_file_type(meta.file_type().into()),
					Err(e) if e.is_not_found() => 'N',
					Err(e) if e.is_loop() => 'L',
					Err(_) => '?',
				}
			} else {
				'l'
			}
		} else {
			format_non_link_file_type(file_info.file_type())
		}
		.to_string()
		.into(),

		#[cfg(not(unix))]
		FormatDirective::User { .. } => "0".into(),
		#[cfg(unix)]
		FormatDirective::User { as_name } => {
			let uid = meta()?.uid();
			if *as_name {
				uucore::entries::uid2usr(uid).unwrap_or_else(|_| uid.to_string())
			} else {
				uid.to_string()
			}
			.into()
		},
	};

	Ok(res)
}

/// This matcher prints information about its files to stdout, following GNU
/// find's printf syntax.
pub struct Printf {
	format:      FormatString,
	output_file: Option<File>,
}

impl Printf {
	pub fn new(format: &str, output_file: Option<File>) -> Result<Self, Box<dyn Error>> {
		Ok(Self { format: FormatString::parse(format)?, output_file })
	}

	fn print(&self, file_info: &WalkEntry, mut out: impl Write) {
		for component in &self.format.components {
			match component {
				FormatComponent::Literal(literal) => write!(out, "{literal}").unwrap(),
				FormatComponent::Flush => out.flush().unwrap(),
				FormatComponent::Directive { directive, width, justify } => {
					match format_directive(file_info, directive) {
						Ok(content) => {
							if let Some(width) = width {
								match justify {
									Justify::Left => {
										write!(out, "{content:<width$}").unwrap();
									},
									Justify::Right => {
										write!(out, "{content:>width$}").unwrap();
									},
								}
							} else {
								write!(out, "{content}").unwrap();
							}
						},
						Err(e) => {
							let _ = writeln!(
								pi_uutils_ctx::stderr(),
								"Error processing '{}': {}",
								file_info.path().to_string_lossy(),
								e
							);
							break;
						},
					}
				},
			}
		}
	}
}

impl Matcher for Printf {
	fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		if let Some(file) = &self.output_file {
			self.print(file_info, file);
		} else {
			self.print(file_info, &mut *matcher_io.deps.get_output().borrow_mut());
		}

		true
	}

	fn has_side_effects(&self) -> bool {
		true
	}
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::os::unix::fs::{PermissionsExt, symlink};
	#[cfg(windows)]
	use std::os::windows::fs::{symlink_dir, symlink_file};
	use std::{fs::File, io::ErrorKind};

	use chrono::{Duration, TimeZone};
	use tempfile::Builder;

	use super::*;
	use crate::find::{
		matchers::tests::get_dir_entry_for,
		tests::{FakeDependencies, fix_up_slashes},
	};

	#[test]
	fn test_parse_basics() {
		assert_eq!(FormatString::parse("").unwrap().components, vec![]);
		assert_eq!(FormatString::parse("test stuff").unwrap().components, vec![
			FormatComponent::Literal("test stuff".to_owned()),
		]);
	}

	#[test]
	fn test_parse_escapes() {
		assert_eq!(
			FormatString::parse("abc\\0\\t\\n\\\\\\141de\\cf")
				.unwrap()
				.components,
			vec![
				FormatComponent::Literal("abc".to_owned()),
				FormatComponent::Literal("\0".to_owned()),
				FormatComponent::Literal("\t".to_owned()),
				FormatComponent::Literal("\n".to_owned()),
				FormatComponent::Literal("\\".to_owned()),
				FormatComponent::Literal("a".to_owned()),
				FormatComponent::Literal("de".to_owned()),
				FormatComponent::Flush,
				FormatComponent::Literal("f".to_owned())
			]
		);

		assert!(FormatString::parse("\\X").is_err());
		assert!(FormatString::parse("\\").is_err());
	}

	#[test]
	fn test_parse_formatting() {
		fn unaligned_directive(directive: FormatDirective) -> FormatComponent {
			FormatComponent::Directive { directive, width: None, justify: Justify::Right }
		}

		assert_eq!(
			FormatString::parse("%%%a%A@%Ak%b%c%C@%CH%d%DTEST%f%F%g%G%h%H")
				.unwrap()
				.components,
			vec![
				FormatComponent::Literal("%".to_owned()),
				unaligned_directive(FormatDirective::AccessTime(TimeFormat::Ctime)),
				unaligned_directive(FormatDirective::AccessTime(TimeFormat::SinceEpoch)),
				unaligned_directive(FormatDirective::AccessTime(TimeFormat::Strftime(
					"%k".to_string()
				))),
				unaligned_directive(FormatDirective::Blocks { large_blocks: false }),
				unaligned_directive(FormatDirective::ChangeTime(TimeFormat::Ctime)),
				unaligned_directive(FormatDirective::ChangeTime(TimeFormat::SinceEpoch)),
				unaligned_directive(FormatDirective::ChangeTime(TimeFormat::Strftime(
					"%H".to_string()
				))),
				unaligned_directive(FormatDirective::Depth),
				unaligned_directive(FormatDirective::Device),
				FormatComponent::Literal("TEST".to_owned()),
				unaligned_directive(FormatDirective::Basename),
				unaligned_directive(FormatDirective::Filesystem),
				unaligned_directive(FormatDirective::Group { as_name: true }),
				unaligned_directive(FormatDirective::Group { as_name: false }),
				unaligned_directive(FormatDirective::Dirname),
				unaligned_directive(FormatDirective::StartingPoint),
			]
		);

		assert_eq!(
			FormatString::parse("%i%k%l%m%M%n%p%P%s%S%t%T@%Td%u%U%y%Y%?")
				.unwrap()
				.components,
			vec![
				unaligned_directive(FormatDirective::Inode),
				unaligned_directive(FormatDirective::Blocks { large_blocks: true }),
				unaligned_directive(FormatDirective::SymlinkTarget),
				unaligned_directive(FormatDirective::Permissions(PermissionsFormat::Octal)),
				unaligned_directive(FormatDirective::Permissions(PermissionsFormat::Symbolic)),
				unaligned_directive(FormatDirective::HardlinkCount),
				unaligned_directive(FormatDirective::Path { strip_starting_point: false }),
				unaligned_directive(FormatDirective::Path { strip_starting_point: true }),
				unaligned_directive(FormatDirective::Size),
				unaligned_directive(FormatDirective::Sparseness),
				unaligned_directive(FormatDirective::ModificationTime(TimeFormat::Ctime)),
				unaligned_directive(FormatDirective::ModificationTime(TimeFormat::SinceEpoch)),
				unaligned_directive(FormatDirective::ModificationTime(TimeFormat::Strftime(
					"%d".to_string()
				))),
				unaligned_directive(FormatDirective::User { as_name: true }),
				unaligned_directive(FormatDirective::User { as_name: false }),
				unaligned_directive(FormatDirective::Type { follow_links: false }),
				unaligned_directive(FormatDirective::Type { follow_links: true }),
				FormatComponent::Literal("?".to_owned()),
			]
		);

		assert!(FormatString::parse("%").is_err());
		assert!(FormatString::parse("%A!").is_err());
	}

	#[test]
	fn test_parse_formatting_justified() {
		assert_eq!(
			FormatString::parse("%d%-s%5S%-12n% 3f% -- 4i")
				.unwrap()
				.components,
			vec![
				FormatComponent::Directive {
					directive: FormatDirective::Depth,
					justify:   Justify::Right,
					width:     None,
				},
				FormatComponent::Directive {
					directive: FormatDirective::Size,
					justify:   Justify::Left,
					width:     None,
				},
				FormatComponent::Directive {
					directive: FormatDirective::Sparseness,
					justify:   Justify::Right,
					width:     Some(5),
				},
				FormatComponent::Directive {
					directive: FormatDirective::HardlinkCount,
					justify:   Justify::Left,
					width:     Some(12),
				},
				FormatComponent::Directive {
					directive: FormatDirective::Basename,
					justify:   Justify::Right,
					width:     Some(3),
				},
				FormatComponent::Directive {
					directive: FormatDirective::Inode,
					justify:   Justify::Left,
					width:     Some(4),
				},
			]
		);
	}

	#[test]
	fn test_printf_justified() {
		let file_info = get_dir_entry_for("test_data/simple", "abbbc");
		let deps = FakeDependencies::new();

		let matcher = Printf::new("%f,%7f,%-7f", None).unwrap();
		assert!(matcher.matches(&file_info, &mut deps.new_matcher_io()));
		assert_eq!("abbbc,  abbbc,abbbc  ", deps.get_output_as_string());
	}

	#[test]
	fn test_printf_paths() {
		let file_info = get_dir_entry_for("test_data/simple", "abbbc");
		let deps = FakeDependencies::new();

		let matcher = Printf::new("%h %H %p %P", None).unwrap();
		assert!(matcher.matches(&file_info, &mut deps.new_matcher_io()));
		assert_eq!(
			format!(
				"{} {} {} {}",
				fix_up_slashes("test_data/simple"),
				fix_up_slashes("test_data/simple"),
				fix_up_slashes("test_data/simple/abbbc"),
				fix_up_slashes("abbbc")
			),
			deps.get_output_as_string()
		);
	}

	#[test]
	fn test_printf_paths_in_subdir() {
		let file_info = get_dir_entry_for("test_data/simple", "subdir/ABBBC");
		let deps = FakeDependencies::new();

		let matcher = Printf::new("%h %H %p %P", None).unwrap();
		assert!(matcher.matches(&file_info, &mut deps.new_matcher_io()));
		assert_eq!(
			format!(
				"{} {} {} {}",
				fix_up_slashes("test_data/simple/subdir"),
				fix_up_slashes("test_data/simple"),
				fix_up_slashes("test_data/simple/subdir/ABBBC"),
				fix_up_slashes("subdir/ABBBC")
			),
			deps.get_output_as_string()
		);
	}

	#[test]
	fn test_printf_depth() {
		let file_info_1 = get_dir_entry_for("test_data/depth/1", "f1");
		let file_info_2 = get_dir_entry_for("test_data/depth/1", "2/f2");
		let deps = FakeDependencies::new();

		let matcher = Printf::new("%d.", None).unwrap();
		assert!(matcher.matches(&file_info_1, &mut deps.new_matcher_io()));
		assert!(matcher.matches(&file_info_2, &mut deps.new_matcher_io()));
		assert_eq!("1.2.", deps.get_output_as_string());
	}

	#[test]
	fn test_printf_basic_types() {
		let file_info_f = get_dir_entry_for("test_data/simple", "abbbc");
		let file_info_d = get_dir_entry_for("test_data/simple", "subdir");
		let deps = FakeDependencies::new();

		let matcher = Printf::new("%y", None).unwrap();
		assert!(matcher.matches(&file_info_f, &mut deps.new_matcher_io()));
		assert!(matcher.matches(&file_info_d, &mut deps.new_matcher_io()));
		assert_eq!("fd", deps.get_output_as_string());
	}

	#[test]
	#[cfg(unix)]
	fn test_printf_special_types() {
		use std::os::unix::net::UnixListener;

		use nix::sys::stat::Mode;

		let temp_dir = Builder::new().prefix("example").tempdir().unwrap();
		let temp_dir_path = temp_dir.path().to_string_lossy();

		let fifo_name = "fifo";
		let fifo_path = temp_dir.path().join(fifo_name);
		nix::unistd::mkfifo(&fifo_path, Mode::from_bits(0o644).unwrap()).unwrap();

		let socket_name = "socket";
		let socket_path = temp_dir.path().join(socket_name);
		UnixListener::bind(socket_path).unwrap();

		let fifo_info = get_dir_entry_for(&temp_dir_path, fifo_name);
		let socket_info = get_dir_entry_for(&temp_dir_path, socket_name);
		let deps = FakeDependencies::new();

		let matcher = Printf::new("%y", None).unwrap();
		assert!(matcher.matches(&fifo_info, &mut deps.new_matcher_io()));
		assert!(matcher.matches(&socket_info, &mut deps.new_matcher_io()));
		assert_eq!("ps", deps.get_output_as_string());
	}

	#[test]
	fn test_printf_size() {
		let file_info = get_dir_entry_for("test_data/size", "512bytes");
		let deps = FakeDependencies::new();

		let matcher = Printf::new("%s", None).unwrap();
		assert!(matcher.matches(&file_info, &mut deps.new_matcher_io()));
		assert_eq!("512", deps.get_output_as_string());
	}

	#[test]
	fn test_printf_symlinks() {
		#[cfg(unix)]
		{
			if let Err(e) = symlink("abbbc", "test_data/links/link-f") {
				assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {e:?}");
			}
			if let Err(e) = symlink("subdir", "test_data/links/link-d") {
				assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {e:?}");
			}
			if let Err(e) = symlink("missing", "test_data/links/link-missing") {
				assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {e:?}");
			}
			if let Err(e) = symlink("abbbc/x", "test_data/links/link-notdir") {
				assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {e:?}");
			}
			if let Err(e) = symlink("link-loop", "test_data/links/link-loop") {
				assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {e:?}");
			}
		}
		#[cfg(windows)]
		{
			if let Err(e) = symlink_file("abbbc", "test_data/links/link-f") {
				assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {:?}", e);
			}
			if let Err(e) = symlink_dir("subdir", "test_data/links/link-d") {
				assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {:?}", e);
			}
			if let Err(e) = symlink_file("missing", "test_data/links/link-missing") {
				assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {:?}", e);
			}
			if let Err(e) = symlink_file("abbbc/x", "test_data/links/link-notdir") {
				assert!(e.kind() == ErrorKind::AlreadyExists, "Failed to create sym link: {:?}", e);
			}
		}

		let regular_file = get_dir_entry_for("test_data/simple", "abbbc");
		let link_f = get_dir_entry_for("test_data/links", "link-f");
		let link_d = get_dir_entry_for("test_data/links", "link-d");
		let link_missing = get_dir_entry_for("test_data/links", "link-missing");
		let link_notdir = get_dir_entry_for("test_data/links", "link-notdir");
		#[cfg(unix)]
		let link_loop = get_dir_entry_for("test_data/links", "link-loop");

		let deps = FakeDependencies::new();

		let matcher = Printf::new("%y %Y %l\n", None).unwrap();
		assert!(matcher.matches(&regular_file, &mut deps.new_matcher_io()));
		assert!(matcher.matches(&link_f, &mut deps.new_matcher_io()));
		assert!(matcher.matches(&link_d, &mut deps.new_matcher_io()));
		assert!(matcher.matches(&link_missing, &mut deps.new_matcher_io()));
		assert!(matcher.matches(&link_notdir, &mut deps.new_matcher_io()));
		#[cfg(unix)]
		assert!(matcher.matches(&link_loop, &mut deps.new_matcher_io()));
		assert_eq!(
			vec![
				"f f ",
				"l f abbbc",
				"l d subdir",
				"l N missing",
				// We can't detect ENOTDIR on non-unix platforms yet.
				#[cfg(not(unix))]
				"l ? abbbc/x",
				#[cfg(unix)]
				"l N abbbc/x",
				#[cfg(unix)]
				"l L link-loop",
			],
			deps.get_output_as_string().lines().collect::<Vec<_>>()
		);
	}

	#[test]
	fn test_printf_times() {
		let temp_dir = Builder::new().prefix("example").tempdir().unwrap();
		let temp_dir_path = temp_dir.path().to_string_lossy();
		let new_file_name = "newFile";
		let file_path = temp_dir.path().join(new_file_name);
		File::create(&file_path).expect("create temp file");

		let mtime = chrono::Local
			.with_ymd_and_hms(2000, 1, 15, 9, 30, 21)
			.unwrap()
			+ Duration::nanoseconds(2_000_000);
		filetime::set_file_mtime(
			&file_path,
			filetime::FileTime::from_unix_time(mtime.timestamp(), mtime.timestamp_subsec_nanos()),
		)
		.expect("set temp file mtime");

		let file_info = get_dir_entry_for(&temp_dir_path, new_file_name);
		let deps = FakeDependencies::new();

		let matcher = Printf::new("%t,%T@,%TF", None).unwrap();
		assert!(matcher.matches(&file_info, &mut deps.new_matcher_io()));
		assert_eq!(
			format!("Sat Jan 15 09:30:21.0020000000 2000,{}.0020000000,2000-01-15", mtime.timestamp()),
			deps.get_output_as_string()
		);
	}

	#[test]
	#[cfg(unix)]
	fn test_printf_user_group() {
		let temp_dir = Builder::new().prefix("example").tempdir().unwrap();
		let temp_dir_path = temp_dir.path().to_string_lossy();
		let new_file_name = "newFile";
		File::create(temp_dir.path().join(new_file_name)).expect("create temp file");

		let uid = unsafe { uucore::libc::getuid() };
		let user = uucore::entries::uid2usr(uid).unwrap_or(uid.to_string());

		let gid = unsafe { uucore::libc::getgid() };
		let group = uucore::entries::gid2grp(gid).unwrap_or(gid.to_string());

		let file_info = get_dir_entry_for(&temp_dir_path, new_file_name);
		let deps = FakeDependencies::new();

		let matcher = Printf::new("%u %U %g %G", None).unwrap();
		assert!(matcher.matches(&file_info, &mut deps.new_matcher_io()));
		assert_eq!(format!("{user} {uid} {group} {gid}"), deps.get_output_as_string());
	}

	#[test]
	#[cfg(unix)]
	fn test_printf_permissions() {
		use std::fs::File;

		let temp_dir = Builder::new().prefix("example").tempdir().unwrap();
		let temp_dir_path = temp_dir.path().to_string_lossy();
		let new_file_name = "newFile";
		let file = File::create(temp_dir.path().join(new_file_name)).expect("create temp file");

		let mut perms = file.metadata().unwrap().permissions();
		perms.set_mode(0o755);
		file.set_permissions(perms).unwrap();

		let file_info = get_dir_entry_for(&temp_dir_path, new_file_name);
		let deps = FakeDependencies::new();

		let matcher = Printf::new("%m %M", None).unwrap();
		assert!(matcher.matches(&file_info, &mut deps.new_matcher_io()));
		assert_eq!("755 -rwxr-xr-x", deps.get_output_as_string());
	}
}
