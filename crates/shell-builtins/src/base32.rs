//! `base32` builtin: encode or decode data using the RFC 4648 base32 alphabet.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::OsString,
	fmt::{self, Display},
	fs::File,
	io::{self, BufRead, BufReader, Write},
};

use clap::ArgMatches;
use omp_shell::{ShellExtensions, builtins::Registration};

use crate::host::{Host, Utility, matches_parser, util};

const ABOUT: &str = "encode/decode data and print to standard output\nWith no FILE, or when FILE \
                     is -, read standard input.\n\nThe data are encoded as described for the \
                     base32 alphabet in RFC 4648.\nWhen decoding, the input may contain newlines \
                     in addition to the bytes of the formal base32 alphabet. Use --ignore-garbage \
                     to attempt to recover from any other non-alphabet bytes in the encoded \
                     stream.";

/// Parsed `base32` invocation.
pub(crate) struct Base32 {
	matches: ArgMatches,
}

matches_parser!(Base32, app);

impl Utility for Base32 {
	const NAME: &'static str = "base32";

	fn run(self, host: &mut Host) -> i32 {
		run_base(&self.matches, Codec::Base32, host)
	}
}

fn app() -> Command {
	base_app(Base32::NAME, ABOUT, "base32 [OPTION]... [FILE]")
}

/// Creates the `base32` builtin registration.
pub(crate) fn base32_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Base32, SE>()
}

#[derive(Debug)]
struct BaseError(String);

impl BaseError {
	fn new(message: impl Into<String>) -> Self {
		Self(message.into())
	}
}

impl Display for BaseError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(&self.0)
	}
}

impl From<io::Error> for BaseError {
	fn from(error: io::Error) -> Self {
		Self(error.to_string())
	}
}

type BaseResult<T> = Result<T, BaseError>;

use clap::{Arg, ArgAction, Command};

use crate::{
	host::format_usage,
	support::{basenc::Codec, quote::Quotable},
};
const BASE_CMD_PARSE_ERROR: i32 = 1;

/// Encoded output will be formatted in lines of this length (the last line can
/// be shorter)
///
/// Other implementations default to 76
///
/// This default is only used if no "-w"/"--wrap" argument is passed
const WRAP_DEFAULT: usize = 76;

// Fixed to 8 KiB (equivalent to `std::sys::io::DEFAULT_BUF_SIZE` on most
// targets)
const DEFAULT_BUF_SIZE: usize = 8 * 1024;

struct Config {
	decode:         bool,
	ignore_garbage: bool,
	wrap_cols:      Option<usize>,
	to_read:        Option<OsString>,
}

mod options {
	pub(super) static DECODE: &str = "decode";
	pub(super) static WRAP: &str = "wrap";
	pub(super) static IGNORE_GARBAGE: &str = "ignore-garbage";
	pub(super) static FILE: &str = "file";
}

impl Config {
	fn from(options: &clap::ArgMatches) -> BaseResult<Self> {
		let to_read = match options.get_many::<OsString>(options::FILE) {
			Some(mut values) => {
				let name = values.next().unwrap();

				if let Some(extra_op) = values.next() {
					return Err(BaseError::new(format!("extra operand {}", extra_op.quote())));
				}

				if name == "-" {
					None
				} else {
					Some(name.clone())
				}
			},
			None => None,
		};

		let wrap_cols = options
			.get_one::<String>(options::WRAP)
			.map(|num| {
				num.parse::<usize>()
					.map_err(|_| BaseError::new(format!("invalid wrap size: {}", num.quote())))
			})
			.transpose()?;

		Ok(Self {
			decode: options.get_flag(options::DECODE),
			ignore_garbage: options.get_flag(options::IGNORE_GARBAGE),
			wrap_cols,
			to_read,
		})
	}
}

/// Builds the shared command-line model used by base32 and base64.
pub(crate) fn base_app(name: &'static str, about: &'static str, usage: &'static str) -> Command {
	Command::new(name)
		.version("0.8.0")
		.about(about)
		.override_usage(format_usage(usage))
		.infer_long_args(true)
		.arg(
			Arg::new(options::DECODE)
				.short('d')
				.short_alias('D')
				.long(options::DECODE)
				.help("decode data")
				.action(ArgAction::SetTrue)
				.overrides_with(options::DECODE),
		)
		.arg(
			Arg::new(options::IGNORE_GARBAGE)
				.short('i')
				.long(options::IGNORE_GARBAGE)
				.help("when decoding, ignore non-alphabetic characters")
				.action(ArgAction::SetTrue)
				.overrides_with(options::IGNORE_GARBAGE),
		)
		.arg(
			Arg::new(options::WRAP)
				.short('w')
				.long(options::WRAP)
				.value_name("COLS")
				.help(format!(
					"wrap encoded lines after COLS character (default {WRAP_DEFAULT}, 0 to disable \
					 wrapping)"
				))
				.overrides_with(options::WRAP),
		)
		.arg(
			Arg::new(options::FILE)
				.index(1)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::FilePath),
		)
}

/// Runs the shared base-encoding implementation against the selected format.
pub(crate) fn run_base(matches: &ArgMatches, format: Codec, host: &mut Host) -> i32 {
	let config = match Config::from(matches) {
		Ok(config) => config,
		Err(error) => {
			host.error(error, BASE_CMD_PARSE_ERROR);
			return BASE_CMD_PARSE_ERROR;
		},
	};

	let result = if let Some(name) = config.to_read.clone() {
		match File::open(host.resolve(&name)) {
			Ok(file) => {
				let mut input = BufReader::with_capacity(DEFAULT_BUF_SIZE, file);
				handle_input(&mut input, &mut host.stdout, format, config)
			},
			Err(error) => Err(BaseError::new(format!("{}: {error}", name.maybe_quote()))),
		}
	} else {
		let mut input = BufReader::with_capacity(DEFAULT_BUF_SIZE, &mut host.stdin);
		handle_input(&mut input, &mut host.stdout, format, config)
	};

	match result {
		Ok(()) => host.exit_code(),
		Err(error) => {
			host.error(error, 1);
			1
		},
	}
}

fn handle_input<R: BufRead>(
	input: &mut R,
	output: &mut dyn Write,
	codec: Codec,
	config: Config,
) -> BaseResult<()> {
	let result = if config.decode {
		decode::stream(input, output, codec, config.ignore_garbage)
	} else {
		encode::stream(input, output, codec, config.wrap_cols)
	};

	// Ensure any pending stdout buffer is flushed even if decoding failed; GNU
	// base32 and base64 keep already-decoded bytes visible before reporting the
	// error.
	match (result, output.flush()) {
		(res, Ok(())) => res,
		(Ok(_), Err(err)) => Err(err.into()),
		(Err(original), Err(_)) => Err(original),
	}
}

mod encode {
	use std::{
		collections::VecDeque,
		io::{BufRead, Write},
	};

	use super::{BaseError, BaseResult, WRAP_DEFAULT, format_read_error};
	use crate::support::basenc::Codec;

	fn write_encoded(
		output: &mut dyn Write,
		encoded: &mut VecDeque<u8>,
		wrap: Option<usize>,
		column: &mut usize,
		wrote_any: &mut bool,
	) -> BaseResult<()> {
		if wrap == Some(0) {
			output.write_all(encoded.make_contiguous())?;
			*wrote_any |= !encoded.is_empty();
			encoded.clear();
			return Ok(());
		}

		let width = wrap.unwrap_or(WRAP_DEFAULT);
		while !encoded.is_empty() {
			let count = (width - *column).min(encoded.len());
			let contiguous = encoded.make_contiguous();
			output.write_all(&contiguous[..count])?;
			encoded.drain(..count);
			*column += count;
			*wrote_any = true;
			if *column == width {
				output.write_all(b"\n")?;
				*column = 0;
			}
		}
		Ok(())
	}

	pub(super) fn stream(
		input: &mut dyn BufRead,
		output: &mut dyn Write,
		codec: Codec,
		wrap: Option<usize>,
	) -> BaseResult<()> {
		const CHUNK_MULTIPLE: usize = 1_024;
		let chunk_size = codec.unpadded_multiple() * CHUNK_MULTIPLE;
		let mut leftover = Vec::with_capacity(chunk_size);
		let mut encoded = VecDeque::new();
		let mut column = 0;
		let mut wrote_any = false;

		loop {
			let available = input
				.fill_buf()
				.map_err(|error| BaseError::new(format_read_error(&error)))?;
			if available.is_empty() {
				break;
			}

			let needed = chunk_size - leftover.len();
			let consumed = needed.min(available.len());
			leftover.extend_from_slice(&available[..consumed]);
			input.consume(consumed);

			if leftover.len() == chunk_size {
				codec.encode_into(&leftover, &mut encoded);
				leftover.clear();
				write_encoded(output, &mut encoded, wrap, &mut column, &mut wrote_any)?;
			}
		}

		codec.encode_into(&leftover, &mut encoded);
		write_encoded(output, &mut encoded, wrap, &mut column, &mut wrote_any)?;
		if wrap != Some(0) && (column != 0 || !wrote_any) {
			output.write_all(b"\n")?;
		}
		Ok(())
	}
}

mod decode {
	use std::io::{self, BufRead, Write};

	use super::{BaseError, BaseResult, format_read_error};
	use crate::support::basenc::Codec;

	// Start of helper functions
	fn alphabet_lookup(alphabet: &[u8]) -> [bool; 256] {
		// Precompute O(1) membership checks so we can validate every byte before
		// decoding.
		let mut table = [false; 256];

		for &byte in alphabet {
			table[usize::from(byte)] = true;
		}

		table
	}

	fn decode_in_chunks_to_buffer(
		codec: Codec,
		read_buffer_filtered: &[u8],
		decoded_buffer: &mut Vec<u8>,
	) -> BaseResult<()> {
		codec
			.decode_into(read_buffer_filtered, decoded_buffer)
			.map_err(|err| BaseError::new(err.to_string()))?;
		Ok(())
	}

	fn write_to_output(decoded_buffer: &mut Vec<u8>, output: &mut dyn Write) -> io::Result<()> {
		// Write all data in `decoded_buffer` to `output`
		output.write_all(decoded_buffer.as_slice())?;

		decoded_buffer.clear();

		Ok(())
	}

	fn flush_ready_chunks(
		buffer: &mut Vec<u8>,
		block_limit: usize,
		valid_multiple: usize,
		codec: Codec,
		decoded_buffer: &mut Vec<u8>,
		output: &mut dyn Write,
	) -> BaseResult<()> {
		// While at least one full decode block is buffered, keep draining
		// it and never yield more than block_limit per chunk.
		while buffer.len() >= valid_multiple {
			let take = buffer.len().min(block_limit);
			let aligned_take = take - (take % valid_multiple);

			if aligned_take < valid_multiple {
				break;
			}

			decode_in_chunks_to_buffer(codec, &buffer[..aligned_take], decoded_buffer)?;

			write_to_output(decoded_buffer, output)?;

			buffer.drain(..aligned_take);
		}

		Ok(())
	}
	// End of helper functions

	pub(super) fn stream(
		input: &mut dyn BufRead,
		output: &mut dyn Write,
		codec: Codec,
		ignore_garbage: bool,
	) -> BaseResult<()> {
		const DECODE_IN_CHUNKS_OF_SIZE_MULTIPLE: usize = 1_024;

		let alphabet = codec.alphabet();
		let alphabet_table = alphabet_lookup(alphabet);
		let valid_multiple = codec.valid_decoding_multiple();
		let decode_in_chunks_of_size = valid_multiple * DECODE_IN_CHUNKS_OF_SIZE_MULTIPLE;

		assert!(decode_in_chunks_of_size > 0);
		assert!(valid_multiple > 0);

		let supports_partial_decode = codec.supports_partial_decode();

		let mut buffer = Vec::with_capacity(decode_in_chunks_of_size);
		let mut decoded_buffer = Vec::<u8>::new();

		loop {
			let read_buffer = input
				.fill_buf()
				.map_err(|err| BaseError::new(format_read_error(&err)))?;
			let read_len = read_buffer.len();
			if read_len == 0 {
				break;
			}

			for &byte in read_buffer {
				if byte == b'\n' || byte == b'\r' {
					continue;
				}

				if alphabet_table[usize::from(byte)] {
					buffer.push(byte);
				} else if ignore_garbage {
					continue;
				} else {
					if supports_partial_decode {
						flush_ready_chunks(
							&mut buffer,
							decode_in_chunks_of_size,
							valid_multiple,
							codec,
							&mut decoded_buffer,
							output,
						)?;
					} else {
						while buffer.len() >= decode_in_chunks_of_size {
							decode_in_chunks_to_buffer(
								codec,
								&buffer[..decode_in_chunks_of_size],
								&mut decoded_buffer,
							)?;
							write_to_output(&mut decoded_buffer, output)?;
							buffer.drain(..decode_in_chunks_of_size);
						}
					}
					return Err(BaseError::new("error: invalid input"));
				}

				if supports_partial_decode {
					flush_ready_chunks(
						&mut buffer,
						decode_in_chunks_of_size,
						valid_multiple,
						codec,
						&mut decoded_buffer,
						output,
					)?;
				} else if buffer.len() == decode_in_chunks_of_size {
					decode_in_chunks_to_buffer(codec, &buffer, &mut decoded_buffer)?;
					write_to_output(&mut decoded_buffer, output)?;
					buffer.clear();
				}
			}

			input.consume(read_len);
		}

		if supports_partial_decode {
			flush_ready_chunks(
				&mut buffer,
				decode_in_chunks_of_size,
				valid_multiple,
				codec,
				&mut decoded_buffer,
				output,
			)?;
		}

		if !buffer.is_empty() {
			let mut owned_chunk: Option<Vec<u8>> = None;
			let mut had_invalid_tail = false;

			if let Some((chunk, invalid_tail)) = codec.pad_remainder(&buffer) {
				had_invalid_tail = invalid_tail;
				owned_chunk = Some(chunk);
			}

			let final_chunk = owned_chunk.as_deref().unwrap_or(&buffer);

			codec
				.decode_into(final_chunk, &mut decoded_buffer)
				.map_err(|err| BaseError::new(err.to_string()))?;
			write_to_output(&mut decoded_buffer, output)?;

			if had_invalid_tail {
				return Err(BaseError::new("error: invalid input"));
			}
		}

		Ok(())
	}
}

fn format_read_error(error: &io::Error) -> String {
	format!("read error: {}", error)
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::Base32;
	use crate::host::run_util;

	#[test]
	fn encodes_stdin() {
		let (code, capture) = run_util::<Base32>(&[], "hello", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "NBSWY3DP\n");
	}

	#[test]
	fn decodes_stdin() {
		let (code, capture) = run_util::<Base32>(&["--decode"], "NBSWY3DP\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.stdout(), b"hello");
	}

	#[test]
	fn wraps_encoded_output_at_requested_width() {
		let (code, capture) = run_util::<Base32>(&["--wrap", "4"], "hello", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "NBSW\nY3DP\n");
	}

	#[test]
	fn resolves_file_operand_against_shell_cwd() {
		let cwd = tempfile::tempdir().unwrap();
		fs::write(cwd.path().join("input"), b"hello").unwrap();
		let (code, capture) = run_util::<Base32>(&["input"], "", cwd.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "NBSWY3DP\n");
	}

	#[test]
	fn rejects_invalid_input() {
		let (code, capture) = run_util::<Base32>(&["--decode"], "!", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "base32: error: invalid input\n");
	}
}
