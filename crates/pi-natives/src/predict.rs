//! Word-completion engines exposed to JavaScript.
//!
//! [`TextPredictor`] owns one [`pi_predict::Predictor`] on a dedicated engine
//! thread, so inference, learning, and persistence never block the JS thread
//! and each engine keeps a stable thread identity (required by `AppKit` for the
//! `apple` method). The text-prediction daemon creates one per active method.

use napi::{Error, Result, Status};
use napi_derive::napi;
use pi_predict::{Config, Method, Predictor, Query};

/// Options for [`TextPredictor::new`].
#[napi(object)]
pub struct TextPredictorOptions {
	/// Engine: `ngram`, `smollm`, or `apple`.
	pub method:         String,
	/// Private directory for persisted learned state.
	pub state_dir:      String,
	/// Directory holding downloaded model weights (`smollm` only).
	pub model_dir:      Option<String>,
	/// Show threshold override; omit for the engine's tuned default.
	pub show_threshold: Option<f64>,
}

/// Ghost text for the word being typed.
#[napi(object)]
pub struct PredictedWord {
	/// Characters to paint after the typed prefix.
	pub suffix:     String,
	/// Engine-calibrated probability that `suffix` is exactly right.
	pub confidence: f64,
}

type Engine = std::result::Result<Box<dyn Predictor>, String>;
type Job = Box<dyn FnOnce(&mut Engine) + Send>;

fn open_engine(options: &TextPredictorOptions) -> Engine {
	let config = Config {
		state_dir:      options.state_dir.clone().into(),
		model_dir:      options.model_dir.clone().map(Into::into),
		#[allow(clippy::cast_possible_truncation, reason = "thresholds are probabilities")]
		show_threshold: options.show_threshold.map(|value| value as f32),
	};
	let opened = Method::parse(&options.method).and_then(|method| pi_predict::open(method, &config));
	opened.map_err(|error| format!("{error:#}"))
}

/// One word-completion engine running on its own thread.
#[napi]
pub struct TextPredictor {
	jobs: flume::Sender<Job>,
}

#[napi]
impl TextPredictor {
	/// Spawn the engine thread and start opening the engine; load errors
	/// surface from [`TextPredictor::ready`] and every later call.
	///
	/// # Errors
	/// Returns an error when the engine thread cannot be spawned.
	#[napi(constructor)]
	pub fn new(options: TextPredictorOptions) -> Result<Self> {
		let (jobs, queue) = flume::unbounded::<Job>();
		std::thread::Builder::new()
			.name(format!("pi-predict-{}", options.method))
			.spawn(move || {
				let mut engine = open_engine(&options);
				while let Ok(job) = queue.recv() {
					job(&mut engine);
				}
			})
			.map_err(|error| {
				Error::new(Status::GenericFailure, format!("spawn engine thread: {error}"))
			})?;
		Ok(Self { jobs })
	}

	async fn run<T: Send + 'static>(
		&self,
		work: impl FnOnce(&mut Box<dyn Predictor>) -> anyhow::Result<T> + Send + 'static,
	) -> Result<T> {
		let (reply, result) = flume::bounded(1);
		self
			.jobs
			.send(Box::new(move |engine: &mut Engine| {
				let outcome = match engine {
					Ok(engine) => work(engine).map_err(|error| format!("{error:#}")),
					Err(error) => Err(error.clone()),
				};
				let _ = reply.send(outcome);
			}))
			.map_err(|_| Error::new(Status::GenericFailure, "text prediction engine stopped"))?;
		result
			.recv_async()
			.await
			.map_err(|_| Error::new(Status::GenericFailure, "text prediction engine stopped"))?
			.map_err(|message| Error::new(Status::GenericFailure, message))
	}

	/// Resolve once the engine has loaded.
	///
	/// # Errors
	/// Rejects with the engine's load error (missing weights, corrupt state).
	#[napi]
	pub async fn ready(&self) -> Result<()> {
		self.run(|_| Ok(())).await
	}

	/// Ghost text for `prefix` typed after `before`, or `null`.
	///
	/// # Errors
	/// Rejects when the engine failed to load.
	#[napi]
	pub async fn complete(&self, before: String, prefix: String) -> Result<Option<PredictedWord>> {
		self
			.run(move |engine| {
				Ok(engine
					.complete(&Query { before: &before, prefix: &prefix })
					.map(|hint| PredictedWord {
						suffix:     hint.suffix,
						confidence: f64::from(hint.confidence),
					}))
			})
			.await
	}

	/// Learn from submitted prompts, in submission order.
	///
	/// # Errors
	/// Rejects when the engine failed to load.
	#[napi]
	pub async fn observe(&self, prompts: Vec<String>) -> Result<()> {
		self
			.run(move |engine| {
				for prompt in &prompts {
					engine.observe(prompt);
				}
				Ok(())
			})
			.await
	}

	/// Learn from a suggestion the user accepted (`true`) or typed past.
	///
	/// # Errors
	/// Rejects when the engine failed to load.
	#[napi]
	pub async fn feedback(
		&self,
		before: String,
		prefix: String,
		suggestion: String,
		accepted: bool,
	) -> Result<()> {
		self
			.run(move |engine| {
				engine.feedback(&Query { before: &before, prefix: &prefix }, &suggestion, accepted);
				Ok(())
			})
			.await
	}

	/// Flush learned state to the state directory.
	///
	/// # Errors
	/// Rejects when the engine failed to load or the state cannot be written.
	#[napi]
	pub async fn persist(&self) -> Result<()> {
		self.run(|engine| engine.persist()).await
	}
}
