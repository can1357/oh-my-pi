`read` selectors (and `write` targets) for sources other than text files, directories and URLs.

- SQLite: file.db tables; :table schema/rows; :table:key by primary key; ?limit=, ?where=, ?q=SELECT.
- Archives: ZIP/JAR/APK/WHL, compressed TAR, RAR/7z/ISO/CAB/DEB/RPM/CPIO/AR/LZH/ARJ/ASAR, compressed streams; member via archive.ext:member/path.
- JSON/JSONL/NDJSON: file.json?q=<jq filter>
  - &raw=true unquoted strings, &compact=true one-line values, &offset=&limit= page array elements or result values.
  - `&` inside the filter → %26.
  - Output is text, not one JSON document; follow its continuation hint for the next page.
- Executables (ELF/PE/Mach-O, extensionless ok): on-disk metadata only; no analysis database or backend download.
  - Universal Mach-O: host-arch slice by default; bin:@<arch> picks another metadata view.
{{#if BINARY_VIEWS}}
  - Explicit analysis: :overview function list; :<func|0xaddr> pseudocode; :<func>:asm; :imports; :exports; :strings; :xrefs:<func|0xaddr>.
  - These selectors open the selected disassembler and may provision Ghidra on first analysis.
  - Line ranges apply after the view (bin:main:10-40); bin:@x86_64:main analyzes a chosen universal slice.
  - For edits and Python scripting, use eval's `dsm` namespace → help://eval/dsm.
{{/if}}
- Video requires ffmpeg/ffprobe: bare preview grid+metadata, :412 frame, :1h5m42s/:90s/:01:23 time.
- SVG/SVGZ default text; :img rasterizes an SVG/SVGZ into an image, :raw original.
  - Raster images (PNG, JPEG) need no selector; :img reads them the same way.
- Merge conflicts: :conflicts lists one line per unresolved merge block.
- `write` targets:
  - archive.ext:member: ZIP/tar families and .asar writable, others read-only.
  - db.sqlite:table: insert.
  - db.sqlite:table:key: JSON update, empty content deletes.
