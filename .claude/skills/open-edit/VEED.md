# VEED's editor

For when the user wants to change the piece themselves in VEED's editor, or brings a project from it.
`veed-project` uses the VEED login transcription uses. Neither command spends VEED credits or anything on
the user's fal account.

## Hand the piece over

```
openedit veed-project runs/<key>/veed-plan.json
```
It makes a private project in the user's VEED workspace in which every part is its own element: footage
cuts, text, captions, images and each audio track are the editor's own, and each page element the plan
names is a transparent clip cut to its box. `veed-project --help` lists the plan's fields.
- Give the editor what it can own: footage as `video` parts or an `edl` part, text a person may retype as
  `text` parts, captions as a `captions` part, the soundtrack as a `mix` part (its ducking is not carried).
- Name as `layer` parts (a CSS selector each) the page elements a person would move or retime on their
  own. A layer's `at` and `to` are page time, which is project time unless it gives `shift`. The editor
  has no blend modes, so an element drawn with `mix-blend-mode` is left out of every layer, and the
  command names it.
- `--local` renders and cuts the layers without uploading, to look at them first.
- It ends by putting the hand-off on the clipboard (on macOS; elsewhere it names the `handoff.txt` to
  copy) and opening VEED. The user clicks the "OpenEdit to VEED" bookmark there, which lays the
  timeline in their own VEED session and opens the editor. They install the bookmarks once from the
  page `openedit veed-project --install-bookmark` opens. Tell them both.

## Take a project from VEED

The user opens the project in VEED's editor and clicks the "Send to Claude" bookmark (on the same page
as the other), which saves `openedit-<project id>.json` into Downloads.
```
openedit veed-pull ~/Downloads/openedit-<project id>.json --out runs/<key>
```
It downloads the project's files into `runs/<key>/media` and writes `runs/<key>/plan.json`: its footage,
audio, images, text and page layers, placed and timed as the person left them. What the plan cannot
carry (subtitle tracks, speed changes, crops, filters, other kinds of element) is printed as not in the
plan. A file that does not download fails the command: the user sends the project again for fresh links.
- Edit that plan and send it with `veed-project`. That makes a new project and leaves theirs as it was.
  Files the project already had are copied inside VEED, not uploaded again, unless changed on disk.
- A part whose `origin` names a `layer` is the picture of a page element, placed and timed where the
  person left it. To change what it draws, change the page and put the part's `origin.asLayer` in its
  place: `veed-project` renders the element again, where and when the person left it.
- A recording comes with no transcript: `transcribe` its file in `media/`.
