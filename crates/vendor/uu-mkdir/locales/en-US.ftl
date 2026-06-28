mkdir-about = Create the given DIRECTORY(ies) if they do not exist
mkdir-usage = mkdir [OPTION]... DIRECTORY...
mkdir-after-help = Each MODE is of the form [ugoa]*([-+=]([rwxXst]*|[ugo]))+|[-+=]?[0-7]+.

# Help messages
mkdir-help-mode = set file mode (not implemented on windows)
mkdir-help-parents = make parent directories as needed
mkdir-help-verbose = print a message for each printed directory
mkdir-help-selinux = set SELinux security context of each created directory to the default type
mkdir-help-context = like -Z, or if CTX is specified then set the SELinux or SMACK security context to CTX

# Error messages
mkdir-error-empty-directory-name = cannot create directory '': No such file or directory
mkdir-error-file-exists = { $path }: File exists
mkdir-error-failed-to-create-tree = failed to create whole tree
mkdir-error-cannot-set-permissions = cannot set permissions { $path }

# Verbose output
mkdir-verbose-created-directory = { $util_name }: created directory { $path }
