sort-about = Display sorted concatenation of all FILE(s). With no FILE, or when FILE is -, read standard input.
sort-usage = sort [OPTION]... [FILE]...
sort-after-help = The key format is FIELD[.CHAR][OPTIONS][,FIELD[.CHAR]][OPTIONS].

  Fields by default are separated by the first whitespace after a non-whitespace character. Use -t to specify a custom separator.
  In the default case, whitespace is appended at the beginning of each field. Custom separators however are not included in fields.

  FIELD and CHAR both start at 1 (i.e. they are 1-indexed). If there is no end specified after a comma, the end will be the end of the line.
  If CHAR is set 0, it means the end of the field. CHAR defaults to 1 for the start position and to 0 for the end position.

  Valid options are: MbdfhnRrV. They override the global options for this key.

# Error messages
sort-open-failed = open failed: {$path}: {$error}
sort-parse-key-error = failed to parse key {$key}: {$msg}
sort-cannot-read = cannot read: {$path}: {$error}
sort-open-tmp-file-failed = failed to open temporary file: {$error}
sort-compress-prog-execution-failed = could not run compress program '{$prog}': {$error}
sort-compress-prog-terminated-abnormally = {$prog} terminated abnormally
sort-cannot-create-tmp-file = cannot create temporary file in {$path}:
sort-file-operands-combined = extra operand {$file}
    file operands cannot be combined with --files0-from
    Try '{$help} --help' for more information.
sort-multiple-output-files = multiple output files specified
sort-minus-in-stdin = when reading file names from standard input, no file name of '-' allowed
sort-no-input-from = no input from {$file}
sort-invalid-zero-length-filename = {$file}:{$line_num}: invalid zero-length file name
sort-options-incompatible = options '-{$opt1}{$opt2}' are incompatible
sort-invalid-key = invalid key {$key}
sort-failed-parse-field-index = failed to parse field index {$field} {$error}
sort-field-index-cannot-be-zero = field index can not be 0
sort-failed-parse-char-index = failed to parse character index {$char}: {$error}
sort-invalid-option = invalid option: '{$option}'
sort-invalid-char-index-zero-start = invalid character index 0 for the start position of a field
sort-invalid-field-spec = {$msg}: invalid field specification {$spec}
sort-invalid-count-at-start-of = invalid count at start of {$string}
sort-invalid-number-at-field-start = invalid number at field start
sort-invalid-number-after-dash = invalid number after '-'
sort-invalid-number-after-dot = invalid number after '.'
sort-invalid-number-after-comma = invalid number after ','
sort-field-number-is-zero = field number is zero
sort-character-offset-is-zero = character offset is zero
sort-stray-character-field-spec = stray character in field spec
sort-invalid-batch-size-arg = invalid --batch-size argument '{$arg}'
sort-minimum-batch-size-two = minimum --batch-size argument is '2'
sort-batch-size-too-large = --batch-size argument {$arg} too large
sort-maximum-batch-size-rlimit = maximum --batch-size argument with current rlimit is {$rlimit}
sort-extra-operand-not-allowed-with-c = extra operand {$operand} not allowed with -c
sort-separator-not-valid-unicode = separator is not valid unicode: {$arg}
sort-separator-must-be-one-char = separator must be exactly one character long: {$separator}
sort-only-one-file-allowed-with-c = only one file allowed with -c
sort-failed-fetch-rlimit = Failed to fetch rlimit
sort-invalid-suffix-in-option-arg = invalid suffix in --{$option} argument {$arg}
sort-invalid-option-arg = invalid --{$option} argument {$arg}
sort-option-arg-too-large = --{$option} argument {$arg} too large
sort-error-disorder = {$file}:{$line_number}: disorder: {$line}
sort-error-buffer-size-too-big = Buffer size {$size} does not fit in address space
sort-error-no-match-for-key = ^ no match for key
sort-error-write-failed = write failed: {$output}
sort-failed-to-delete-temporary-directory = failed to delete temporary directory: {$error}
sort-failed-to-set-up-signal-handler = failed to set up signal handler: {$error}

# Warning messages
sort-warning-failed-to-set-locale = failed to set locale
sort-warning-simple-byte-comparison = text ordering performed using simple byte comparison
sort-warning-sort-rule = text ordering performed using ‘{$locale}’ sorting rules
sort-warning-key-zero-width = key {$key} has zero width and will be ignored
sort-warning-key-numeric-spans-fields = key {$key} is numeric and spans multiple fields
sort-warning-leading-blanks-significant = leading blanks are significant in key {$key}; consider also specifying 'b'
sort-warning-numbers-use-decimal-point = numbers use '.' as a decimal point in this locale
sort-warning-options-ignored = options '-{$options}' are ignored
sort-warning-option-ignored = option '-{$option}' is ignored
sort-warning-option-reverse-last-resort = option '-r' only applies to last-resort comparison
sort-warning-obsolescent-key = obsolescent key '{$key}' used; consider '-k {$replacement}' instead
sort-warning-separator-grouping = field separator '{$sep}' is treated as a group separator in numbers
sort-warning-separator-decimal = field separator '{$sep}' is treated as a decimal point in numbers
sort-warning-separator-minus = field separator '{$sep}' is treated as a minus sign in numbers
sort-warning-separator-plus = field separator '{$sep}' is treated as a plus sign in numbers

# Help messages
sort-help-help = Print help information.
sort-help-version = Print version information.
sort-help-human-numeric = compare according to human readable sizes, eg 1M > 100k
sort-help-month = compare according to month name abbreviation
sort-help-numeric = compare according to string numerical value
sort-help-general-numeric = compare according to string general numerical value
sort-help-version-sort = Sort by SemVer version number, eg 1.12.2 > 1.1.2
sort-help-random = shuffle in random order
sort-help-random-source = use FILE as a source of random data
sort-help-dictionary-order = consider only blanks and alphanumeric characters
sort-help-merge = merge already sorted files; do not sort
sort-help-check = check for sorted input; do not sort
sort-help-check-silent = exit successfully if the given file is already sorted, and exit with status 1 otherwise.
sort-help-ignore-case = fold lower case to upper case characters
sort-help-ignore-nonprinting = ignore nonprinting characters
sort-help-ignore-leading-blanks = ignore leading blanks when finding sort keys in each line
sort-help-output = write output to FILENAME instead of stdout
sort-help-reverse = reverse the output
sort-help-stable = stabilize sort by disabling last-resort comparison
sort-help-unique = output only the first of an equal run
sort-help-key = sort by a key
sort-help-separator = custom separator for -k
sort-help-zero-terminated = line delimiter is NUL, not newline
sort-help-parallel = change the number of threads running concurrently to NUM_THREADS
sort-help-buf-size = sets the maximum SIZE of each segment in number of sorted items
sort-help-tmp-dir = use DIR for temporaries, not $TMPDIR or /tmp
sort-help-compress-prog = compress temporary files with PROG, decompress with PROG -d; PROG has to take input from stdin and output to stdout
sort-help-batch-size = Merge at most N_MERGE inputs at once.
sort-help-files0-from = read input from the files specified by NUL-terminated NUL_FILE
sort-help-debug = underline the parts of the line that are actually used for sorting
