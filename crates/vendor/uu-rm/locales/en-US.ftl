rm-about = Remove (unlink) the FILE(s)
rm-usage = rm [OPTION]... FILE...
rm-after-help = By default, rm does not remove directories. Use the --recursive (-r or -R)
  option to remove each listed directory, too, along with all of its contents

  To remove a file whose name starts with a '-', for example '-foo',
  use one of these commands:
  rm -- -foo

  rm ./-foo

  Note that if you use rm to remove a file, it might be possible to recover
  some of its contents, given sufficient expertise and/or time. For greater
  assurance that the contents are truly unrecoverable, consider using shred.

# Help text for options
rm-help-force = ignore nonexistent files and arguments, never prompt
rm-help-prompt-always = prompt before every removal
rm-help-prompt-once = prompt once before removing more than three files, or when removing recursively.
  Less intrusive than -i, while still giving some protection against most mistakes
rm-help-interactive = prompt according to WHEN: never, once (-I), or always (-i). Without WHEN,
  prompts always
rm-help-one-file-system = when removing a hierarchy recursively, skip any directory that is on a file
  system different from that of the corresponding command line argument (NOT
  IMPLEMENTED)
rm-help-no-preserve-root = do not treat '/' specially
rm-help-preserve-root = do not remove '/' (default)
rm-help-recursive = remove directories and their contents recursively
rm-help-dir = remove empty directories
rm-help-verbose = explain what is being done
rm-help-progress = display a progress bar. Note: this feature is not supported by GNU coreutils.

# Progress messages
rm-progress-removing = Removing

# Error messages
rm-error-missing-operand = missing operand
  Try '{$util_name} --help' for more information.
rm-error-cannot-remove-no-such-file = cannot remove {$file}: No such file or directory
rm-error-cannot-remove-permission-denied = cannot remove {$file}: Permission denied
rm-error-cannot-remove-is-directory = cannot remove {$file}: Is a directory
rm-error-dangerous-recursive-operation = it is dangerous to operate recursively on '/'
rm-error-dangerous-recursive-operation-same-as-root = it is dangerous to operate recursively on '{$path}' (same as '/')
rm-error-use-no-preserve-root = use --no-preserve-root to override this failsafe
rm-error-refusing-to-remove-directory = refusing to remove '.' or '..' directory: skipping {$path}
rm-error-cannot-remove = cannot remove {$file}
rm-error-may-not-abbreviate-no-preserve-root = you may not abbreviate the --no-preserve-root option

# Verbose messages
rm-verbose-removed = removed {$file}
rm-verbose-removed-directory = removed directory {$file}
