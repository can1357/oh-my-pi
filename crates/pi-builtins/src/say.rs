//! `say` builtin: convert text to audible speech, with the options of macOS
//! `say`.
//!
//! Speech goes through the embedding application's synthesizer
//! ([`SpeechHost`]) when it has one configured, and through the system's
//! otherwise ([`system`]): macOS `say`, `spd-say`, eSpeak, or Windows SAPI.
//! `-o` files of linear PCM are written here ([`audio`]); other formats go
//! through macOS `afconvert`.

mod audio;
mod system;

use std::{
	ffi::OsString,
	io::{Seek, Write},
	path::{Path, PathBuf},
	sync::Arc,
};

use clap::Parser;

use self::{
	audio::{Container, DataFormat},
	system::{Engine, Platform, Run, Speech, Synthesizer},
};
use crate::{
	host::{AsyncUtility, CommandStatus, Host, ShellCommand, strip_errno},
	openfile::Fd,
	speech::{SpeechAudio, SpeechHost, SpeechOutcome, SpeechRequest, SpeechVoice},
};

/// The most text read from a file or standard input.
const TEXT_LIMIT: usize = 16 * 1024 * 1024;

/// macOS's audio file converter, for the formats [`audio`] does not write.
const AFCONVERT: &str = "/usr/bin/afconvert";

/// What `--file-format=?` lists when no macOS `say` answers it.
const FILE_FORMATS: &str = "\
AIFC  AIFC                 (.aifc,.aiff,.aif) [lpcm]
AIFF  AIFF                 (.aiff,.aif) [lpcm]
WAVE  WAVE                 (.wav) [lpcm]
caff  CAF                  (.caf) [lpcm]
";

/// Parsed `say` invocation.
#[derive(Parser, Debug)]
#[command(name = "say", about = "Convert text to audible speech", infer_long_args = true)]
pub(crate) struct Say {
	/// Voice to speak with; `?` lists the voices.
	#[arg(short = 'v', long = "voice", value_name = "voice")]
	voice: Option<String>,

	/// Speech rate, in words per minute.
	#[arg(short = 'r', long = "rate", value_name = "rate", allow_hyphen_values = true)]
	rate: Option<String>,

	/// Audio file to write instead of playing the speech.
	#[arg(short = 'o', long = "output-file", value_name = "file")]
	output: Option<PathBuf>,

	/// File to speak; `-` is standard input.
	#[arg(short = 'f', long = "input-file", value_name = "file", allow_hyphen_values = true)]
	input: Option<PathBuf>,

	/// Audio device to play through, by ID or name prefix; `?` lists them.
	#[arg(short = 'a', long = "audio-device", value_name = "device")]
	device: Option<String>,

	/// Service name and/or port to send the speech to through AUNetSend.
	#[arg(short = 'n', long = "network-send", value_name = "name:port")]
	network: Option<String>,

	/// Display a progress meter during synthesis.
	#[arg(long = "progress")]
	progress: bool,

	/// Print the text, highlighting words as they are spoken.
	#[arg(
		short = 'i',
		long = "interactive",
		value_name = "markup",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = ""
	)]
	interactive: Option<String>,

	/// Format of the file to write (AIFF, caff, m4af, WAVE); `?` lists them.
	#[arg(long = "file-format", value_name = "format")]
	file_format: Option<String>,

	/// Format of the audio data (LEI16, BEF32@22050, aac, alac); `?` lists
	/// them.
	#[arg(long = "data-format", value_name = "format")]
	data_format: Option<String>,

	/// Number of channels.
	#[arg(long = "channels", value_name = "channels")]
	channels: Option<String>,

	/// Bit rate for formats like AAC; `?` lists the valid rates.
	#[arg(long = "bit-rate", value_name = "rate")]
	bit_rate: Option<String>,

	/// Audio converter quality, 0 (lowest) to 127 (highest).
	#[arg(long = "quality", value_name = "quality")]
	quality: Option<String>,

	/// Text to speak; standard input when there is none and no `-f`.
	#[arg(value_name = "string")]
	text: Vec<String>,
}

impl AsyncUtility for Say {
	const NAME: &'static str = "say";
	const RUNS_COMMANDS: bool = true;

	async fn run(self, host: &mut Host) -> i32 {
		match self.speak(host, Platform::current()).await {
			Ok(code) => code,
			Err(message) => {
				host.error(message, 1);
				1
			},
		}
	}
}

/// The file extension macOS `say` gives a file of `--file-format` `code`
/// whose name has none.
fn format_extension(code: &str) -> Option<&'static str> {
	Some(match code {
		"AIFF" => "aiff",
		"AIFC" => "aifc",
		"WAVE" | "BW64" | "RF64" => "wav",
		"caff" => "caf",
		"m4af" => "m4a",
		"m4bf" => "m4b",
		"mp4f" => "mp4",
		"adts" => "aac",
		"flac" => "flac",
		"NeXT" => "au",
		"3gpp" => "3gp",
		"3gp2" => "3g2",
		"Oggf" => "ogg",
		"W64f" => "w64",
		_ => return None,
	})
}

/// The data format `afconvert` is asked for when `--data-format` names none:
/// the codec a file named `extension` usually holds.
fn default_codec(extension: &str) -> &'static str {
	match extension.to_ascii_lowercase().as_str() {
		"m4a" | "m4b" | "mp4" | "aac" | "adts" | "3gp" | "3g2" => "aac",
		"flac" => "flac",
		"opus" | "ogg" | "oga" => "opus",
		_ => "lpcm",
	}
}

fn no_synthesizer() -> String {
	"no speech synthesizer available".to_owned()
}

fn print_voices(host: &Host, voices: &[SpeechVoice]) -> i32 {
	let mut out = host.stdout_writer();
	for SpeechVoice { name, locale, sample } in voices {
		let _ = writeln!(out, "{name:<19} {locale}    # {sample}");
	}
	0
}

/// Runs `run`, feeding it `text` on standard input when it reads its text
/// there.
async fn execute(host: &mut Host, run: Run, text: &str) -> Result<CommandStatus, String> {
	let program = run.argv.first().map(|program| program.to_string_lossy().into_owned()).unwrap_or_default();
	let failed = |error: std::io::Error| format!("{program}: {}", strip_errno(&error));
	let mut command = ShellCommand::new(run.argv);
	for (name, value) in run.env {
		command = command.env(name, value);
	}
	if run.stdin_text {
		let mut input = tempfile::tempfile().map_err(&failed)?;
		input.write_all(text.as_bytes()).and_then(|()| input.rewind()).map_err(&failed)?;
		command = command.stdin(Fd::File(input));
	}
	host.run_command_async(command).await.map_err(&failed)
}

impl Say {
	async fn speak(&self, host: &mut Host, platform: Platform) -> Result<i32, String> {
		let asks = |option: &Option<String>| option.as_deref() == Some("?");
		if asks(&self.voice) {
			return self.list_voices(host, platform).await;
		}
		if asks(&self.device) || asks(&self.file_format) || asks(&self.data_format) || asks(&self.bit_rate) {
			return self.list_formats(host, platform).await;
		}
		if self.interactive.is_some() && self.output.is_some() {
			return Err("Can't use --interactive or -i when writing to a file".to_owned());
		}
		let text = self.text(host).await?;
		if text.trim().is_empty() {
			return Ok(0);
		}
		let output = self.output.as_deref().map(|path| self.destination(host, path));
		let output = output.as_deref();

		let speech = host.speech();
		let mut host_failure = None;
		// Only the system synthesizer sends speech over the network.
		if self.network.is_none()
			&& let Some(speech) = &speech
		{
			match self.speak_through_host(host, speech, &text, output, false).await {
				Ok(Some(code)) => return Ok(code),
				Ok(None) => {},
				Err(failure) => host_failure = Some(failure),
			}
		}
		if let Some(synthesizer) = system::find(host, platform, output.is_some()).await {
			return self.speak_through_system(host, &synthesizer, &text, output).await;
		}
		// Nothing else can speak: the host synthesizes even unconfigured.
		if host_failure.is_none()
			&& let Some(speech) = &speech
			&& let Some(code) = self.speak_through_host(host, speech, &text, output, true).await?
		{
			return Ok(code);
		}
		Err(host_failure.unwrap_or_else(no_synthesizer))
	}

	/// The text to speak: the arguments, else `-f`'s file, else standard
	/// input.
	async fn text(&self, host: &mut Host) -> Result<String, String> {
		if !self.text.is_empty() {
			return Ok(self.text.join(" "));
		}
		let bytes = match self.input.as_deref().filter(|file| *file != Path::new("-")) {
			Some(file) => host
				.vfs()
				.read(host.resolve(file))
				.await
				.map_err(|error| format!("{}: {}", file.display(), strip_errno(&error)))?,
			None => {
				let mut bytes = Vec::new();
				host
					.read_stdin_to_end(&mut bytes, TEXT_LIMIT)
					.await
					.map_err(|error| format!("stdin: {}", strip_errno(&error)))?;
				bytes
			},
		};
		Ok(String::from_utf8(bytes)
			.unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned()))
	}

	/// Where `-o path` lands: a name without an extension gets the one of
	/// `--file-format`, or `.aiff`.
	fn destination(&self, host: &Host, path: &Path) -> PathBuf {
		let mut path = host.resolve(path);
		if path.extension().is_none() {
			let extension = match self.file_format.as_deref() {
				Some(code) => format_extension(code),
				None => Some("aiff"),
			};
			if let Some(extension) = extension {
				path.set_extension(extension);
			}
		}
		path
	}

	/// Speaks through the host's synthesizer; `None` when it has none
	/// configured and was not `required`.
	async fn speak_through_host(
		&self,
		host: &mut Host,
		speech: &Arc<dyn SpeechHost>,
		text: &str,
		output: Option<&Path>,
		required: bool,
	) -> Result<Option<i32>, String> {
		let request = SpeechRequest {
			text: text.to_owned(),
			voice: self.voice.clone(),
			rate: self.rate.as_deref().and_then(system::words_per_minute),
			capture: output.is_some(),
			required,
		};
		match speech.speak(request).await.map_err(|error| strip_errno(&error))? {
			SpeechOutcome::Unconfigured => Ok(None),
			SpeechOutcome::Spoken => {
				if self.interactive.is_some() {
					let _ = writeln!(host.stdout_writer(), "{}", text.trim_end());
				}
				Ok(Some(0))
			},
			SpeechOutcome::Captured(audio) => match output {
				Some(output) => self.write_audio(host, &audio, output).await.map(Some),
				None => Ok(Some(0)),
			},
		}
	}

	/// Speaks through `synthesizer`. An output file is staged in a scratch
	/// directory and then written to `output`, so it may be a `scheme://`
	/// path the synthesizer could not open.
	async fn speak_through_system(
		&self,
		host: &mut Host,
		synthesizer: &Synthesizer,
		text: &str,
		output: Option<&Path>,
	) -> Result<i32, String> {
		let scratch = match output {
			Some(_) => Some(tempfile::tempdir().map_err(|error| strip_errno(&error))?),
			None => None,
		};
		let staged = scratch.as_ref().zip(output).map(|(scratch, output)| {
			// macOS `say` picks the format from the file's name.
			match output.file_name().filter(|_| synthesizer.engine == Engine::Say) {
				Some(name) => scratch.path().join(name),
				None => scratch.path().join("speech.wav"),
			}
		});
		let speech = Speech {
			voice:       self.voice.as_deref(),
			rate:        self.rate.as_deref(),
			output:      staged.as_deref(),
			device:      self.device.as_deref(),
			network:     self.network.as_deref(),
			progress:    self.progress,
			interactive: self.interactive.as_deref(),
			file_format: self.file_format.as_deref(),
			data_format: self.data_format.as_deref(),
			channels:    self.channels.as_deref(),
			bit_rate:    self.bit_rate.as_deref(),
			quality:     self.quality.as_deref(),
		};
		for run in synthesizer.speak(&speech, text) {
			let status = execute(host, run, text).await?;
			if !status.success() {
				return Ok(status.code());
			}
		}
		let (Some(output), Some(staged)) = (output, staged) else {
			return Ok(0);
		};
		let written = host
			.vfs()
			.read(&staged)
			.await
			.map_err(|error| format!("{}: {}", output.display(), strip_errno(&error)))?;
		if synthesizer.engine == Engine::Say {
			self.write_file(host, output, &written).await
		} else {
			let audio = audio::decode_wave(&written).map_err(|error| error.to_string())?;
			self.write_audio(host, &audio, output).await
		}
	}

	async fn write_file(&self, host: &Host, output: &Path, bytes: &[u8]) -> Result<i32, String> {
		host
			.vfs()
			.write(output, bytes)
			.await
			.map_err(|error| format!("{}: {}", output.display(), strip_errno(&error)))?;
		Ok(0)
	}

	/// Writes `audio` to `output` in the format its name and the format
	/// options ask for.
	async fn write_audio(&self, host: &mut Host, audio: &SpeechAudio, output: &Path) -> Result<i32, String> {
		let extension = output.extension().and_then(|extension| extension.to_str()).unwrap_or_default();
		let container = match self.file_format.as_deref() {
			Some(code) => Container::from_code(code),
			None => Container::from_extension(extension),
		};
		// `Some(None)`: the container's default; `None`: not linear PCM.
		let format = match self.data_format.as_deref() {
			Some(spec) => DataFormat::parse(spec).map(Some),
			None => Some(None),
		};
		let channels = self
			.channels
			.as_deref()
			.and_then(|channels| channels.trim().parse::<u16>().ok())
			.filter(|channels| (1..=64).contains(channels))
			.unwrap_or(1);
		let encoded = match (container, format) {
			(Some(container), Some(format)) => audio::encode(audio, container, format, channels),
			_ => None,
		};
		let bytes = match encoded {
			Some(bytes) => bytes,
			None => self.convert(host, audio, output, extension).await?,
		};
		self.write_file(host, output, &bytes).await
	}

	/// `audio` as the file `afconvert` makes of it for `output`: the formats
	/// only the system's codecs write (AAC, ALAC, …).
	async fn convert(
		&self,
		host: &mut Host,
		audio: &SpeechAudio,
		output: &Path,
		extension: &str,
	) -> Result<Vec<u8>, String> {
		let unsupported = || format!("{}: unsupported audio format", output.display());
		let Some(converter) = system::locate(host, AFCONVERT).await else {
			return Err(unsupported());
		};
		let source = audio::encode(audio, Container::Wave, DataFormat::parse("LEF32"), 1).ok_or_else(unsupported)?;
		let scratch = tempfile::tempdir().map_err(|error| strip_errno(&error))?;
		let source_path = scratch.path().join("speech.wav");
		let target_path = scratch.path().join(output.file_name().unwrap_or_else(|| "speech".as_ref()));
		let fs = host.vfs();
		fs.write(&source_path, &source).await.map_err(|error| strip_errno(&error))?;
		let mut argv: Vec<OsString> = vec![converter.into()];
		let data_format = self.data_format.as_deref().unwrap_or_else(|| default_codec(extension));
		for (flag, value) in [
			("-f", self.file_format.as_deref()),
			("-d", Some(data_format)),
			("-c", self.channels.as_deref()),
			("-b", self.bit_rate.as_deref()),
			("-q", self.quality.as_deref()),
		] {
			if let Some(value) = value {
				argv.push(flag.into());
				argv.push(value.into());
			}
		}
		argv.push(source_path.into());
		argv.push(target_path.clone().into());
		let status = execute(host, Run { argv, env: Vec::new(), stdin_text: false }, "").await?;
		if !status.success() {
			return Err(unsupported());
		}
		fs.read(&target_path).await.map_err(|_| unsupported())
	}

	/// `-v '?'`: the host's voices when it has a synthesizer configured, else
	/// the system synthesizer's own listing.
	async fn list_voices(&self, host: &mut Host, platform: Platform) -> Result<i32, String> {
		let speech = host.speech();
		let mut host_failure = None;
		if let Some(speech) = &speech {
			match speech.voices(false).await {
				Ok(Some(voices)) => return Ok(print_voices(host, &voices)),
				Ok(None) => {},
				Err(error) => host_failure = Some(strip_errno(&error)),
			}
		}
		if let Some(synthesizer) = system::find(host, platform, false).await {
			return Ok(execute(host, synthesizer.list_voices(), "").await?.code());
		}
		if host_failure.is_none()
			&& let Some(speech) = &speech
			&& let Some(voices) = speech.voices(true).await.map_err(|error| strip_errno(&error))?
		{
			return Ok(print_voices(host, &voices));
		}
		Err(host_failure.unwrap_or_else(no_synthesizer))
	}

	/// The `?` listings of `-a`, `--file-format`, `--data-format` and
	/// `--bit-rate`: macOS `say`'s own where there is one, else the formats
	/// [`audio`] writes.
	async fn list_formats(&self, host: &mut Host, platform: Platform) -> Result<i32, String> {
		if let Some(synthesizer) = system::find(host, platform, false).await
			&& synthesizer.engine == Engine::Say
		{
			let speech = Speech {
				output: self.output.as_deref(),
				device: self.device.as_deref(),
				file_format: self.file_format.as_deref(),
				data_format: self.data_format.as_deref(),
				channels: self.channels.as_deref(),
				bit_rate: self.bit_rate.as_deref(),
				quality: self.quality.as_deref(),
				..Speech::default()
			};
			let mut code = 0;
			for run in synthesizer.speak(&speech, "") {
				code = execute(host, run, "").await?.code();
			}
			return Ok(code);
		}
		let mut out = host.stdout_writer();
		if self.file_format.as_deref() == Some("?") {
			let _ = out.write_all(FILE_FORMATS.as_bytes());
		}
		if self.data_format.as_deref() == Some("?") {
			let _ = out.write_all(b"lpcm  Linear PCM\n");
		}
		Ok(0)
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Read};

	use futures::future::BoxFuture;
	use parking_lot::Mutex;

	use super::*;
	use crate::extras::{CommandRunner, Invocation};

	/// A host synthesizer: `configured` or not, recording what it is asked.
	#[derive(Debug, Default)]
	struct FakeSpeech {
		configured: bool,
		fails:      bool,
		requests:   Mutex<Vec<SpeechRequest>>,
	}

	impl FakeSpeech {
		fn configured() -> Arc<Self> {
			Arc::new(Self { configured: true, ..Self::default() })
		}

		fn unconfigured() -> Arc<Self> {
			Arc::new(Self::default())
		}

		fn requests(&self) -> Vec<SpeechRequest> {
			self.requests.lock().clone()
		}
	}

	impl SpeechHost for FakeSpeech {
		fn voices(&self, required: bool) -> BoxFuture<'static, std::io::Result<Option<Vec<SpeechVoice>>>> {
			let voices = (self.configured || required).then(|| {
				vec![
					SpeechVoice {
						name:   "harper".into(),
						locale: "en_US".into(),
						sample: "Harper (American female)".into(),
					},
					SpeechVoice {
						name:   "a-voice-with-a-long-name".into(),
						locale: "en_GB".into(),
						sample: "Long".into(),
					},
				]
			});
			Box::pin(async move { Ok(voices) })
		}

		fn speak(&self, request: SpeechRequest) -> BoxFuture<'static, std::io::Result<SpeechOutcome>> {
			let outcome = if self.fails {
				Err(std::io::Error::other("speech worker crashed"))
			} else if !self.configured && !request.required {
				Ok(SpeechOutcome::Unconfigured)
			} else if request.capture {
				Ok(SpeechOutcome::Captured(SpeechAudio { samples: vec![0.0, 0.5, -0.5, 0.25], sample_rate: 24_000 }))
			} else {
				Ok(SpeechOutcome::Spoken)
			};
			self.requests.lock().push(request);
			Box::pin(async move { outcome })
		}
	}

	/// One program the system fallback ran.
	#[derive(Clone, Debug, Default)]
	struct Ran {
		argv:  Vec<String>,
		stdin: String,
	}

	/// Stands in for the shell running programs: records each run and plays
	/// the synthesizer, writing `writes` to the file after `-o` or `-w`.
	#[derive(Clone, Default)]
	struct Programs {
		ran:    Arc<Mutex<Vec<Ran>>>,
		writes: Option<Vec<u8>>,
		status: u8,
	}

	impl Programs {
		fn ran(&self) -> Vec<Ran> {
			self.ran.lock().clone()
		}
	}

	impl CommandRunner for Programs {
		fn start(&mut self, mut command: ShellCommand) -> BoxFuture<'static, std::io::Result<CommandStatus>> {
			let argv: Vec<String> = command.args().iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
			let mut stdin = String::new();
			if let Some(Fd::File(mut file)) = command.take_stdin() {
				file.read_to_string(&mut stdin).expect("read the command's stdin");
			}
			if let Some(bytes) = &self.writes
				&& let Some(flag) = argv.iter().position(|arg| arg == "-o" || arg == "-w")
			{
				std::fs::write(&argv[flag + 1], bytes).expect("write the synthesizer's file");
			}
			self.ran.lock().push(Ran { argv, stdin });
			let status = self.status;
			Box::pin(async move { Ok(CommandStatus::Exited(status)) })
		}
	}

	/// A `say` run: its working directory, `PATH`, input and collaborators.
	struct Scene {
		dir:      tempfile::TempDir,
		path:     String,
		stdin:    String,
		speech:   Option<Arc<FakeSpeech>>,
		programs: Programs,
		fs:       pi_vfs::Fs,
	}

	impl Scene {
		fn new(speech: Option<Arc<FakeSpeech>>) -> Self {
			Self {
				dir: tempfile::tempdir().expect("scratch directory"),
				path: String::new(),
				stdin: String::new(),
				speech,
				programs: Programs::default(),
				fs: pi_vfs::Fs::native(),
			}
		}

		/// Makes `PATH` one directory holding an executable named `name`.
		#[cfg(unix)]
		fn install(&mut self, name: &str) {
			use std::os::unix::fs::PermissionsExt;
			let bin = self.dir.path().join("bin");
			std::fs::create_dir_all(&bin).expect("bin directory");
			let program = bin.join(name);
			std::fs::write(&program, "").expect("program file");
			std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).expect("mark executable");
			self.path = bin.to_string_lossy().into_owned();
		}

		/// Runs `say` with `args`, returning its status, stdout and stderr.
		async fn say(&self, args: &[&str]) -> (i32, String, String) {
			let mut input = tempfile::tempfile().expect("stdin file");
			input.write_all(self.stdin.as_bytes()).expect("write stdin");
			input.rewind().expect("rewind stdin");
			let output = tempfile::tempfile().expect("stdout file");
			let error = tempfile::tempfile().expect("stderr file");
			let argv = std::iter::once("say").chain(args.iter().copied()).map(str::to_owned).collect();
			let mut invocation = Invocation::new(argv, self.dir.path().to_path_buf(), self.fs.clone());
			invocation.env = HashMap::from([("PATH".to_owned(), self.path.clone())]);
			invocation.stdio = [
				Fd::File(input),
				Fd::File(output.try_clone().expect("stdout")),
				Fd::File(error.try_clone().expect("stderr")),
			];
			invocation.commands = Some(Box::new(self.programs.clone()));
			invocation.speech = self.speech.clone().map(|speech| speech as Arc<dyn SpeechHost>);
			let code = crate::extras::run(invocation).await;
			let read = |mut file: std::fs::File| {
				let mut text = String::new();
				file.rewind().expect("rewind capture");
				file.read_to_string(&mut text).expect("read capture");
				text
			};
			(code, read(output), read(error))
		}
	}

	/// A provider serving `local://<name>` from the host directory `root`,
	/// as the shell's internal URLs are served.
	#[derive(Debug)]
	struct LocalUrls {
		root: PathBuf,
	}

	impl LocalUrls {
		fn host(&self, path: &Path) -> std::io::Result<PathBuf> {
			path
				.to_str()
				.and_then(|url| url.strip_prefix("local://"))
				.map(|name| self.root.join(name))
				.ok_or_else(|| std::io::ErrorKind::NotFound.into())
		}
	}

	#[async_trait::async_trait]
	impl pi_vfs::FileSystem for LocalUrls {
		fn is_native_local(&self, path: &Path) -> bool {
			!pi_vfs::is_virtual_path(path)
		}

		async fn open(&self, path: &Path, options: &pi_vfs::OpenOptions) -> std::io::Result<pi_vfs::File> {
			let file = std::fs::OpenOptions::new()
				.read(options.is_read())
				.write(options.is_write())
				.append(options.is_append())
				.truncate(options.is_truncate())
				.create(options.is_create())
				.create_new(options.is_create_new())
				.open(self.host(path)?)?;
			Ok(file.into())
		}

		async fn metadata(&self, path: &Path) -> std::io::Result<pi_vfs::Metadata> {
			pi_vfs::Metadata::from_file(&std::fs::File::open(self.host(path)?)?)
		}

		async fn read_dir(&self, _path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
			Err(std::io::ErrorKind::NotFound.into())
		}
	}

	/// Contract: `-f` and `-o` take the shell's `scheme://` paths: the text is
	/// read through the shell's filesystem and the audio written through it,
	/// where no synthesizer program could open either.
	#[tokio::test(flavor = "multi_thread")]
	async fn input_and_output_files_may_be_internal_urls() {
		let speech = FakeSpeech::configured();
		let mut scene = Scene::new(Some(Arc::clone(&speech)));
		let store = tempfile::tempdir().expect("url store");
		std::fs::write(store.path().join("notes.md"), "from a url").expect("notes");
		scene.fs = pi_vfs::Fs::new(Arc::new(LocalUrls { root: store.path().to_path_buf() }));

		let ran = scene.say(&["-f", "local://notes.md", "-o", "local://spoken"]).await;
		assert_eq!(ran, (0, String::new(), String::new()));
		assert_eq!(speech.requests()[0].text, "from a url");
		let written = std::fs::read(store.path().join("spoken.aiff")).expect("the file behind local://spoken.aiff");
		assert_eq!(&written[8..12], b"AIFC");

		let (code, _, stderr) = scene.say(&["-f", "local://absent.md"]).await;
		assert_eq!(code, 1);
		assert!(stderr.starts_with("say: local://absent.md: "), "{stderr}");
	}

	/// The name of the synthesizer this platform falls back to first.
	#[cfg(unix)]
	const SYSTEM_SYNTHESIZER: &str = if cfg!(target_os = "macos") { "say" } else { "espeak-ng" };

	/// Contract: with the host's synthesizer configured, `say` speaks through
	/// it with the voice and rate asked for and starts no system program.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_configured_host_speaks_the_arguments_with_voice_and_rate() {
		let speech = FakeSpeech::configured();
		let scene = Scene::new(Some(Arc::clone(&speech)));
		let (code, stdout, stderr) = scene.say(&["-v", "Harper", "--rate=210", "hello", "wide world"]).await;
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(speech.requests(), [SpeechRequest {
			text:     "hello wide world".into(),
			voice:    Some("Harper".into()),
			rate:     Some(210),
			capture:  false,
			required: false,
		}]);
		assert!(scene.programs.ran().is_empty());
	}

	/// Contract: the text is the arguments, else `-f`'s file, else standard
	/// input (`-f -` too); a missing file fails and nothing to say is no
	/// speech at all.
	#[tokio::test(flavor = "multi_thread")]
	async fn text_comes_from_arguments_then_the_file_then_stdin() {
		let speech = FakeSpeech::configured();
		let mut scene = Scene::new(Some(Arc::clone(&speech)));
		std::fs::write(scene.dir.path().join("notes.txt"), "from the file\n").expect("notes");
		scene.stdin = "from stdin\n".into();

		assert_eq!(scene.say(&[]).await.0, 0);
		assert_eq!(scene.say(&["--input-file", "notes.txt"]).await.0, 0);
		assert_eq!(scene.say(&["-f", "-"]).await.0, 0);
		assert_eq!(scene.say(&["-f", "notes.txt", "from", "arguments"]).await.0, 0);
		let spoken: Vec<String> = speech.requests().into_iter().map(|request| request.text).collect();
		assert_eq!(spoken, ["from stdin\n", "from the file\n", "from stdin\n", "from arguments"]);

		let (code, _, stderr) = scene.say(&["-f", "missing.txt"]).await;
		assert_eq!(code, 1);
		assert!(stderr.starts_with("say: missing.txt: "), "{stderr}");
		scene.stdin = " \n".into();
		assert_eq!(scene.say(&[]).await, (0, String::new(), String::new()));
		assert_eq!(speech.requests().len(), 4, "neither run reached the synthesizer");
	}

	/// Contract: `-o` through the host writes the audio itself, in the
	/// container the name or `--file-format` asks for; a bare name becomes
	/// `.aiff` as macOS `say` makes it.
	#[tokio::test(flavor = "multi_thread")]
	async fn output_files_take_their_format_from_the_name_and_options() {
		let speech = FakeSpeech::configured();
		let scene = Scene::new(Some(Arc::clone(&speech)));
		let file = |name: &str| std::fs::read(scene.dir.path().join(name)).expect("output file");

		assert_eq!(scene.say(&["-o", "plain.wav", "--channels=2", "hi"]).await, (0, String::new(), String::new()));
		let wave = file("plain.wav");
		assert_eq!(&wave[..4], b"RIFF");
		assert_eq!(u16::from_le_bytes([wave[22], wave[23]]), 2);
		assert_eq!(audio::decode_wave(&wave).expect("a WAVE file").samples.len(), 4);
		assert!(speech.requests()[0].capture);

		assert_eq!(scene.say(&["-o", "bare", "hi"]).await.0, 0);
		assert_eq!(&file("bare.aiff")[8..12], b"AIFC");
		assert_eq!(scene.say(&["--output-file=other", "--file-format=caff", "--data-format=LEF32@12000", "hi"]).await.0, 0);
		let caf = file("other.caf");
		assert_eq!(&caf[..4], b"caff");
		assert_eq!(&caf[20..28], &12_000f64.to_be_bytes());

		let (code, _, stderr) = scene.say(&["-i", "-o", "x.aiff", "hi"]).await;
		assert_eq!((code, stderr.as_str()), (1, "say: Can't use --interactive or -i when writing to a file\n"));
	}

	/// Contract: `-v '?'` lists the host's voices in `say`'s columns when it
	/// has a synthesizer configured.
	#[tokio::test(flavor = "multi_thread")]
	async fn voice_listing_shows_the_configured_hosts_voices() {
		let scene = Scene::new(Some(FakeSpeech::configured()));
		let (code, stdout, _) = scene.say(&["-v", "?"]).await;
		assert_eq!(code, 0);
		assert_eq!(
			stdout,
			"harper              en_US    # Harper (American female)\na-voice-with-a-long-name en_GB    # Long\n"
		);
		assert!(scene.programs.ran().is_empty());
	}

	/// Contract: an unconfigured host is asked once, without `required`, and
	/// the system synthesizer on `PATH` then speaks the text from its stdin;
	/// its exit status is `say`'s.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn an_unconfigured_host_falls_back_to_the_system_synthesizer() {
		let speech = FakeSpeech::unconfigured();
		let mut scene = Scene::new(Some(Arc::clone(&speech)));
		scene.install(SYSTEM_SYNTHESIZER);
		scene.programs.status = 3;
		let (code, ..) = scene.say(&["-r", "200", "hello there"]).await;
		assert_eq!(code, 3);
		let requests = speech.requests();
		assert_eq!(requests.len(), 1);
		assert!(!requests[0].required);
		let ran = scene.programs.ran();
		assert_eq!(ran.len(), 1);
		assert!(Path::new(&ran[0].argv[0]).ends_with(Path::new("bin").join(SYSTEM_SYNTHESIZER)), "{:?}", ran[0].argv);
		assert_eq!(ran[0].stdin, "hello there");
		let rate_flag = if cfg!(target_os = "macos") { "-r" } else { "-s" };
		let rate = ran[0].argv.iter().position(|arg| arg == rate_flag).expect("rate option");
		assert_eq!(ran[0].argv[rate + 1], "200");
	}

	/// Contract: a host synthesizer that fails does not silence `say`: the
	/// system synthesizer speaks instead; so does `-n`, which only the
	/// system's honors, and a run with no host at all.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn the_system_synthesizer_covers_what_the_host_cannot() {
		let failing = Arc::new(FakeSpeech { configured: true, fails: true, ..FakeSpeech::default() });
		let mut scene = Scene::new(Some(Arc::clone(&failing)));
		scene.install(SYSTEM_SYNTHESIZER);
		assert_eq!(scene.say(&["hello"]).await, (0, String::new(), String::new()));
		assert_eq!(scene.programs.ran().len(), 1);

		let configured = FakeSpeech::configured();
		let mut scene = Scene::new(Some(Arc::clone(&configured)));
		scene.install(SYSTEM_SYNTHESIZER);
		assert_eq!(scene.say(&["-n", "studio:52800", "hello"]).await.0, 0);
		assert!(configured.requests().is_empty());
		assert_eq!(scene.programs.ran().len(), 1);

		let mut scene = Scene::new(None);
		scene.install(SYSTEM_SYNTHESIZER);
		scene.stdin = "piped".into();
		assert_eq!(scene.say(&[]).await.0, 0);
		assert_eq!(scene.programs.ran()[0].stdin, "piped");
	}

	/// Contract: the system synthesizer's `-o` file reaches the requested
	/// path: macOS `say`'s bytes as written, eSpeak's WAVE re-encoded into the
	/// container the name asks for.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_system_output_file_lands_at_the_requested_path() {
		let audio = SpeechAudio { samples: vec![0.25; 8], sample_rate: 22_050 };
		let wave = audio::encode(&audio, Container::Wave, None, 1).expect("WAVE");
		let mut scene = Scene::new(None);
		scene.install(SYSTEM_SYNTHESIZER);
		scene.programs.writes = Some(wave.clone());
		assert_eq!(scene.say(&["-o", "spoken.aiff", "hello"]).await, (0, String::new(), String::new()));
		let written = std::fs::read(scene.dir.path().join("spoken.aiff")).expect("output file");
		if cfg!(target_os = "macos") {
			assert_eq!(written, wave);
		} else {
			assert_eq!(&written[8..12], b"AIFC");
		}
		let staged = &scene.programs.ran()[0].argv;
		let flag = staged.iter().position(|arg| arg == "-o" || arg == "-w").expect("output option");
		assert!(!Path::new(&staged[flag + 1]).exists(), "the staging directory is removed");
	}

	/// Contract: with no system synthesizer the host speaks even though it
	/// is not configured, rather than `say` failing.
	#[cfg(all(unix, not(target_os = "macos")))]
	#[tokio::test(flavor = "multi_thread")]
	async fn the_host_speaks_when_nothing_else_can() {
		let speech = FakeSpeech::unconfigured();
		let scene = Scene::new(Some(Arc::clone(&speech)));
		assert_eq!(scene.say(&["hello"]).await, (0, String::new(), String::new()));
		let required: Vec<bool> = speech.requests().iter().map(|request| request.required).collect();
		assert_eq!(required, [false, true]);

		let (code, _, stderr) = Scene::new(None).say(&["hello"]).await;
		assert_eq!((code, stderr.as_str()), (1, "say: no speech synthesizer available\n"));
	}

	/// Contract: macOS always has `/usr/bin/say`, even off `PATH`, and the
	/// voice listing of an unconfigured host is the system's.
	#[cfg(target_os = "macos")]
	#[tokio::test(flavor = "multi_thread")]
	async fn macos_falls_back_to_usr_bin_say_off_path() {
		let scene = Scene::new(Some(FakeSpeech::unconfigured()));
		assert_eq!(scene.say(&["-v", "?"]).await.0, 0);
		assert_eq!(scene.say(&["--file-format=?"]).await.0, 0);
		let ran: Vec<Vec<String>> = scene.programs.ran().into_iter().map(|ran| ran.argv).collect();
		assert_eq!(ran, [vec!["/usr/bin/say", "-v", "?"], vec!["/usr/bin/say", "--file-format=?"]]);
	}

	/// Contract: an option `say` does not have is a usage error, status 1.
	#[tokio::test(flavor = "multi_thread")]
	async fn an_unknown_option_is_a_usage_error() {
		let speech = FakeSpeech::configured();
		let scene = Scene::new(Some(Arc::clone(&speech)));
		let (code, _, stderr) = scene.say(&["--bogus", "hi"]).await;
		assert_eq!(code, 1);
		assert!(stderr.contains("--bogus"), "{stderr}");
		assert!(speech.requests().is_empty());
	}
}
