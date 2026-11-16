use std::{cell::RefCell, rc::Rc};

use super::*;
use crate::tui::budget::Budget;

const ONE_PIXEL_PNG: &str =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const SQUARE: Dimensions = Dimensions { width_px: 100.0, height_px: 100.0 };

fn image(data: &str, size: Dimensions) -> InlineImage {
	InlineImage::with_size(data.into(), size)
}

fn budgeted(data: &str, budget: &SharedBudget, key: &str) -> InlineImage {
	let mut image = image(data, SQUARE);
	image.image_id = Some(budget.borrow_mut().acquire_id(Some(key)));
	image.budget = Some(Rc::clone(budget));
	image
}

fn request(protocol: Option<ImageProtocol>, max_columns: f64, max_rows: Option<f64>) -> Request {
	Request {
		protocol,
		max_columns,
		max_rows,
		cell: CellSize { width_px: 10.0, height_px: 10.0 },
		kitty_placeholders: false,
		tmux: false,
		background_rgb: 0,
		scrollback: false,
		measuring: false,
		cached: true,
	}
}

/// Render without accepting an off-thread SIXEL encode.
fn render(image: &mut InlineImage, request: &Request) -> Frame {
	image.render_frame(request, &mut |job| panic!("unexpected SIXEL encode {job:?}"))
}

fn rows(frame: Frame) -> Vec<String> {
	match frame {
		Frame::Rows(rows) => rows,
		other => panic!("expected rows, got {other:?}"),
	}
}

fn param(sequence: &str, key: &str) -> Option<u32> {
	let at = sequence.find(&format!(",{key}="))? + key.len() + 2;
	let digits: String = sequence[at..]
		.chars()
		.take_while(char::is_ascii_digit)
		.collect();
	digits.parse().ok()
}

#[test]
fn fits_kitty_images_within_both_bounds() {
	let mut image = image("AA==", SQUARE);
	let rows = rows(render(&mut image, &request(Some(ImageProtocol::Kitty), 10.0, Some(2.0))));
	assert_eq!(rows.len(), 2);
	assert_eq!(param(&rows[1], "c"), Some(2));
	assert_eq!(param(&rows[1], "r"), Some(2));
}

#[test]
fn moves_up_before_multi_row_direct_output_and_restores_the_cursor() {
	let mut image = image("AA==", SQUARE);
	let rows = rows(render(&mut image, &request(Some(ImageProtocol::Kitty), 10.0, Some(3.0))));
	assert_eq!(rows, [
		"\x1b[0m".to_owned(),
		"\x1b[0m".to_owned(),
		"\x1b7\x1b[2A\x1b_Ga=T,f=100,q=2,C=1,c=3,r=3;AA==\x1b\\\x1b8".to_owned(),
	]);
	// A single row needs no cursor movement.
	let mut image = super::InlineImage::with_size("AA==".into(), SQUARE);
	let rows = rows_of(&mut image, 1.0);
	assert_eq!(rows, ["\x1b_Ga=T,f=100,q=2,C=1,c=1,r=1;AA==\x1b\\".to_owned()]);
}

fn rows_of(image: &mut InlineImage, max_rows: f64) -> Vec<String> {
	rows(render(image, &request(Some(ImageProtocol::Kitty), 10.0, Some(max_rows))))
}

#[test]
fn answers_unchanged_until_an_input_changes() {
	let mut image = image(ONE_PIXEL_PNG, SQUARE);
	let mut req = request(None, 10.0, Some(2.0));
	assert_eq!(render(&mut image, &req), Frame::Fallback(1));
	assert_eq!(render(&mut image, &req), Frame::Unchanged);
	// The protocol becoming available re-renders the cached fallback.
	req.protocol = Some(ImageProtocol::Kitty);
	assert!(
		rows(render(&mut image, &req))
			.concat()
			.contains("\x1b_Ga=T")
	);
	assert_eq!(render(&mut image, &req), Frame::Unchanged);
	// So does a cell-size report.
	req.max_rows = Some(10.0);
	assert_eq!(param(&rows(render(&mut image, &req)).concat(), "c"), Some(10));
	req.cell.width_px = 20.0;
	assert_eq!(param(&rows(render(&mut image, &req)).concat(), "c"), Some(5));
	// A caller that dropped its rows gets them again.
	req.cached = false;
	assert!(matches!(render(&mut image, &req), Frame::Rows(_)));
}

#[test]
fn transmits_once_through_the_budget_and_places_by_id() {
	let budget: SharedBudget = Rc::new(RefCell::new(Budget::new(3)));
	let mut image = budgeted(ONE_PIXEL_PNG, &budget, "k");
	let id = image.image_id.unwrap();
	let req = request(Some(ImageProtocol::Kitty), 4.0, Some(4.0));
	budget.borrow_mut().begin_pass(false, false);
	let first = rows(render(&mut image, &req));
	budget.borrow_mut().end_pass();
	assert_eq!(budget.borrow_mut().take_transmits(), [format!(
		"\x1b_Ga=t,f=100,q=2,i={id};{ONE_PIXEL_PNG}\x1b\\"
	)]);
	let last = first.last().unwrap();
	assert!(last.contains(&format!("\x1b_Ga=p,q=2,C=1,i={id},p={id},c=4,r=4")));
	assert!(!last.contains(ONE_PIXEL_PNG));
	assert_eq!(budget.borrow().placement_height(id), 100.0);

	// A repeat pass is unchanged and queues nothing.
	budget.borrow_mut().begin_pass(false, false);
	assert_eq!(render(&mut image, &req), Frame::Unchanged);
	budget.borrow_mut().end_pass();
	assert!(budget.borrow_mut().take_transmits().is_empty());

	// Released render caches replay the same rows without retransmitting.
	budget.borrow_mut().begin_pass(false, false);
	assert_eq!(rows(render(&mut image, &Request { cached: false, ..req })), first);
	budget.borrow_mut().end_pass();
	assert!(budget.borrow_mut().take_transmits().is_empty());
}

#[test]
fn rebuilds_rows_when_the_terminal_lost_the_data() {
	let budget: SharedBudget = Rc::new(RefCell::new(Budget::new(3)));
	let mut image = budgeted(ONE_PIXEL_PNG, &budget, "k");
	let req = request(Some(ImageProtocol::Kitty), 4.0, Some(4.0));
	budget.borrow_mut().begin_pass(false, false);
	render(&mut image, &req);
	budget.borrow_mut().end_pass();
	budget.borrow_mut().drain_frame(false);
	budget.borrow_mut().forget_transmitted();
	budget.borrow_mut().begin_pass(false, false);
	assert!(matches!(render(&mut image, &req), Frame::Rows(_)));
	assert_eq!(budget.borrow_mut().take_transmits().len(), 1);
}

#[test]
fn switches_between_direct_placement_and_unicode_placeholders() {
	let budget: SharedBudget = Rc::new(RefCell::new(Budget::new(1)));
	let mut image = budgeted(ONE_PIXEL_PNG, &budget, "placeholder-cache");
	let id = image.image_id.unwrap();
	let mut req = request(Some(ImageProtocol::Kitty), 10.0, Some(2.0));
	let direct = rows(render(&mut image, &req)).concat();
	assert!(direct.contains("\x1b_Ga=p,q=2"));
	req.kitty_placeholders = true;
	let placeholder = rows(render(&mut image, &req));
	assert_eq!(placeholder.len(), 2);
	assert!(placeholder[0].starts_with(&format!("\x1b_Ga=p,U=1,q=2,i={id},p={id},c=2,r=2\x1b\\")));
	// Inside tmux every Kitty command rides the passthrough envelope.
	req.tmux = true;
	let wrapped = rows(render(&mut image, &req));
	assert!(wrapped[0].starts_with(&format!(
		"\x1bPtmux;\x1b\x1b_Ga=p,U=1,q=2,i={id},p={id},c=2,r=2\x1b\x1b\\\x1b\\"
	)));
}

#[test]
fn keeps_a_demoted_images_height_only_within_a_lowered_row_ceiling() {
	let budget: SharedBudget = Rc::new(RefCell::new(Budget::new(1)));
	let mut image = budgeted(ONE_PIXEL_PNG, &budget, "shrunk");
	let mut newer = budgeted(ONE_PIXEL_PNG, &budget, "newer");
	let pass = |budget: &SharedBudget| budget.borrow_mut().begin_pass(false, false);
	let tall = request(Some(ImageProtocol::Kitty), 18.0, Some(10.0));
	let short = Request { max_rows: Some(2.0), ..tall };
	let newer_req = Request { max_rows: Some(1.0), ..tall };

	pass(&budget);
	assert_eq!(rows(render(&mut image, &tall)).len(), 10);
	budget.borrow_mut().end_pass();

	pass(&budget);
	assert_eq!(rows(render(&mut image, &short)).len(), 2);
	render(&mut newer, &newer_req);
	assert!(budget.borrow_mut().end_pass());

	pass(&budget);
	assert_eq!(render(&mut image, &short), Frame::Fallback(2));
	assert!(image.suppressed);
	render(&mut newer, &newer_req);
	budget.borrow_mut().end_pass();
}

#[test]
fn sizes_iterm2_images_by_the_limiting_bound() {
	let mut image = image("AA==", SQUARE);
	let rows = rows(render(&mut image, &request(Some(ImageProtocol::Iterm2), 10.0, Some(2.0))));
	assert_eq!(rows.len(), 2);
	assert!(rows[1].contains("\x1b]1337;File=inline=1;width=2;height=2:AA==\x07"));
}

#[test]
fn reserves_sixel_rows_while_the_encode_runs_and_shows_it_once_settled() {
	let mut image = image(ONE_PIXEL_PNG, Dimensions { width_px: 900.0, height_px: 220.0 });
	let req = Request {
		cell: CellSize { width_px: 10.0, height_px: 20.0 },
		..request(Some(ImageProtocol::Sixel), 90.0, Some(11.0))
	};
	let mut jobs = Vec::new();
	let frame = image.render_frame(&req, &mut |job| jobs.push(job));
	assert_eq!(jobs.len(), 1);
	assert_eq!((jobs[0].width_px, jobs[0].height_px), (900, 220));
	let reserved = rows(frame);
	assert_eq!(reserved.len(), 11);
	assert_eq!(reserved[10], "\x1b7\x1b[10A\x1b8");
	// Still pending: unchanged, and no second encode.
	assert_eq!(image.render_frame(&req, &mut |job| jobs.push(job)), Frame::Unchanged);
	assert_eq!(jobs.len(), 1);

	// A stale settlement is dropped; the current one shows.
	settle(&image, jobs[0].generation + 1, "stale");
	assert_eq!(render(&mut image, &req), Frame::Unchanged);
	settle(&image, jobs[0].generation, "\x1bPqSIXEL\x1b\\");
	assert_eq!(rows(render(&mut image, &req))[10], "\x1b7\x1b[10A\x1bPqSIXEL\x1b\\\x1b8");
}

/// Settle encode `generation` with `sequence`, as the off-thread settlement
/// does: only while it is still the image's current request.
fn settle(image: &InlineImage, generation: u64, sequence: &str) {
	let mut slot = image.sixel.borrow_mut();
	let current = slot.current.as_mut().unwrap();
	if current.generation == generation {
		current.state = SixelState::Ready(sequence.to_owned());
	}
}

#[test]
fn falls_back_to_text_when_the_sixel_encode_fails() {
	let mut image = image("AA==", SQUARE);
	let req = request(Some(ImageProtocol::Sixel), 10.0, Some(2.0));
	image.render_frame(&req, &mut |_| {});
	image.sixel.borrow_mut().current.as_mut().unwrap().state = SixelState::Failed;
	assert_eq!(render(&mut image, &req), Frame::Fallback(2));
}

#[test]
fn encodes_sixel_synchronously_for_scrollback() {
	let mut image = image(ONE_PIXEL_PNG, SQUARE);
	let req = Request { scrollback: true, ..request(Some(ImageProtocol::Sixel), 10.0, Some(2.0)) };
	let rows = rows(render(&mut image, &req));
	assert_eq!(rows.len(), 2);
	assert!(rows[1].starts_with("\x1b7\x1b[1A\x1bP"));
	// Rows reserved for a pending encode are rebuilt for scrollback.
	let mut pending = super::InlineImage::with_size(ONE_PIXEL_PNG.into(), SQUARE);
	let live = Request { scrollback: false, ..req };
	pending.render_frame(&live, &mut |_| {});
	assert!(rows_contain_sixel(render(&mut pending, &req)));
}

fn rows_contain_sixel(frame: Frame) -> bool {
	rows(frame).concat().contains("\x1bP")
}

#[test]
fn encodes_against_the_newest_background() {
	let mut image = image(ONE_PIXEL_PNG, SQUARE);
	let mut req = request(Some(ImageProtocol::Sixel), 10.0, Some(2.0));
	let mut jobs = Vec::new();
	image.render_frame(&req, &mut |job| jobs.push(job));
	req.background_rgb = 0x20_20_40;
	image.render_frame(&req, &mut |job| jobs.push(job));
	req.background_rgb = 0xff_ff_ff;
	image.render_frame(&req, &mut |job| jobs.push(job));
	assert_eq!(
		jobs
			.iter()
			.map(|job| job.background_rgb)
			.collect::<Vec<_>>(),
		[0, 0x20_20_40, 0xff_ff_ff]
	);
	let current = image.sixel.borrow().current.as_ref().unwrap().generation;
	assert_eq!(current, jobs[2].generation);
}

#[test]
fn renders_text_without_a_protocol_and_never_observes() {
	let budget: SharedBudget = Rc::new(RefCell::new(Budget::new(1)));
	let mut image = budgeted(ONE_PIXEL_PNG, &budget, "k");
	budget.borrow_mut().begin_pass(false, false);
	assert_eq!(render(&mut image, &request(None, 10.0, None)), Frame::Fallback(1));
	assert!(!budget.borrow_mut().end_pass());
	assert!(!image.suppressed);
}
