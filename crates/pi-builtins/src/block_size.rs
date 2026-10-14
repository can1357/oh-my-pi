//! Output block sizes for `du` and `df`: `-B`/`--block-size`, `-k`, `-m`,
//! `-h`, `--si`, and the `{DU,DF}_BLOCK_SIZE`, `BLOCK_SIZE`, `BLOCKSIZE`, and
//! `POSIXLY_CORRECT` environment, read from the shell (`host.var`).
//!
//! Parses block-size specs: a leading
//! `'` groups digits, `human-readable`/`si` (or a unique prefix) select
//! autoscaling, and a spec that is only a unit (`K`, `KB`, `KiB`) also prints
//! that unit after every value.

#![allow(dead_code, reason = "du and df each use a subset")]

use clap::ArgMatches;
use uucore::{
	display::Quotable,
	format::human::{SizeFormat, human_readable},
	parser::parse_size::{ParseSizeError, Parser, allow_list_with_all_suffixes},
};

use crate::{host::Host, locale::NumericSymbols};

/// The units GNU accepts in a block-size spec (no `b`, `R`, or `Q`).
const UNITS: &str = "eEgGkKmMpPtTyYzZ";

/// A scaling option, for [`BlockSize::from_matches`]: which clap argument
/// means what.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Scale {
	/// `-B SPEC`/`--block-size=SPEC`: the argument's value is the spec.
	Spec,
	/// `-h`: powers of 1024 with a unit letter.
	Human,
	/// `--si` (df `-H`): powers of 1000 with a unit letter.
	Si,
	/// `-k`: 1024-byte blocks.
	Kilo,
	/// `-m`: 1 MiB blocks.
	Mega,
	/// `-b`: bytes.
	Bytes,
}

/// Why a block-size spec was rejected; [`BlockSizeError::message`] words it
/// like GNU's `xstrtol_fatal`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BlockSizeError {
	/// Not a number (`x`), or zero.
	Invalid,
	/// A number followed by something other than a unit (`5x`, `1Q`).
	InvalidSuffix,
	/// More than `u64::MAX` bytes.
	TooLarge,
}

impl BlockSizeError {
	/// `invalid OPTION argument 'VALUE'` and friends; `option` is spelled with
	/// its dashes (`--block-size`, `-B`).
	pub fn message(self, option: &str, value: &str) -> String {
		let value = value.quote();
		match self {
			Self::Invalid => format!("invalid {option} argument {value}"),
			Self::InvalidSuffix => format!("invalid suffix in {option} argument {value}"),
			Self::TooLarge => format!("{option} argument {value} too large"),
		}
	}
}

impl From<ParseSizeError> for BlockSizeError {
	fn from(error: ParseSizeError) -> Self {
		match error {
			ParseSizeError::InvalidSuffix(_) => Self::InvalidSuffix,
			ParseSizeError::SizeTooBig(_) => Self::TooLarge,
			ParseSizeError::ParseFailure(_) | ParseSizeError::PhysicalMem(_) => Self::Invalid,
		}
	}
}

/// The unit a unit-only spec appends to every value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Unit {
	base_1024: bool,
	/// Append `B` (`KB` → `kB`, `KiB` → `KiB`).
	bytes:     bool,
}

/// How sizes are scaled and written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BlockSize {
	bytes:        u64,
	human:        Option<HumanScale>,
	group_digits: bool,
	unit:         Option<Unit>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HumanScale {
	Binary,
	Decimal,
}

impl BlockSize {
	/// `-h`: autoscaled powers of 1024.
	pub const HUMAN: Self = Self { bytes: 1, human: Some(HumanScale::Binary), group_digits: false, unit: None };
	/// `--si`: autoscaled powers of 1000.
	pub const SI: Self = Self { bytes: 1, human: Some(HumanScale::Decimal), group_digits: false, unit: None };

	/// Plain blocks of `bytes` bytes (`-k` is `of(1024)`, `-b` is `of(1)`).
	pub const fn of(bytes: u64) -> Self {
		Self { bytes, human: None, group_digits: false, unit: None }
	}

	/// The default unit: 512 bytes under `POSIXLY_CORRECT`, else 1024.
	pub fn default_for(host: &Host) -> Self {
		Self::of(if host.var("POSIXLY_CORRECT").is_some() { 512 } else { 1024 })
	}

	/// Parses a `--block-size` spec.
	///
	/// # Errors
	///
	/// [`BlockSizeError`] for a spec GNU rejects, including zero.
	pub fn parse(spec: &str) -> Result<Self, BlockSizeError> {
		let (group_digits, spec) = match spec.strip_prefix('\'') {
			Some(rest) => (true, rest),
			None => (false, spec),
		};
		let named = ["human-readable", "si"];
		let matching: Vec<&str> = named.iter().copied().filter(|name| name.starts_with(spec)).collect();
		let keyword = named
			.iter()
			.copied()
			.find(|name| *name == spec)
			.or_else(|| (matching.len() == 1).then(|| matching[0]));
		if let Some(keyword) = keyword
			&& !spec.is_empty()
		{
			let human = if keyword == "si" { Self::SI } else { Self::HUMAN };
			return Ok(Self { group_digits, ..human });
		}
		// `strtoumax` skips leading blanks and takes a `+` sign.
		let number = spec.trim_start();
		let number = number.strip_prefix('+').unwrap_or(number);
		let allow_list = allow_list_with_all_suffixes(UNITS);
		let allow_list: Vec<&str> = allow_list.iter().map(String::as_str).collect();
		let bytes = Parser::default().with_allow_list(&allow_list).parse_u64(number)?;
		if bytes == 0 {
			return Err(BlockSizeError::Invalid);
		}
		// A spec with no number before its unit also prints the unit.
		let unit = (!number.starts_with(|c: char| c.is_ascii_digit())).then(|| Unit {
			bytes:     spec.ends_with('B'),
			base_1024: !spec.ends_with('B') || spec.ends_with("iB"),
		});
		Ok(Self { bytes, human: None, group_digits, unit })
	}

	/// The block size the environment selects: the first set of
	/// `utility_var` (`DU_BLOCK_SIZE`, `DF_BLOCK_SIZE`), `BLOCK_SIZE`, and
	/// `BLOCKSIZE`, else [`BlockSize::default_for`]. A set but invalid value
	/// falls back to the default, except that a bad unit keeps its number
	/// (`10X` is 10), as in GNU.
	pub fn from_env(host: &Host, utility_var: &str) -> Self {
		let Some(spec) = [utility_var, "BLOCK_SIZE", "BLOCKSIZE"]
			.into_iter()
			.find_map(|key| host.var(key))
		else {
			return Self::default_for(host);
		};
		match Self::parse(spec) {
			Ok(size) => size,
			Err(BlockSizeError::InvalidSuffix) => (1..spec.len())
				.rev()
				.filter(|end| spec.is_char_boundary(*end))
				.find_map(|end| Parser::default().with_allow_list(&[]).parse_u64(&spec[..end]).ok())
				.filter(|bytes| *bytes != 0)
				.map_or_else(|| Self::default_for(host), Self::of),
			Err(BlockSizeError::TooLarge) => Self::of(u64::MAX),
			Err(BlockSizeError::Invalid) => Self::default_for(host),
		}
	}

	/// Resolves the scaling options in `matches`, the last one given winning,
	/// else [`BlockSize::from_env`]. `options` maps clap argument ids to
	/// their meaning; the command needs `args_override_self(true)` so a
	/// repeated flag reports its last position.
	///
	/// # Errors
	///
	/// The rejected `--block-size` spec, with its error.
	pub fn from_matches(
		matches: &ArgMatches,
		options: &[(&str, Scale)],
		host: &Host,
		utility_var: &str,
	) -> Result<Self, (BlockSizeError, String)> {
		let last = options
			.iter()
			.filter(|(id, _)| matches.value_source(id) == Some(clap::parser::ValueSource::CommandLine))
			.filter_map(|(id, scale)| Some((matches.indices_of(id)?.next_back()?, *id, *scale)))
			.max_by_key(|(index, ..)| *index);
		let Some((_, id, scale)) = last else {
			return Ok(Self::from_env(host, utility_var));
		};
		Ok(match scale {
			Scale::Spec => {
				let spec = matches.get_one::<String>(id).map_or("", String::as_str);
				Self::parse(spec).map_err(|error| (error, spec.to_owned()))?
			},
			Scale::Human => Self::HUMAN,
			Scale::Si => Self::SI,
			Scale::Kilo => Self::of(1024),
			Scale::Mega => Self::of(1024 * 1024),
			Scale::Bytes => Self::of(1),
		})
	}

	/// Bytes per output unit (1 for `-h`/`--si`).
	pub const fn bytes(&self) -> u64 {
		self.bytes
	}

	/// Whether sizes autoscale (`-h`, `--si`).
	pub const fn is_human(&self) -> bool {
		self.human.is_some()
	}

	/// The same formatting with `bytes` per unit; `du --inodes` prints counts
	/// with a block size of 1.
	pub const fn with_bytes(self, bytes: u64) -> Self {
		Self { bytes, ..self }
	}

	/// Writes `n` bytes in this unit: autoscaled for `-h`/`--si`, otherwise
	/// rounded up to whole blocks, digits grouped with the locale's thousands
	/// separator for a `'` spec, and the spec's unit appended.
	pub fn format(&self, n: u64, symbols: NumericSymbols) -> String {
		let mut out = match self.human {
			Some(scale) => {
				let format = match scale {
					HumanScale::Binary => SizeFormat::Binary,
					HumanScale::Decimal => SizeFormat::Decimal,
				};
				let text = human_readable(n, format);
				if symbols.decimal_point == b'.' {
					text
				} else {
					text.replace('.', char::from(symbols.decimal_point).encode_utf8(&mut [0; 4]))
				}
			},
			None => n.div_ceil(self.bytes).to_string(),
		};
		if self.group_digits
			&& let Some(separator) = symbols.thousands_sep
		{
			out = group_digits(&out, separator);
		}
		if let Some(unit) = self.unit {
			out.push_str(&unit_suffix(self.bytes, unit));
		}
		out
	}
}

/// Inserts `separator` between groups of three in the leading digits.
fn group_digits(text: &str, separator: u8) -> String {
	let digits = text.bytes().take_while(u8::is_ascii_digit).count();
	let separator = char::from(separator);
	let mut out = String::with_capacity(text.len() + digits / 3);
	for (i, digit) in text[..digits].chars().enumerate() {
		if i != 0 && (digits - i) % 3 == 0 {
			out.push(separator);
		}
		out.push(digit);
	}
	out.push_str(&text[digits..]);
	out
}

/// gnulib's suffix for a unit-only spec: the power of the base that reaches
/// `bytes`, `k` for a single power of 1000, then `iB`/`B` as spelled.
fn unit_suffix(bytes: u64, unit: Unit) -> String {
	const LETTERS: &[u8; 10] = b"KMGTPEZYRQ";
	let base: u128 = if unit.base_1024 { 1024 } else { 1000 };
	let mut exponent = 0;
	let mut power: u128 = 1;
	while power < u128::from(bytes) && exponent < LETTERS.len() {
		exponent += 1;
		power *= base;
	}
	let mut suffix = String::new();
	if exponent == 1 && !unit.base_1024 {
		suffix.push('k');
	} else if exponent > 0 {
		suffix.push(char::from(LETTERS[exponent - 1]));
	}
	if unit.bytes {
		if unit.base_1024 && exponent > 0 {
			suffix.push('i');
		}
		suffix.push('B');
	}
	suffix
}

#[cfg(test)]
mod tests {
	use super::*;

	const C: NumericSymbols = NumericSymbols::C;

	#[test]
	fn specs_parse_to_bytes_and_units() {
		assert_eq!(BlockSize::parse("1K").unwrap().format(1025, C), "2");
		assert_eq!(BlockSize::parse("K").unwrap().format(311_296, C), "304K");
		assert_eq!(BlockSize::parse("KB").unwrap().format(319_488, C), "320kB");
		assert_eq!(BlockSize::parse("KiB").unwrap().format(311_296, C), "304KiB");
		assert_eq!(BlockSize::parse("MB").unwrap().format(1, C), "1MB");
		assert_eq!(BlockSize::parse("0x10").unwrap().bytes(), 16);
		assert_eq!(BlockSize::parse(" +0x10").unwrap().format(32, C), "2");
		assert_eq!(BlockSize::parse("hum"), Ok(BlockSize::HUMAN));
		assert_eq!(BlockSize::parse("si"), Ok(BlockSize::SI));
		assert_eq!(BlockSize::parse("'1").unwrap().format(315_392, NumericSymbols { decimal_point: b',', thousands_sep: Some(b'.') }), "315.392");
		assert_eq!(BlockSize::parse("'1").unwrap().format(315_392, C), "315392");
	}

	#[test]
	fn rejected_specs_say_why() {
		assert_eq!(BlockSize::parse("0"), Err(BlockSizeError::Invalid));
		assert_eq!(BlockSize::parse("x"), Err(BlockSizeError::Invalid));
		assert_eq!(BlockSize::parse("5x"), Err(BlockSizeError::InvalidSuffix));
		assert_eq!(BlockSize::parse("1Q"), Err(BlockSizeError::InvalidSuffix));
		assert_eq!(BlockSize::parse("99999999999999999999"), Err(BlockSizeError::TooLarge));
		assert_eq!(BlockSizeError::Invalid.message("-B", "0"), "invalid -B argument '0'");
		assert_eq!(BlockSizeError::InvalidSuffix.message("--block-size", "5x"), "invalid suffix in --block-size argument '5x'");
		assert_eq!(BlockSizeError::TooLarge.message("-B", "1Y"), "-B argument '1Y' too large");
	}

	#[test]
	fn the_environment_supplies_the_default() {
		let (mut host, _) = Host::for_test("du", "", "/");
		assert_eq!(BlockSize::from_env(&host, "DU_BLOCK_SIZE").bytes(), 1024);
		host.set_test_var("POSIXLY_CORRECT", "");
		assert_eq!(BlockSize::from_env(&host, "DU_BLOCK_SIZE").bytes(), 512);
		host.set_test_var("BLOCKSIZE", "1M");
		assert_eq!(BlockSize::from_env(&host, "DU_BLOCK_SIZE").bytes(), 1 << 20);
		host.set_test_var("BLOCK_SIZE", "human");
		assert!(BlockSize::from_env(&host, "DU_BLOCK_SIZE").is_human());
		// A set but empty or zero value is the default; a bad unit keeps its number.
		host.set_test_var("DU_BLOCK_SIZE", "");
		assert_eq!(BlockSize::from_env(&host, "DU_BLOCK_SIZE").bytes(), 512);
		host.set_test_var("DU_BLOCK_SIZE", "0");
		assert_eq!(BlockSize::from_env(&host, "DU_BLOCK_SIZE").bytes(), 512);
		host.set_test_var("DU_BLOCK_SIZE", "10X");
		assert_eq!(BlockSize::from_env(&host, "DU_BLOCK_SIZE").bytes(), 10);
		// Another utility's variable is not consulted.
		assert!(BlockSize::from_env(&host, "DF_BLOCK_SIZE").is_human());
	}

	#[test]
	fn human_sizes_round_up_with_the_locale_decimal_point() {
		assert_eq!(BlockSize::HUMAN.format(1023, C), "1023");
		assert_eq!(BlockSize::HUMAN.format(1025, C), "1.1K");
		assert_eq!(BlockSize::HUMAN.format(10 * 1024 + 1, C), "11K");
		assert_eq!(BlockSize::SI.format(315_392, C), "316k");
		let de = NumericSymbols { decimal_point: b',', thousands_sep: Some(b'.') };
		assert_eq!(BlockSize::HUMAN.format(1536, de), "1,5K");
	}
}
