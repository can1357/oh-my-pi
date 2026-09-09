//! wgpu device management and the two-pipeline painter.
//!
//! One render pass per frame: instanced SDF rects and atlas glyphs replayed
//! batch-by-batch with optional scissor clips. The same painter drives the
//! window surface and offscreen targets (screenshots), so scripted scenes
//! render pixel-identical frames without a window server.

use std::{ops::Range, sync::Arc};

use thiserror::Error;
use winit::window::Window;

/// Atlas dimensions in texels; both atlases share the size. ~4 MiB of R8
/// coverage plus ~16 MiB of RGBA emoji — thousands of glyphs.
pub const ATLAS_SIZE: u32 = 2048;

/// Errors bringing up the GPU stack.
#[derive(Debug, Error)]
pub enum GpuError {
	/// No adapter could drive the requested surface (or headless target).
	#[error("no compatible GPU adapter: {0}")]
	Adapter(#[from] wgpu::RequestAdapterError),
	/// The adapter refused a logical device.
	#[error("device request failed: {0}")]
	Device(#[from] wgpu::RequestDeviceError),
	/// The window handle could not be turned into a surface.
	#[error("surface creation failed: {0}")]
	Surface(#[from] wgpu::CreateSurfaceError),
}

/// Owned wgpu handles shared by every render target.
pub struct Gpu {
	/// The wgpu entry point (surface creation).
	pub instance: wgpu::Instance,
	/// Selected physical adapter.
	pub adapter:  wgpu::Adapter,
	/// Logical device; creates all GPU resources.
	pub device:   wgpu::Device,
	/// Submission queue; uploads and command submission.
	pub queue:    wgpu::Queue,
}

impl Gpu {
	/// Brings up an adapter/device, optionally compatible with a surface.
	#[tracing::instrument(
		name = "gpu_device_initialize",
		level = "debug",
		skip_all,
		fields(compatible_surface = compatible.is_some())
	)]
	pub fn new(compatible: Option<&wgpu::Surface<'_>>) -> Result<Self, GpuError> {
		let instance = wgpu::Instance::default();
		let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
			power_preference:       wgpu::PowerPreference::HighPerformance,
			force_fallback_adapter: false,
			compatible_surface:     compatible,
			apply_limit_buckets:    false,
		}))
		.inspect_err(|error| {
			tracing::warn!(%error, "gpu adapter initialization failed");
		})?;
		let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
			label: Some("omp-gui"),
			// Instance structs are wider than the downlevel default stride.
			required_limits: wgpu::Limits {
				max_vertex_buffer_array_stride: 2048,
				..Default::default()
			},
			..Default::default()
		}))
		.inspect_err(|error| {
			tracing::warn!(%error, "gpu device initialization failed");
		})?;
		Ok(Self { instance, adapter, device, queue })
	}
}

/// SDF rect instance; layout mirrors `RectIn` in shader.wgsl.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct RectInst {
	/// Top-left corner, physical px.
	pub pos:          [f32; 2],
	/// Width and height, physical px.
	pub size:         [f32; 2],
	/// Straight-alpha fill color.
	pub color:        [f32; 4],
	/// Corner radius, edge softness, border width, dash period.
	pub params:       [f32; 4],
	/// Straight-alpha border color.
	pub border_color: [f32; 4],
	/// Straight-alpha gradient end color.
	pub color2:       [f32; 4],
	/// Gradient direction, projected minimum, and inverse span.
	pub grad:         [f32; 4],
}

impl RectInst {
	/// A plain sharp-edged fill.
	pub const fn fill(pos: [f32; 2], size: [f32; 2], color: [f32; 4]) -> Self {
		Self {
			pos,
			size,
			color,
			params: [0.0; 4],
			border_color: [0.0; 4],
			color2: [0.0; 4],
			grad: [0.0; 4],
		}
	}
}

/// Glyph instance; layout mirrors `GlyphIn` in shader.wgsl.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GlyphInst {
	/// Top-left of the glyph quad, physical px.
	pub pos:   [f32; 2],
	/// Quad size, physical px.
	pub size:  [f32; 2],
	/// Top-left texel in the glyph's atlas.
	pub uv:    [f32; 2],
	/// Straight-alpha tint; color bitmaps use only the alpha.
	pub color: [f32; 4],
	/// Synthetic oblique shear (italics).
	pub slant: f32,
	/// 0.0 = coverage-mask atlas, 1.0 = RGBA bitmap atlas.
	pub kind:  f32,
}

/// One scissored slice of the frame's instances.
pub struct Batch {
	/// Clip rectangle `(x, y, w, h)` in physical px; `None` is unclipped.
	pub clip:   Option<[u32; 4]>,
	/// Range into the frame's rect instance list.
	pub rects:  Range<u32>,
	/// Range into the frame's glyph instance list.
	pub glyphs: Range<u32>,
}

/// One dirty atlas rectangle pending a GPU upload.
pub struct AtlasRegion {
	/// Top-left texel.
	pub x:      u32,
	/// Top-left texel row.
	pub y:      u32,
	/// Region width in texels.
	pub width:  u32,
	/// Region height in texels.
	pub height: u32,
	/// Texel bytes: one per texel for the coverage atlas, four (RGBA) for color.
	pub data:   Vec<u8>,
}

/// Growable instance buffer.
struct InstanceBuf {
	buf:   wgpu::Buffer,
	cap:   u64,
	label: &'static str,
}

impl InstanceBuf {
	fn new(device: &wgpu::Device, label: &'static str, cap: u64) -> Self {
		Self { buf: Self::create(device, label, cap), cap, label }
	}

	fn create(device: &wgpu::Device, label: &'static str, cap: u64) -> wgpu::Buffer {
		device.create_buffer(&wgpu::BufferDescriptor {
			label:              Some(label),
			size:               cap,
			usage:              wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
			mapped_at_creation: false,
		})
	}

	fn write(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, bytes: &[u8]) {
		let needed = bytes.len() as u64;
		if needed > self.cap {
			self.cap = needed.next_power_of_two();
			self.buf = Self::create(device, self.label, self.cap);
		}
		if !bytes.is_empty() {
			queue.write_buffer(&self.buf, 0, bytes);
		}
	}
}

/// The frame painter: pipelines, uniforms, atlas textures, instance buffers.
pub struct Painter {
	rect_pipeline:  wgpu::RenderPipeline,
	glyph_pipeline: wgpu::RenderPipeline,
	globals:        wgpu::Buffer,
	globals_bg:     wgpu::BindGroup,
	mask_tex:       wgpu::Texture,
	color_tex:      wgpu::Texture,
	atlas_bg:       wgpu::BindGroup,
	rects:          InstanceBuf,
	glyphs:         InstanceBuf,
}

impl Painter {
	/// Builds both pipelines, the shared uniforms, and the glyph atlases for
	/// targets of `format`.
	pub fn new(gpu: &Gpu, format: wgpu::TextureFormat) -> Self {
		let device = &gpu.device;
		let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
			label:  Some("omp-gui-shader"),
			source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
		});

		let globals = device.create_buffer(&wgpu::BufferDescriptor {
			label:              Some("globals"),
			size:               16,
			usage:              wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
			mapped_at_creation: false,
		});
		let globals_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
			label:   Some("globals-layout"),
			entries: &[wgpu::BindGroupLayoutEntry {
				binding:    0,
				visibility: wgpu::ShaderStages::VERTEX,
				ty:         wgpu::BindingType::Buffer {
					ty:                 wgpu::BufferBindingType::Uniform,
					has_dynamic_offset: false,
					min_binding_size:   None,
				},
				count:      None,
			}],
		});
		let globals_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
			label:   Some("globals-bg"),
			layout:  &globals_layout,
			entries: &[wgpu::BindGroupEntry { binding: 0, resource: globals.as_entire_binding() }],
		});

		let atlas_tex = |label: &str, format: wgpu::TextureFormat| {
			device.create_texture(&wgpu::TextureDescriptor {
				label: Some(label),
				size: wgpu::Extent3d {
					width:                 ATLAS_SIZE,
					height:                ATLAS_SIZE,
					depth_or_array_layers: 1,
				},
				mip_level_count: 1,
				sample_count: 1,
				dimension: wgpu::TextureDimension::D2,
				format,
				usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
				view_formats: &[],
			})
		};
		let mask_tex = atlas_tex("mask-atlas", wgpu::TextureFormat::R8Unorm);
		let color_tex = atlas_tex("color-atlas", wgpu::TextureFormat::Rgba8Unorm);
		let mask_view = mask_tex.create_view(&wgpu::TextureViewDescriptor::default());
		let color_view = color_tex.create_view(&wgpu::TextureViewDescriptor::default());
		let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
			label: Some("atlas-sampler"),
			mag_filter: wgpu::FilterMode::Linear,
			min_filter: wgpu::FilterMode::Linear,
			..Default::default()
		});
		let tex_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
			binding,
			visibility: wgpu::ShaderStages::FRAGMENT,
			ty: wgpu::BindingType::Texture {
				sample_type:    wgpu::TextureSampleType::Float { filterable: true },
				view_dimension: wgpu::TextureViewDimension::D2,
				multisampled:   false,
			},
			count: None,
		};
		let atlas_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
			label:   Some("atlas-layout"),
			entries: &[
				tex_entry(0),
				wgpu::BindGroupLayoutEntry {
					binding:    1,
					visibility: wgpu::ShaderStages::FRAGMENT,
					ty:         wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
					count:      None,
				},
				tex_entry(2),
			],
		});
		let atlas_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
			label:   Some("atlas-bg"),
			layout:  &atlas_layout,
			entries: &[
				wgpu::BindGroupEntry {
					binding:  0,
					resource: wgpu::BindingResource::TextureView(&mask_view),
				},
				wgpu::BindGroupEntry {
					binding:  1,
					resource: wgpu::BindingResource::Sampler(&sampler),
				},
				wgpu::BindGroupEntry {
					binding:  2,
					resource: wgpu::BindingResource::TextureView(&color_view),
				},
			],
		});

		let blend = wgpu::BlendState {
			color: wgpu::BlendComponent {
				src_factor: wgpu::BlendFactor::One,
				dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
				operation:  wgpu::BlendOperation::Add,
			},
			alpha: wgpu::BlendComponent {
				src_factor: wgpu::BlendFactor::One,
				dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
				operation:  wgpu::BlendOperation::Add,
			},
		};
		let rect_attrs = [
			// pos, size, color, params, border_color, color2, gradient projection
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x2,
				offset:          0,
				shader_location: 0,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x2,
				offset:          8,
				shader_location: 1,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x4,
				offset:          16,
				shader_location: 2,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x4,
				offset:          32,
				shader_location: 3,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x4,
				offset:          48,
				shader_location: 4,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x4,
				offset:          64,
				shader_location: 5,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x4,
				offset:          80,
				shader_location: 6,
			},
		];
		let glyph_attrs = [
			// pos+size pairs, uv, color, slant, kind
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x2,
				offset:          0,
				shader_location: 0,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x2,
				offset:          8,
				shader_location: 1,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x2,
				offset:          16,
				shader_location: 2,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32x4,
				offset:          24,
				shader_location: 3,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32,
				offset:          40,
				shader_location: 4,
			},
			wgpu::VertexAttribute {
				format:          wgpu::VertexFormat::Float32,
				offset:          44,
				shader_location: 5,
			},
		];
		let pipeline = |label: &str,
		                layouts: &[&wgpu::BindGroupLayout],
		                vs: &str,
		                fs: &str,
		                stride: u64,
		                attrs: &[wgpu::VertexAttribute]| {
			let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
				label:              Some(label),
				bind_group_layouts: &layouts
					.iter()
					.map(|layout| Some(*layout))
					.collect::<Vec<_>>(),
				immediate_size:     0,
			});
			device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
				label:          Some(label),
				layout:         Some(&layout),
				vertex:         wgpu::VertexState {
					module:              &shader,
					entry_point:         Some(vs),
					compilation_options: Default::default(),
					buffers:             &[Some(wgpu::VertexBufferLayout {
						array_stride: stride,
						step_mode:    wgpu::VertexStepMode::Instance,
						attributes:   attrs,
					})],
				},
				fragment:       Some(wgpu::FragmentState {
					module:              &shader,
					entry_point:         Some(fs),
					compilation_options: Default::default(),
					targets:             &[Some(wgpu::ColorTargetState {
						format,
						blend: Some(blend),
						write_mask: wgpu::ColorWrites::ALL,
					})],
				}),
				primitive:      wgpu::PrimitiveState {
					topology: wgpu::PrimitiveTopology::TriangleStrip,
					strip_index_format: None,
					..Default::default()
				},
				depth_stencil:  None,
				multisample:    Default::default(),
				multiview_mask: None,
				cache:          None,
			})
		};
		let rect_pipeline = pipeline(
			"rect-pipeline",
			&[&globals_layout],
			"vs_rect",
			"fs_rect",
			size_of::<RectInst>() as u64,
			&rect_attrs,
		);
		let glyph_pipeline = pipeline(
			"glyph-pipeline",
			&[&globals_layout, &atlas_layout],
			"vs_glyph",
			"fs_glyph",
			size_of::<GlyphInst>() as u64,
			&glyph_attrs,
		);

		Self {
			rect_pipeline,
			glyph_pipeline,
			globals,
			globals_bg,
			mask_tex,
			color_tex,
			atlas_bg,
			rects: InstanceBuf::new(device, "rect-instances", 1 << 16),
			glyphs: InstanceBuf::new(device, "glyph-instances", 1 << 16),
		}
	}

	/// Writes dirty atlas regions; `data` rows are tightly packed.
	pub fn upload_atlas(&self, gpu: &Gpu, mask: &[AtlasRegion], color: &[AtlasRegion]) {
		for region in mask {
			Self::write_region(gpu, &self.mask_tex, region, 1);
		}
		for region in color {
			Self::write_region(gpu, &self.color_tex, region, 4);
		}
	}

	fn write_region(gpu: &Gpu, tex: &wgpu::Texture, region: &AtlasRegion, bpp: u32) {
		// Tight rows are fine: `Queue::write_texture` stages internally and
		// repacks unaligned rows itself; pre-padding would add a copy.
		gpu.queue.write_texture(
			wgpu::TexelCopyTextureInfo {
				texture:   tex,
				mip_level: 0,
				origin:    wgpu::Origin3d { x: region.x, y: region.y, z: 0 },
				aspect:    wgpu::TextureAspect::All,
			},
			&region.data,
			wgpu::TexelCopyBufferLayout {
				offset:         0,
				bytes_per_row:  Some(region.width * bpp),
				rows_per_image: Some(region.height),
			},
			wgpu::Extent3d {
				width:                 region.width,
				height:                region.height,
				depth_or_array_layers: 1,
			},
		);
	}

	/// Paints one frame: clear to transparent, then replay the batches.
	pub fn draw(
		&mut self,
		gpu: &Gpu,
		target: &wgpu::TextureView,
		width: u32,
		height: u32,
		batches: &[Batch],
		rects: &[RectInst],
		glyphs: &[GlyphInst],
	) {
		let globals: [f32; 4] = [width as f32, height as f32, ATLAS_SIZE as f32, ATLAS_SIZE as f32];
		gpu.queue
			.write_buffer(&self.globals, 0, bytemuck::cast_slice(&globals));
		self
			.rects
			.write(&gpu.device, &gpu.queue, bytemuck::cast_slice(rects));
		self
			.glyphs
			.write(&gpu.device, &gpu.queue, bytemuck::cast_slice(glyphs));

		let mut encoder = gpu
			.device
			.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
		{
			let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
				label:                    Some("frame-pass"),
				color_attachments:        &[Some(wgpu::RenderPassColorAttachment {
					view:           target,
					depth_slice:    None,
					resolve_target: None,
					ops:            wgpu::Operations {
						load:  wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
						store: wgpu::StoreOp::Store,
					},
				})],
				depth_stencil_attachment: None,
				timestamp_writes:         None,
				occlusion_query_set:      None,
				multiview_mask:           None,
			});
			for batch in batches {
				match batch.clip {
					Some([x, y, w, h]) => pass.set_scissor_rect(x, y, w, h),
					None => pass.set_scissor_rect(0, 0, width, height),
				}
				if !batch.rects.is_empty() {
					pass.set_pipeline(&self.rect_pipeline);
					pass.set_bind_group(0, &self.globals_bg, &[]);
					pass.set_vertex_buffer(0, self.rects.buf.slice(..));
					pass.draw(0..4, batch.rects.clone());
				}
				if !batch.glyphs.is_empty() {
					pass.set_pipeline(&self.glyph_pipeline);
					pass.set_bind_group(0, &self.globals_bg, &[]);
					pass.set_bind_group(1, &self.atlas_bg, &[]);
					pass.set_vertex_buffer(0, self.glyphs.buf.slice(..));
					pass.draw(0..4, batch.glyphs.clone());
				}
			}
		}
		gpu.queue.submit([encoder.finish()]);
	}
}

/// Window surface wrapper.
pub struct WindowGpu {
	surface: wgpu::Surface<'static>,
	config:  wgpu::SurfaceConfiguration,
}

impl WindowGpu {
	/// Creates and configures the surface for `window`, preferring a
	/// non-sRGB format (gamma-space text blending) and premultiplied alpha
	/// (translucent window compositing).
	#[tracing::instrument(name = "window_surface_initialize", level = "debug", skip_all)]
	pub fn new(gpu: &Gpu, window: Arc<Window>) -> Result<Self, GpuError> {
		let surface = gpu
			.instance
			.create_surface(Arc::clone(&window))
			.inspect_err(|error| {
				tracing::warn!(%error, "window surface initialization failed");
			})?;
		let caps = surface.get_capabilities(&gpu.adapter);
		let format = caps
			.formats
			.iter()
			.find(|format| !format.is_srgb())
			.copied()
			.unwrap_or(caps.formats[0]);
		// Metal reports `PostMultiplied` but composites the non-opaque layer
		// premultiplied, so both picks pair with this painter's output.
		let alpha_mode =
			[wgpu::CompositeAlphaMode::PreMultiplied, wgpu::CompositeAlphaMode::PostMultiplied]
				.into_iter()
				.find(|mode| caps.alpha_modes.contains(mode))
				.unwrap_or(caps.alpha_modes[0]);
		let size = window.inner_size();
		let config = wgpu::SurfaceConfiguration {
			usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
			format,
			width: size.width.max(1),
			height: size.height.max(1),
			present_mode: wgpu::PresentMode::Fifo,
			desired_maximum_frame_latency: 2,
			alpha_mode,
			view_formats: vec![],
			color_space: Default::default(),
		};
		surface.configure(&gpu.device, &config);
		Ok(Self { surface, config })
	}

	/// The surface's pixel format, for the painter's pipelines.
	pub const fn format(&self) -> wgpu::TextureFormat {
		self.config.format
	}

	/// Reconfigures after a window resize; zero sizes are ignored.
	pub fn resize(&mut self, gpu: &Gpu, width: u32, height: u32) {
		if width == 0 || height == 0 {
			return;
		}
		self.config.width = width;
		self.config.height = height;
		self.surface.configure(&gpu.device, &self.config);
	}

	/// Acquires the next frame; `Lost`/`Outdated` reconfigure and retry
	/// once, `Timeout`/`Occluded` skip the frame.
	pub fn acquire(&mut self, gpu: &Gpu) -> Option<wgpu::SurfaceTexture> {
		use wgpu::CurrentSurfaceTexture as Status;
		match self.surface.get_current_texture() {
			Status::Success(texture) | Status::Suboptimal(texture) => Some(texture),
			Status::Outdated | Status::Lost => {
				self.surface.configure(&gpu.device, &self.config);
				match self.surface.get_current_texture() {
					Status::Success(texture) | Status::Suboptimal(texture) => Some(texture),
					_ => None,
				}
			},
			Status::Timeout | Status::Occluded | Status::Validation => None,
		}
	}
}
