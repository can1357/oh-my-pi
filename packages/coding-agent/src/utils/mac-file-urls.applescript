-- Returns the POSIX paths of every file URL currently on the macOS
-- pasteboard, one path per line. `pbpaste(1)` only surfaces plain text,
-- EPS, or RTF, so a Finder Cmd+C (which puts only a `public.file-url`
-- representation on the pasteboard) makes `pbpaste` empty. The
-- `«class furl»` coercion reaches the file-URL representation directly and
-- works for both single-file and multi-file selections.
--
-- The coercion is guarded by `clipboard info for «class furl»`: AppleScript
-- happily coerces plain *text* into a file URL by treating it as an HFS
-- path, so an unguarded cast turns a copied `https://i.can.ac/x.png` string
-- into the mangled `/https/::i.can.ac:x.png` (HFS `:`↔`/` swap) and the
-- paste dead-ends with "Image not found" instead of falling back to pasting
-- the text. `clipboard info for` inspects the actual pasteboard types, so
-- it is `{}` unless a real `public.file-url` representation is present.
--
-- The `try` blocks suppress the `-1700` "can't make … into type" error
-- AppleScript raises when the clipboard holds no file URLs, so the script's
-- exit status only reflects `osascript` itself.
on run
	set output to ""
	try
		if (clipboard info for «class furl») is {} then return output
		set theClip to the clipboard as «class furl»
		if class of theClip is list then
			repeat with anItem in theClip
				try
					set output to output & POSIX path of anItem & linefeed
				end try
			end repeat
		else
			try
				set output to POSIX path of theClip & linefeed
			end try
		end if
	end try
	return output
end run
