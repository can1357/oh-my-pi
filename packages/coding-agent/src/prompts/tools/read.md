Use `read` for static web; browser only if needed.

Put line ranges in `path`, never a separate range/offset/limit parameter: `{"path":"notes.txt:450-455"}` reads lines 450-455; `{"path":"notes.txt:-5"}` reads the last 5. Include the selector on every ranged call; repeating a bare path does not advance through the file.

Path suffixes: :50 or :50- starts at line 50; :50-200 inclusive; :50+150 counts lines; :-60 last 60; commas join ranges (:5-16,960-973) or individual lines (:19,59). A single non-raw range also shows 1 line before and 3 after (e.g. :50-80 shows 49-83); non-raw reads (comma lists too) may add the open/close line of a cut block; only :raw stays exact. :raw verbatim without anchors/prefixes; combine :2-4:raw or :raw:2-4 for exactly those lines. :conflicts lists one line per unresolved merge block. SVG/SVGZ default text; :img PNG, :raw original. Video requires ffmpeg/ffprobe: bare preview grid+metadata, :412 frame, :1h5m42s/:90s/:01:23 time.

Sources:
- Bare code: declarations only; re-read ONLY footer-named omissions, NEVER guess `..`/`…`.
{{#if IS_HL_MODE}}- Selected file: `[foo.ts#1A2B]` snapshot+lines. Copy `[FILENAME#TAG]` for anchored edits; NEVER invent tag.
{{/if}}- Directory: complete root; child listings cap at 12 (`… N more`), read child; page via :N-M/:-N.
- SQLite: file.db tables; :table schema/rows; :table:key by primary key; ?limit=, ?where=, ?q=SELECT.
- Archives: ZIP/JAR/APK/WHL, compressed TAR, RAR/7z/ISO/CAB/DEB/RPM/CPIO/AR/LZH/ARJ/ASAR, compressed streams; member via archive.ext:member/path.
- JSON/JSONL/NDJSON: file.json?q=<jq filter>; &raw=true unquoted strings, &compact=true one-line values, &offset=&limit= page results; `&` inside the filter → %26.
{{#if BINARY_VIEWS}}- Executables (ELF/PE/Mach-O, extensionless ok): overview + function list; :<func|0xaddr> pseudocode, :<func>:asm, :imports, :exports, :strings, :xrefs:<func|0xaddr>; line ranges apply after the view (bin:main:10-40). Universal Mach-O: host-arch slice by default, bin:@<arch> picks another (bin:@x86_64:main).
{{/if}}- PDF/documents: extracted text; notebooks: editable cells; images: decoded inline. URLs: reader text/markdown, :raw original HTML; bare host:port needs trailing slash.
