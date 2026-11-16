//! Inline images: protocol encoding behind pi-tui's `Image` component.
//!
//! A component holds one napi [`InlineImage`] per image (the base64 data,
//! its pixel size, and its budget id) and calls
//! [`render`](InlineImage::render) once per pass with the geometry and
//! terminal facts of that pass. The call observes the image in its
//! [`ImageBudget`](super::budget::ImageBudget) (display order, demotion),
//! encodes whatever the protocol needs — Kitty direct placements or
//! Unicode-placeholder grids, iTerm2 inline images, SIXEL rasters — queues
//! a Kitty data transmit in the budget, and answers with the rows to render,
//! the text-fallback decision, or "unchanged" so the component reuses the
//! rows it already holds. The base64 never crosses back into JavaScript
//! except inside the rows of the protocols that carry it in-line.
//!
//! SIXEL encodes run off the JS thread: the image reserves its rows while
//! one is pending and the `onEncoded` callback of the render that started it
//! asks for the repaint that shows it. A render bound for native scrollback
//! cannot wait and encodes synchronously.
//!
//! Ported from pi-tui's `renderImage` (`terminal-capabilities.ts`),
//! `kitty-graphics.ts` and the `Image` component's cache.

mod encode;
mod sniff;

use std::{
	cell::RefCell,
	rc::Rc,
	sync::{Arc, Mutex},
};

use encode::CellSize;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use super::{
	budget::{ImageBudget, SharedBudget},
	js::EngineImageProtocol,
	screen::images::ensure_sixel_raster_width,
	types::ImageProtocol,
};
use crate::task;

/// Fallback size of an image whose header does not parse.
const UNKNOWN_SIZE: Dimensions = Dimensions { width_px: 800.0, height_px: 600.0 };

/// Leading rows a direct placement reserves above its payload row. Non-plain
/// so transcript blank-edge trimming does not collapse image-only blocks.
const RESERVED_IMAGE_ROW: &str = "\x1b[0m";

/// Image size in pixels.
#[napi(object)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImageDimensions {
	pub width_px:  f64,
	pub height_px: f64,
}

type Dimensions = ImageDimensions;

/// Pixel size of base64 image `data` from its PNG/JPEG/GIF/WebP header;
/// `null` for another type or a header that does not parse.
#[napi]
pub fn image_dimensions(data: String, mime_type: String) -> Option<ImageDimensions> {
	sniff::base64_dimensions(&data, &mime_type).map(|size| ImageDimensions {
		width_px:  f64::from(size.width_px),
		height_px: f64::from(size.height_px),
	})
}

/// One render pass of an [`InlineImage`]: its box and the terminal facts the
/// rows depend on.
#[napi(object)]
pub struct ImageRenderRequest {
	/// Inline image protocol in use (`TERMINAL.imageProtocol`); absent
	/// renders the text fallback.
	#[napi(ts_type = "\"kitty\" | \"iterm2\" | \"sixel\"")]
	pub protocol:           Option<EngineImageProtocol>,
	/// Widest the image may draw, in columns.
	pub max_columns:        f64,
	/// Tallest the image may draw, in rows.
	pub max_rows:           Option<f64>,
	/// Terminal cell size in pixels.
	pub cell_width_px:      f64,
	pub cell_height_px:     f64,
	/// Kitty images display through Unicode placeholders
	/// (`TERMINAL.kittyUnicodePlaceholders`).
	pub kitty_placeholders: bool,
	/// Kitty commands ride tmux's passthrough envelope (`TERMINAL.tmux`).
	pub tmux:               bool,
	/// Background SIXEL compositing fills translucent pixels with, `0xRRGGBB`.
	pub background_rgb:     u32,
	/// The rows are bound for native scrollback, which is never repainted: a
	/// SIXEL encode cannot wait for the off-thread encoder.
	pub scrollback:         bool,
	/// An out-of-order measuring render (`measureRender`), which claims no
	/// display slot in the budget.
	pub measuring:          bool,
	/// The caller still holds the rows the previous render returned, so an
	/// unchanged image answers `null` instead of rebuilding them.
	pub cached:             bool,
}

/// What a render answers.
#[derive(Debug, PartialEq, Eq)]
enum Frame {
	/// The rows the caller holds are still current.
	Unchanged,
	/// The image's rows.
	Rows(Vec<String>),
	/// Render the text fallback, padded to this many rows (the tallest
	/// graphic the image drew, so a demotion never shrinks its block).
	Fallback(u32),
}

/// [`ImageRenderRequest`] with the protocol resolved.
#[derive(Clone, Copy, Debug)]
struct Request {
	protocol:           Option<ImageProtocol>,
	max_columns:        f64,
	max_rows:           Option<f64>,
	cell:               CellSize,
	kitty_placeholders: bool,
	tmux:               bool,
	background_rgb:     u32,
	scrollback:         bool,
	measuring:          bool,
	cached:             bool,
}

impl From<&ImageRenderRequest> for Request {
	fn from(request: &ImageRenderRequest) -> Self {
		Self {
			protocol:           request.protocol.map(Into::into),
			max_columns:        request.max_columns,
			max_rows:           request.max_rows,
			cell:               CellSize {
				width_px:  request.cell_width_px,
				height_px: request.cell_height_px,
			},
			kitty_placeholders: request.kitty_placeholders,
			tmux:               request.tmux,
			background_rgb:     request.background_rgb,
			scrollback:         request.scrollback,
			measuring:          request.measuring,
			cached:             request.cached,
		}
	}
}

/// Everything the rows of the last render depend on.
#[derive(Clone, Copy, Debug, PartialEq)]
struct RenderKey {
	max_columns:        f64,
	max_rows:           Option<f64>,
	suppressed:         bool,
	protocol:           Option<ImageProtocol>,
	cell:               CellSize,
	/// Compositing background, for SIXEL only.
	sixel_background:   Option<u32>,
	kitty_placeholders: bool,
	tmux:               bool,
}

/// The last render: its key and whether it reserved rows for a SIXEL
/// encode still running.
#[derive(Clone, Copy, Debug)]
struct Rendered {
	key:           RenderKey,
	sixel_pending: bool,
}

/// A SIXEL encode: target size, compositing background, and outcome.
#[derive(Debug)]
struct SixelEncode {
	generation:     u64,
	width_px:       u32,
	height_px:      u32,
	background_rgb: u32,
	state:          SixelState,
}

/// The newest SIXEL encode, shared with the settlement of an off-thread
/// encode. A settlement for an older generation is stale and dropped.
#[derive(Debug, Default)]
struct SixelSlot {
	current:         Option<SixelEncode>,
	next_generation: u64,
}

impl SixelSlot {
	fn replace(&mut self, width_px: u32, height_px: u32, background_rgb: u32) -> u64 {
		self.next_generation += 1;
		let generation = self.next_generation;
		self.current = Some(SixelEncode {
			generation,
			width_px,
			height_px,
			background_rgb,
			state: SixelState::Pending,
		});
		generation
	}
}

/// An off-thread SIXEL encode for the render to start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SixelJob {
	generation:     u64,
	width_px:       u32,
	height_px:      u32,
	background_rgb: u32,
}

/// Where a SIXEL encode stands.
#[derive(Clone, Debug)]
enum SixelState {
	Pending,
	Failed,
	Ready(String),
}

/// A protocol rendering of the image.
enum Graphic {
	/// Unicode-placeholder text rows (the first carries the virtual
	/// placement); no cursor moves.
	Lines(Vec<String>),
	/// A direct placement of `rows` rows; `None` while its SIXEL encode is
	/// pending.
	Placement { sequence: Option<String>, rows: u32 },
}

/// Encode base64 `data` as SIXEL on the calling thread; `None` when the
/// image does not decode or encode.
fn encode_sixel(data: &str, job: SixelJob) -> Option<String> {
	let bytes = sniff::decode_base64(data)?;
	let sequence =
		crate::sixel::encode_image(&bytes, job.width_px, job.height_px, job.background_rgb).ok()?;
	Some(match ensure_sixel_raster_width(&sequence) {
		std::borrow::Cow::Borrowed(_) => sequence,
		std::borrow::Cow::Owned(widened) => widened,
	})
}

/// One inline image of a pi-tui `Image` component (or attachment chip): its
/// base64 data, pixel size, budget id, and the render cache.
#[napi]
pub struct InlineImage {
	data:                  Arc<str>,
	size:                  Dimensions,
	budget:                Option<SharedBudget>,
	image_id:              Option<u32>,
	rendered:              Option<Rendered>,
	/// Tallest graphic placement this image has rendered. The text fallback
	/// pads itself to this height so a budget demotion never shrinks the
	/// block (its rows may already be committed to native scrollback).
	rendered_graphic_rows: u32,
	/// Row ceiling of the last render; lowering it clamps
	/// `rendered_graphic_rows`.
	max_rows:              Option<f64>,
	suppressed:            bool,
	sixel:                 Rc<RefCell<SixelSlot>>,
}

#[napi]
impl InlineImage {
	/// `data`: base64 image bytes. `dimensions`: the pixel size when the
	/// caller knows it; otherwise the header is sniffed, falling back to
	/// 800×600.
	#[napi(constructor)]
	pub fn new(data: String, mime_type: String, dimensions: Option<ImageDimensions>) -> Self {
		let size = dimensions
			.or_else(|| image_dimensions_of(&data, &mime_type))
			.unwrap_or(UNKNOWN_SIZE);
		Self::with_size(data.into(), size)
	}

	/// Render against `budget`: a stable graphics id for `key` (fresh when
	/// absent), observed in display order on every render, with Kitty data
	/// transmitted once through the budget. Returns the id.
	#[napi]
	pub fn use_budget(&mut self, budget: &ImageBudget, key: Option<String>) -> u32 {
		let shared = budget.shared();
		let id = shared.borrow_mut().acquire_id(key.as_deref());
		self.budget = Some(shared);
		self.image_id = Some(id);
		id
	}

	#[napi(getter)]
	pub const fn width_px(&self) -> f64 {
		self.size.width_px
	}

	#[napi(getter)]
	pub const fn height_px(&self) -> f64 {
		self.size.height_px
	}

	/// The budget id, if the image renders against a budget.
	#[napi(getter)]
	pub const fn image_id(&self) -> Option<u32> {
		self.image_id
	}

	/// Whether the last render was demoted to text by the budget.
	#[napi(getter)]
	pub const fn suppressed(&self) -> bool {
		self.suppressed
	}

	/// Retire the image's graphic as soon as no frame shows it: for an owner
	/// closing it for good.
	#[napi]
	pub fn release(&self) {
		if let (Some(budget), Some(id)) = (&self.budget, self.image_id) {
			budget.borrow_mut().release_id(id);
		}
	}

	/// Render one pass: the image's rows, the text-fallback row count, or
	/// `null` when the rows the caller holds (`cached`) are still current.
	///
	/// `onEncoded(backgroundRgb)` runs when an off-thread SIXEL encode this
	/// render starts lands while still the image's current request, so the
	/// image can repaint. It is held only while that encode runs: a callback
	/// kept for the image's lifetime would pin its owner through the native
	/// reference.
	#[napi(ts_return_type = "string[] | number | null")]
	pub fn render(
		&mut self,
		env: Env,
		request: ImageRenderRequest,
		on_encoded: Option<Function<u32, ()>>,
	) -> Result<Option<Either<Vec<String>, u32>>> {
		let mut job = None;
		let frame = self.render_frame(&Request::from(&request), &mut |started| job = Some(started));
		if let Some(job) = job {
			let on_encoded = on_encoded
				.map(|callback| callback.create_ref())
				.transpose()?;
			self.spawn_sixel_encode(&env, job, on_encoded)?;
		}
		Ok(match frame {
			Frame::Unchanged => None,
			Frame::Rows(rows) => Some(Either::A(rows)),
			Frame::Fallback(rows) => Some(Either::B(rows)),
		})
	}
}

fn image_dimensions_of(data: &str, mime_type: &str) -> Option<Dimensions> {
	sniff::base64_dimensions(data, mime_type).map(|size| Dimensions {
		width_px:  f64::from(size.width_px),
		height_px: f64::from(size.height_px),
	})
}

impl InlineImage {
	fn with_size(data: Arc<str>, size: Dimensions) -> Self {
		Self {
			data,
			size,
			budget: None,
			image_id: None,
			rendered: None,
			rendered_graphic_rows: 0,
			max_rows: None,
			suppressed: false,
			sixel: Rc::default(),
		}
	}

	/// The render pass behind [`render`](Self::render); `start_encode`
	/// receives an off-thread SIXEL encode to run.
	fn render_frame(&mut self, request: &Request, start_encode: &mut dyn FnMut(SixelJob)) -> Frame {
		// A lowered row ceiling keeps a demoted fallback's height only within
		// it: the owner chose to shrink the block.
		if let Some(max_rows) = request.max_rows
			&& self.max_rows != Some(max_rows)
		{
			self.rendered_graphic_rows = self.rendered_graphic_rows.min(max_rows.max(0.0) as u32);
		}
		self.max_rows = request.max_rows;

		let protocol = request.protocol;
		// Observe on every pass — even an unchanged one — so the image keeps
		// its display-order slot. Only graphics-capable frames count toward
		// (and are demoted by) the budget; without a protocol every image is
		// already text.
		let suppressed = match (&self.budget, protocol) {
			(Some(budget), Some(_)) => budget
				.borrow_mut()
				.observe(self.image_id.unwrap_or(0), request.measuring),
			_ => false,
		};
		self.suppressed = suppressed;
		// Only Kitty images with a budget id transmit their data apart from the
		// placement; a pending re-transmit (after a purge or history clear)
		// must rebuild the rows. SIXEL and iTerm2 carry the image inside the
		// row itself and never register a transmit.
		let transmit_id = match (&self.budget, self.image_id) {
			(Some(budget), Some(id))
				if protocol == Some(ImageProtocol::Kitty) && budget.borrow().should_transmit(id) =>
			{
				Some(id)
			},
			_ => None,
		};
		let key = RenderKey {
			max_columns: request.max_columns,
			max_rows: request.max_rows,
			suppressed,
			protocol,
			cell: request.cell,
			sixel_background: (protocol == Some(ImageProtocol::Sixel))
				.then_some(request.background_rgb),
			kitty_placeholders: request.kitty_placeholders,
			tmux: request.tmux,
		};
		if request.cached
			&& transmit_id.is_none()
			&& let Some(rendered) = self.rendered
			&& rendered.key == key
			// Rows reserved for a pending SIXEL encode must not reach
			// scrollback, and are replaced once the encode lands.
			&& !(rendered.sixel_pending && (request.scrollback || self.sixel_settled()))
		{
			return Frame::Unchanged;
		}

		let mut sixel_pending = false;
		let frame = if protocol.is_some() && !suppressed {
			let graphic = self.render_graphic(request, transmit_id, start_encode, &mut sixel_pending);
			let frame = match graphic {
				Some(Graphic::Lines(lines)) => Frame::Rows(lines),
				Some(Graphic::Placement { sequence, rows }) => {
					// The renderer crops a block straddling the viewport top from
					// the source height: the SIXEL raster, or the Kitty
					// placement's visible source slice.
					if let (Some(budget), Some(id)) = (&self.budget, self.image_id) {
						budget
							.borrow_mut()
							.register_placement_height(id, self.size.height_px);
					}
					Frame::Rows(direct_placement_rows(sequence.as_deref().unwrap_or(""), rows))
				},
				None => Frame::Fallback(self.rendered_graphic_rows.max(1)),
			};
			let drawn = match &frame {
				Frame::Rows(rows) => rows.len() as u32,
				Frame::Fallback(rows) => *rows,
				Frame::Unchanged => 0,
			};
			self.rendered_graphic_rows = self.rendered_graphic_rows.max(drawn);
			frame
		} else {
			Frame::Fallback(self.rendered_graphic_rows.max(1))
		};
		self.rendered = Some(Rendered { key, sixel_pending });
		frame
	}

	/// Whether the newest SIXEL encode has settled.
	fn sixel_settled(&self) -> bool {
		self
			.sixel
			.borrow()
			.current
			.as_ref()
			.is_some_and(|encode| !matches!(encode.state, SixelState::Pending))
	}

	/// The protocol rendering of the image (`renderImage`), or `None` when it
	/// cannot render (a failed SIXEL encode).
	fn render_graphic(
		&self,
		request: &Request,
		transmit_id: Option<u32>,
		start_encode: &mut dyn FnMut(SixelJob),
		sixel_pending: &mut bool,
	) -> Option<Graphic> {
		let fit = encode::fit(
			self.size.width_px,
			self.size.height_px,
			Some(request.max_columns),
			request.max_rows,
			request.cell,
		);
		let tmux = request.tmux;
		match request.protocol? {
			ImageProtocol::Kitty => {
				let (Some(budget), Some(id)) = (&self.budget, self.image_id) else {
					// No stable id: self-contained transmit-and-display.
					return Some(Graphic::Placement {
						sequence: Some(encode::kitty_transmit_and_display(&self.data, fit, tmux)),
						rows:     fit.rows,
					});
				};
				// Transmit once, keyed by id; repaints reuse the stored image.
				if transmit_id.is_some() {
					budget
						.borrow_mut()
						.enqueue_transmit(id, encode::kitty_transmit(&self.data, id, tmux));
				}
				// Unicode placeholders render the image as real text cells (which
				// survive horizontal slicing, reflow and overlaps) instead of a
				// cursor-positioned `a=p` placement. Direct placement when they
				// are off or the grid exceeds the diacritic table.
				if request.kitty_placeholders && encode::kitty_placeholders_fit(fit) {
					return Some(Graphic::Lines(encode::kitty_placeholder_lines(id, id, fit, tmux)));
				}
				// Direct placement: repaints re-emit only the tiny `a=p`.
				Some(Graphic::Placement {
					sequence: Some(encode::kitty_placement(id, id, fit, tmux)),
					rows:     fit.rows,
				})
			},
			ImageProtocol::Sixel => {
				let sixel_box = encode::sixel_box(fit, request.cell);
				let job = SixelJob {
					generation:     0,
					width_px:       sixel_box.width_px,
					height_px:      sixel_box.height_px,
					background_rgb: request.background_rgb,
				};
				match self.sixel_sequence(job, request.scrollback, start_encode) {
					SixelState::Failed => None,
					SixelState::Pending => {
						// The rows stay reserved until the encode lands.
						*sixel_pending = true;
						Some(Graphic::Placement { sequence: None, rows: sixel_box.rows })
					},
					SixelState::Ready(sequence) => {
						Some(Graphic::Placement { sequence: Some(sequence), rows: sixel_box.rows })
					},
				}
			},
			ImageProtocol::Iterm2 => Some(Graphic::Placement {
				sequence: Some(encode::iterm2_inline(&self.data, fit)),
				rows:     fit.rows,
			}),
		}
	}

	/// The SIXEL sequence for a target size and background. A change starts
	/// an off-thread encode and answers pending until it settles; a render
	/// bound for scrollback cannot wait, so it encodes synchronously
	/// (replacing the request, so a still-running encode settles as stale).
	fn sixel_sequence(
		&self,
		job: SixelJob,
		scrollback: bool,
		start_encode: &mut dyn FnMut(SixelJob),
	) -> SixelState {
		let mut slot = self.sixel.borrow_mut();
		let same = slot.current.as_ref().filter(|current| {
			current.width_px == job.width_px
				&& current.height_px == job.height_px
				&& current.background_rgb == job.background_rgb
		});
		if let Some(current) = same
			&& !matches!(current.state, SixelState::Pending)
		{
			return current.state.clone();
		}
		if scrollback {
			slot.replace(job.width_px, job.height_px, job.background_rgb);
			let state = encode_sixel(&self.data, job).map_or(SixelState::Failed, SixelState::Ready);
			if let Some(current) = &mut slot.current {
				current.state = state.clone();
			}
			return state;
		}
		if same.is_some() {
			return SixelState::Pending;
		}
		let generation = slot.replace(job.width_px, job.height_px, job.background_rgb);
		drop(slot);
		start_encode(SixelJob { generation, ..job });
		SixelState::Pending
	}

	/// Run `job` on the blocking pool; its settlement (on the JS thread)
	/// stores the sequence and tells `onEncoded` unless a newer request
	/// replaced it.
	fn spawn_sixel_encode(
		&self,
		env: &Env,
		job: SixelJob,
		on_encoded: Option<FunctionRef<u32, ()>>,
	) -> Result<()> {
		let encoded = Arc::new(Mutex::new(None::<String>));
		let output = Arc::clone(&encoded);
		let data = Arc::clone(&self.data);
		let promise = task::spawn_blocking(env, "sixel.encode", move |_| {
			let sequence = encode_sixel(&data, job);
			if let Ok(mut output) = output.lock() {
				*output = sequence;
			}
			Ok(true)
		})?;
		let settle = Rc::new(Settle { slot: Rc::clone(&self.sixel), on_encoded, job });
		let on_rejected = Rc::clone(&settle);
		promise
			.promise_object()
			.then(move |context: CallbackContext<bool>| {
				let sequence = encoded.lock().ok().and_then(|mut sequence| sequence.take());
				settle.settle(&context.env, sequence)
			})?
			// A panicking encode (or a throwing `onEncoded`) settles as failed
			// instead of surfacing as an unhandled rejection.
			.catch(move |context: CallbackContext<Unknown<'static>>| {
				let _ = on_rejected.settle(&context.env, None);
				Ok(())
			})?;
		Ok(())
	}
}

/// The settlement of one off-thread SIXEL encode.
struct Settle {
	slot:       Rc<RefCell<SixelSlot>>,
	on_encoded: Option<FunctionRef<u32, ()>>,
	job:        SixelJob,
}

impl Settle {
	fn settle(&self, env: &Env, sequence: Option<String>) -> Result<()> {
		{
			let mut slot = self.slot.borrow_mut();
			let Some(current) = slot.current.as_mut().filter(|current| {
				current.generation == self.job.generation
					&& matches!(current.state, SixelState::Pending)
			}) else {
				return Ok(());
			};
			current.state = sequence.map_or(SixelState::Failed, SixelState::Ready);
		}
		if let Some(on_encoded) = &self.on_encoded {
			on_encoded.borrow_back(env)?.call(self.job.background_rgb)?;
		}
		Ok(())
	}
}

/// A direct placement's rows: `rows - 1` reserved rows, then the payload row,
/// which saves the cursor on the block's last row, moves up to the image
/// origin, emits the placement, and restores the cursor — so the renderer's
/// row accounting matches the image's height.
fn direct_placement_rows(sequence: &str, rows: u32) -> Vec<String> {
	let lift = rows.saturating_sub(1);
	let mut out = Vec::with_capacity(rows.max(1) as usize);
	out.extend((0..lift).map(|_| RESERVED_IMAGE_ROW.to_owned()));
	out.push(if lift > 0 {
		format!("\x1b7\x1b[{lift}A{sequence}\x1b8")
	} else {
		sequence.to_owned()
	});
	out
}

#[cfg(test)]
mod tests;
