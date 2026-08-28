//! `base32` builtin: encode or decode data using the RFC 4648 base32 alphabet.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	fmt,
	ffi::OsString,
	fs::File,
	io::{self, BufRead, BufReader, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;

use crate::host::{Host, Utility, matches_parser, util};

const ABOUT: &str = "encode/decode data and print to standard output\nWith no FILE, or when FILE is -, read standard input.\n\nThe data are encoded as described for the base32 alphabet in RFC 4648.\nWhen decoding, the input may contain newlines in addition to the bytes of the formal base32 alphabet. Use --ignore-garbage to attempt to recover from any other non-alphabet bytes in the encoded stream.";

/// Parsed `base32` invocation.
pub(crate) struct Base32 {
	matches: ArgMatches,
}

matches_parser!(Base32, app);

impl Utility for Base32 {
	const NAME: &'static str = "base32";

	fn run(self, host: &mut Host) -> i32 {
		run_base(&self.matches, Format::Base32, host)
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

impl fmt::Display for BaseError {
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
use uucore::{
	display::Quotable,
	encoding::{
		for_base_common::{BASE32, BASE32HEX, BASE64URL, HEXUPPER_PERMISSIVE},
		Base32Wrapper, Base58Wrapper, Base64SimdWrapper, EncodingWrapper, Format,
		SupportsFastDecodeAndEncode, Z85Wrapper, BASE2LSBF, BASE2MSBF,
	},
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
				num.parse::<usize>().map_err(|_| {
					BaseError::new(format!("invalid wrap size: {}", num.quote()))
				})
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
		.override_usage(crate::host::format_usage(usage))
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
					"wrap encoded lines after COLS character (default {WRAP_DEFAULT}, 0 to disable wrapping)"
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
pub(crate) fn run_base(matches: &ArgMatches, format: Format, host: &mut Host) -> i32 {
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
	format: Format,
	config: Config,
) -> BaseResult<()> {
	// Always allow padding for Base64 to avoid a full pre-scan of the input.
	let supports_fast_decode_and_encode =
		get_supports_fast_decode_and_encode(format, config.decode, true);

	let supports_fast_decode_and_encode_ref = supports_fast_decode_and_encode.as_ref();
	let result = match (format, config.decode) {
		// Base58 must process the entire input as one big integer; keep the
		// historical behavior of buffering everything for this format only.
		(Format::Base58, _) => {
			let mut buffered = Vec::new();
			input
				.read_to_end(&mut buffered)
				.map_err(|err| BaseError::new(format_read_error(&err)))?;
			if config.decode {
				fast_decode::fast_decode_buffer(
					buffered,
					output,
					supports_fast_decode_and_encode_ref,
					config.ignore_garbage,
				)
			} else {
				fast_encode::fast_encode_buffer(
					buffered,
					output,
					supports_fast_decode_and_encode_ref,
					config.wrap_cols,
				)
			}
		},
		// Streaming path for all other encodings keeps memory bounded.
		(_, true) => fast_decode::fast_decode_stream(
			input,
			output,
			supports_fast_decode_and_encode_ref,
			config.ignore_garbage,
		),
		(_, false) => fast_encode::fast_encode_stream(
			input,
			output,
			supports_fast_decode_and_encode_ref,
			config.wrap_cols,
		),
	};

	// Ensure any pending stdout buffer is flushed even if decoding failed; GNU
	// basenc keeps already-decoded bytes visible before reporting the error.
	match (result, output.flush()) {
		(res, Ok(())) => res,
		(Ok(_), Err(err)) => Err(err.into()),
		(Err(original), Err(_)) => Err(original),
	}
}

fn get_supports_fast_decode_and_encode(
	format: Format,
	decode: bool,
	has_padding: bool,
) -> Box<dyn SupportsFastDecodeAndEncode> {
	const BASE16_VALID_DECODING_MULTIPLE: usize = 2;
	const BASE2_VALID_DECODING_MULTIPLE: usize = 8;
	const BASE32_VALID_DECODING_MULTIPLE: usize = 8;
	const BASE64_VALID_DECODING_MULTIPLE: usize = 4;

	const BASE16_UNPADDED_MULTIPLE: usize = 1;
	const BASE2_UNPADDED_MULTIPLE: usize = 1;
	const BASE32_UNPADDED_MULTIPLE: usize = 5;
	const BASE64_UNPADDED_MULTIPLE: usize = 3;

	match format {
		Format::Base16 => Box::from(EncodingWrapper::new(
			HEXUPPER_PERMISSIVE,
			BASE16_VALID_DECODING_MULTIPLE,
			BASE16_UNPADDED_MULTIPLE,
			b"0123456789ABCDEFabcdef",
		)),
		Format::Base2Lsbf => Box::from(EncodingWrapper::new(
			BASE2LSBF,
			BASE2_VALID_DECODING_MULTIPLE,
			BASE2_UNPADDED_MULTIPLE,
			b"01",
		)),
		Format::Base2Msbf => Box::from(EncodingWrapper::new(
			BASE2MSBF,
			BASE2_VALID_DECODING_MULTIPLE,
			BASE2_UNPADDED_MULTIPLE,
			b"01",
		)),
		Format::Base32 => Box::from(Base32Wrapper::new(
			BASE32,
			BASE32_VALID_DECODING_MULTIPLE,
			BASE32_UNPADDED_MULTIPLE,
			b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=",
		)),
		Format::Base32Hex => Box::from(Base32Wrapper::new(
			BASE32HEX,
			BASE32_VALID_DECODING_MULTIPLE,
			BASE32_UNPADDED_MULTIPLE,
			b"0123456789ABCDEFGHIJKLMNOPQRSTUV=",
		)),
		Format::Base64 => {
			let alphabet: &[u8] = if has_padding {
				&b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/="[..]
			} else {
				&b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/"[..]
			};
			let use_padding = !decode || has_padding;
			Box::from(Base64SimdWrapper::new(
				use_padding,
				BASE64_VALID_DECODING_MULTIPLE,
				BASE64_UNPADDED_MULTIPLE,
				alphabet,
			))
		},
		Format::Base64Url => Box::from(EncodingWrapper::new(
			BASE64URL,
			BASE64_VALID_DECODING_MULTIPLE,
			BASE64_UNPADDED_MULTIPLE,
			b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789=_-",
		)),
		Format::Z85 => Box::from(Z85Wrapper {}),
		Format::Base58 => Box::from(Base58Wrapper {}),
	}
}

mod fast_encode {
	use std::{
		cmp::min,
		collections::VecDeque,
		io::{self, BufRead, Write},
		num::NonZeroUsize,
	};

	use uucore::encoding::SupportsFastDecodeAndEncode;

	use super::{BaseError, BaseResult, WRAP_DEFAULT};

	struct LineWrapping {
		line_length:  NonZeroUsize,
		print_buffer: Vec<u8>,
	}

	// Start of helper functions
	fn encode_in_chunks_to_buffer(
		supports_fast_decode_and_encode: &dyn SupportsFastDecodeAndEncode,
		read_buffer: &[u8],
		encoded_buffer: &mut VecDeque<u8>,
	) -> BaseResult<()> {
		supports_fast_decode_and_encode.encode_to_vec_deque(read_buffer, encoded_buffer)
			.map_err(|err| BaseError::new(err.to_string()))?;
		Ok(())
	}

	fn write_without_line_breaks(
		encoded_buffer: &mut VecDeque<u8>,
		output: &mut dyn Write,
		is_cleanup: bool,
		empty_wrap: bool,
	) -> io::Result<()> {
		// TODO
		// `encoded_buffer` only has to be a VecDeque if line wrapping is enabled
		// (`make_contiguous` should be a no-op here)
		// Refactoring could avoid this call
		output.write_all(encoded_buffer.make_contiguous())?;

		if is_cleanup {
			if !empty_wrap {
				output.write_all(b"\n")?;
			}
		} else {
			encoded_buffer.clear();
		}

		Ok(())
	}

	fn write_with_line_breaks(
		&mut LineWrapping { ref line_length, ref mut print_buffer }: &mut LineWrapping,
		encoded_buffer: &mut VecDeque<u8>,
		output: &mut dyn Write,
		is_cleanup: bool,
	) -> io::Result<()> {
		let line_length = line_length.get();

		let make_contiguous_result = encoded_buffer.make_contiguous();

		let chunks_exact = make_contiguous_result.chunks_exact(line_length);

		let mut bytes_added_to_print_buffer = 0;

		for sl in chunks_exact {
			bytes_added_to_print_buffer += sl.len();

			print_buffer.extend_from_slice(sl);
			print_buffer.push(b'\n');
		}

		output.write_all(print_buffer)?;

		// Remove the bytes that were just printed from `encoded_buffer`
		drop(encoded_buffer.drain(..bytes_added_to_print_buffer));

		if is_cleanup {
			if encoded_buffer.is_empty() {
				// Do not write a newline in this case, because two trailing
				// newlines should never be printed
			} else {
				// Print the partial line, since this is cleanup and no more data is coming
				output.write_all(encoded_buffer.make_contiguous())?;
				output.write_all(b"\n")?;
			}
		} else {
			print_buffer.clear();
		}

		Ok(())
	}

	fn write_to_output(
		line_wrapping: &mut Option<LineWrapping>,
		encoded_buffer: &mut VecDeque<u8>,
		output: &mut dyn Write,
		is_cleanup: bool,
		empty_wrap: bool,
	) -> io::Result<()> {
		// Write all data in `encoded_buffer` to `output`
		if let &mut Some(ref mut li) = line_wrapping {
			write_with_line_breaks(li, encoded_buffer, output, is_cleanup)?;
		} else {
			write_without_line_breaks(encoded_buffer, output, is_cleanup, empty_wrap)?;
		}

		Ok(())
	}
	// End of helper functions

	pub(super) fn fast_encode_buffer(
		input: Vec<u8>,
		output: &mut dyn Write,
		supports_fast_decode_and_encode: &dyn SupportsFastDecodeAndEncode,
		wrap: Option<usize>,
	) -> BaseResult<()> {
		// Based on performance testing

		const ENCODE_IN_CHUNKS_OF_SIZE_MULTIPLE: usize = 1_024;

		let encode_in_chunks_of_size =
			supports_fast_decode_and_encode.unpadded_multiple() * ENCODE_IN_CHUNKS_OF_SIZE_MULTIPLE;

		assert!(encode_in_chunks_of_size > 0);

		// The "data-encoding" crate supports line wrapping, but not arbitrary line
		// wrapping, only certain widths, so line wrapping must be handled here.
		// https://github.com/ia0/data-encoding/blob/4f42ad7ef242f6d243e4de90cd1b46a57690d00e/lib/src/lib.rs#L1710
		let mut line_wrapping = match wrap {
			// Line wrapping is disabled because "-w"/"--wrap" was passed with "0"
			Some(0) => None,
			// A custom line wrapping value was passed
			Some(an) => Some(LineWrapping {
				line_length:  NonZeroUsize::new(an).unwrap(),
				print_buffer: Vec::<u8>::new(),
			}),
			// Line wrapping was not set, so the default is used
			None => Some(LineWrapping {
				line_length:  NonZeroUsize::new(WRAP_DEFAULT).unwrap(),
				print_buffer: Vec::<u8>::new(),
			}),
		};

		let input_size = input.len();

		// Start of buffers
		// Data that was read from `input` but has not been encoded yet
		let mut leftover_buffer = VecDeque::<u8>::new();

		// Encoded data that needs to be written to `output`
		let mut encoded_buffer = VecDeque::<u8>::new();
		// End of buffers

		input
			.iter()
			.enumerate()
			.step_by(encode_in_chunks_of_size)
			.filter_map(|(idx, _)| {
				// The part of `input_buffer` that was actually filled by the call
				// to `read`
				let buffer = &input[idx..min(input_size, idx + encode_in_chunks_of_size)];

				if buffer.len() < encode_in_chunks_of_size {
					leftover_buffer.extend(buffer);
					assert!(leftover_buffer.len() < encode_in_chunks_of_size);
					None
				} else {
					Some(buffer)
				}
			})
			.for_each(|read_buffer| {
				// Encode data in chunks, then place it in `encoded_buffer`
				assert_eq!(read_buffer.len(), encode_in_chunks_of_size);
				encode_in_chunks_to_buffer(
					supports_fast_decode_and_encode,
					read_buffer,
					&mut encoded_buffer,
				)
				.unwrap();
				// Write all data in `encoded_buffer` to `output`
				write_to_output(
					&mut line_wrapping,
					&mut encoded_buffer,
					output,
					false,
					wrap == Some(0),
				)
				.unwrap();
			});

		// Cleanup
		// `input` has finished producing data, so the data remaining in the buffers
		// needs to be encoded and printed
		{
			// Encode all remaining unencoded bytes, placing them in `encoded_buffer`
			supports_fast_decode_and_encode
				.encode_to_vec_deque(leftover_buffer.make_contiguous(), &mut encoded_buffer)
				.map_err(|err| BaseError::new(err.to_string()))?;

			// Write all data in `encoded_buffer` to output
			// `is_cleanup` triggers special cleanup-only logic
			write_to_output(&mut line_wrapping, &mut encoded_buffer, output, true, wrap == Some(0))?;
		}
		Ok(())
	}

	/// Encodes all data read from `input` into Base32 using a fast, chunked
	/// implementation and writes the result to `output`.
	///
	/// The `supports_fast_decode_and_encode` parameter supplies an optimized
	/// encoder and determines the chunk size used for bulk processing. When
	/// `wrap` is:
	/// - `Some(0)`: no line wrapping is performed,
	/// - `Some(n)`: lines are wrapped every `n` characters,
	/// - `None`: the default wrap width is applied.
	///
	/// Remaining bytes are encoded and flushed at the end. I/O or encoding
	/// failures are propagated through the shared result type.
	pub(super) fn fast_encode_stream(
		input: &mut dyn BufRead,
		output: &mut dyn Write,
		supports_fast_decode_and_encode: &dyn SupportsFastDecodeAndEncode,
		wrap: Option<usize>,
	) -> BaseResult<()> {
		const ENCODE_IN_CHUNKS_OF_SIZE_MULTIPLE: usize = 1_024;

		let encode_in_chunks_of_size =
			supports_fast_decode_and_encode.unpadded_multiple() * ENCODE_IN_CHUNKS_OF_SIZE_MULTIPLE;

		assert!(encode_in_chunks_of_size > 0);

		let mut line_wrapping = match wrap {
			Some(0) => None,
			Some(an) => Some(LineWrapping {
				line_length:  NonZeroUsize::new(an).unwrap(),
				print_buffer: Vec::<u8>::new(),
			}),
			None => Some(LineWrapping {
				line_length:  NonZeroUsize::new(WRAP_DEFAULT).unwrap(),
				print_buffer: Vec::<u8>::new(),
			}),
		};

		// Buffers
		let mut encoded_buffer = VecDeque::<u8>::new();
		let mut leftover_buffer = Vec::<u8>::with_capacity(encode_in_chunks_of_size);

		loop {
			let read_buffer = input
				.fill_buf()
				.map_err(|err| BaseError::new(super::format_read_error(&err)))?;
			if read_buffer.is_empty() {
				break;
			}

			let mut consumed = 0;

			if !leftover_buffer.is_empty() {
				let needed = encode_in_chunks_of_size - leftover_buffer.len();
				let take = needed.min(read_buffer.len());
				leftover_buffer.extend_from_slice(&read_buffer[..take]);
				consumed += take;

				if leftover_buffer.len() == encode_in_chunks_of_size {
					encode_in_chunks_to_buffer(
						supports_fast_decode_and_encode,
						leftover_buffer.as_slice(),
						&mut encoded_buffer,
					)?;
					leftover_buffer.clear();

					write_to_output(
						&mut line_wrapping,
						&mut encoded_buffer,
						output,
						false,
						wrap == Some(0),
					)?;
				}
			}

			let remaining = &read_buffer[consumed..];
			let full_chunk_bytes =
				(remaining.len() / encode_in_chunks_of_size) * encode_in_chunks_of_size;

			if full_chunk_bytes > 0 {
				for chunk in remaining[..full_chunk_bytes].chunks_exact(encode_in_chunks_of_size) {
					encode_in_chunks_to_buffer(
						supports_fast_decode_and_encode,
						chunk,
						&mut encoded_buffer,
					)?;
					write_to_output(
						&mut line_wrapping,
						&mut encoded_buffer,
						output,
						false,
						wrap == Some(0),
					)?;
				}
				consumed += full_chunk_bytes;
			}

			if consumed < read_buffer.len() {
				leftover_buffer.extend_from_slice(&read_buffer[consumed..]);
				consumed = read_buffer.len();
			}

			input.consume(consumed);

			// `leftover_buffer` should never exceed one partial chunk.
			debug_assert!(leftover_buffer.len() < encode_in_chunks_of_size);
		}

		// Encode any remaining bytes and flush
		supports_fast_decode_and_encode.encode_to_vec_deque(&leftover_buffer, &mut encoded_buffer)
			.map_err(|err| BaseError::new(err.to_string()))?;

		write_to_output(&mut line_wrapping, &mut encoded_buffer, output, true, wrap == Some(0))?;

		Ok(())
	}
}

mod fast_decode {
	use std::io::{self, BufRead, Write};

	use uucore::encoding::SupportsFastDecodeAndEncode;

	use super::{BaseError, BaseResult};

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
		supports_fast_decode_and_encode: &dyn SupportsFastDecodeAndEncode,
		read_buffer_filtered: &[u8],
		decoded_buffer: &mut Vec<u8>,
	) -> BaseResult<()> {
		supports_fast_decode_and_encode.decode_into_vec(read_buffer_filtered, decoded_buffer)
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
		supports_fast_decode_and_encode: &dyn SupportsFastDecodeAndEncode,
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

			decode_in_chunks_to_buffer(
				supports_fast_decode_and_encode,
				&buffer[..aligned_take],
				decoded_buffer,
			)?;

			write_to_output(decoded_buffer, output)?;

			buffer.drain(..aligned_take);
		}

		Ok(())
	}
	// End of helper functions

	pub(super) fn fast_decode_buffer(
		input: Vec<u8>,
		output: &mut dyn Write,
		supports_fast_decode_and_encode: &dyn SupportsFastDecodeAndEncode,
		ignore_garbage: bool,
	) -> BaseResult<()> {
		const DECODE_IN_CHUNKS_OF_SIZE_MULTIPLE: usize = 1_024;

		let alphabet = supports_fast_decode_and_encode.alphabet();
		let alphabet_table = alphabet_lookup(alphabet);
		let valid_multiple = supports_fast_decode_and_encode.valid_decoding_multiple();
		let decode_in_chunks_of_size = valid_multiple * DECODE_IN_CHUNKS_OF_SIZE_MULTIPLE;

		assert!(decode_in_chunks_of_size > 0);
		assert!(valid_multiple > 0);

		// Start of buffers

		// Decoded data that needs to be written to `output`
		let mut decoded_buffer = Vec::<u8>::new();

		// End of buffers

		let mut buffer = Vec::with_capacity(decode_in_chunks_of_size);

		let supports_partial_decode = supports_fast_decode_and_encode.supports_partial_decode();

		for &byte in &input {
			if byte == b'\n' || byte == b'\r' {
				continue;
			}

			if alphabet_table[usize::from(byte)] {
				buffer.push(byte);
			} else if ignore_garbage {
				continue;
			} else {
				return Err(BaseError::new("error: invalid input"));
			}

			if supports_partial_decode {
				flush_ready_chunks(
					&mut buffer,
					decode_in_chunks_of_size,
					valid_multiple,
					supports_fast_decode_and_encode,
					&mut decoded_buffer,
					output,
				)?;
			} else if buffer.len() == decode_in_chunks_of_size {
				decode_in_chunks_to_buffer(
					supports_fast_decode_and_encode,
					&buffer,
					&mut decoded_buffer,
				)?;
				write_to_output(&mut decoded_buffer, output)?;
				buffer.clear();
			}
		}

		if supports_partial_decode {
			flush_ready_chunks(
				&mut buffer,
				decode_in_chunks_of_size,
				valid_multiple,
				supports_fast_decode_and_encode,
				&mut decoded_buffer,
				output,
			)?;
		}

		if !buffer.is_empty() {
			let mut owned_chunk: Option<Vec<u8>> = None;
			let mut had_invalid_tail = false;

			if let Some(pad_result) = supports_fast_decode_and_encode.pad_remainder(&buffer) {
				had_invalid_tail = pad_result.had_invalid_tail;
				owned_chunk = Some(pad_result.chunk);
			}

			let final_chunk = owned_chunk.as_deref().unwrap_or(&buffer);

			supports_fast_decode_and_encode.decode_into_vec(final_chunk, &mut decoded_buffer)
				.map_err(|err| BaseError::new(err.to_string()))?;
			write_to_output(&mut decoded_buffer, output)?;

			if had_invalid_tail {
				return Err(BaseError::new("error: invalid input"));
			}
		}

		Ok(())
	}

	pub(super) fn fast_decode_stream(
		input: &mut dyn BufRead,
		output: &mut dyn Write,
		supports_fast_decode_and_encode: &dyn SupportsFastDecodeAndEncode,
		ignore_garbage: bool,
	) -> BaseResult<()> {
		const DECODE_IN_CHUNKS_OF_SIZE_MULTIPLE: usize = 1_024;

		let alphabet = supports_fast_decode_and_encode.alphabet();
		let alphabet_table = alphabet_lookup(alphabet);
		let valid_multiple = supports_fast_decode_and_encode.valid_decoding_multiple();
		let decode_in_chunks_of_size = valid_multiple * DECODE_IN_CHUNKS_OF_SIZE_MULTIPLE;

		assert!(decode_in_chunks_of_size > 0);
		assert!(valid_multiple > 0);

		let supports_partial_decode = supports_fast_decode_and_encode.supports_partial_decode();

		let mut buffer = Vec::with_capacity(decode_in_chunks_of_size);
		let mut decoded_buffer = Vec::<u8>::new();

		loop {
			let read_buffer = input
				.fill_buf()
				.map_err(|err| BaseError::new(super::format_read_error(&err)))?;
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
							supports_fast_decode_and_encode,
							&mut decoded_buffer,
							output,
						)?;
					} else {
						while buffer.len() >= decode_in_chunks_of_size {
							decode_in_chunks_to_buffer(
								supports_fast_decode_and_encode,
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
						supports_fast_decode_and_encode,
						&mut decoded_buffer,
						output,
					)?;
				} else if buffer.len() == decode_in_chunks_of_size {
					decode_in_chunks_to_buffer(
						supports_fast_decode_and_encode,
						&buffer,
						&mut decoded_buffer,
					)?;
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
				supports_fast_decode_and_encode,
				&mut decoded_buffer,
				output,
			)?;
		}

		if !buffer.is_empty() {
			let mut owned_chunk: Option<Vec<u8>> = None;
			let mut had_invalid_tail = false;

			if let Some(pad_result) = supports_fast_decode_and_encode.pad_remainder(&buffer) {
				had_invalid_tail = pad_result.had_invalid_tail;
				owned_chunk = Some(pad_result.chunk);
			}

			let final_chunk = owned_chunk.as_deref().unwrap_or(&buffer);

			supports_fast_decode_and_encode.decode_into_vec(final_chunk, &mut decoded_buffer)
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
fn read_and_has_padding<R: io::Read>(input: &mut R) -> BaseResult<(bool, Vec<u8>)> {
	let mut buffer = Vec::new();
	input
		.read_to_end(&mut buffer)
		.map_err(|error| BaseError::new(format_read_error(&error)))?;
	let has_padding = buffer.contains(&b'=');
	Ok((has_padding, buffer))
}


#[cfg(test)]
mod tests {
	use std::fs;

	use super::{Base32, read_and_has_padding};
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

	#[test]
	fn detects_padding_anywhere_in_input() {
		let test_cases = [
			("aGVsbG8sIHdvcmxkIQ==", true),
			("aGVsbG8sIHdvcmxkIQ== ", true),
			("aGVsbG8sIHdvcmxkIQ==\n", true),
			("aGVsbG8sIHdvcmxkIQ== \n", true),
			("aGVsbG8sIHdvcmxkIQ=", true),
			("MTIzNA==MTIzNA", true),
			("MTIzNA==\nMTIzNA", true),
			("aGVsbG8sIHdvcmxkIQ \n", false),
			("aGVsbG8sIHdvcmxkIQ", false),
		];

		for (input, expected) in test_cases {
			let (has_padding, _) = read_and_has_padding(&mut input.as_bytes()).unwrap();
			assert_eq!(has_padding, expected, "failed for input: '{input}'");
		}
	}
}
