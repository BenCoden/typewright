# Typewright

A local-first typing trainer for the books you already own. It reads EPUB, PDF, Markdown, HTML, and plain text, and turns each one into a typing session that keeps the book's structure intact:

- **Prose** is normalised and split into sentence-sized runs
- **Code listings** are typed verbatim — indentation, braces, and newlines included
- **Figures** are extracted from the file, stored locally, and shown inline as you type past them

Nothing leaves your machine. There is no account, no sync, and no outbound network call at runtime.

## Quick start

```bash
docker compose up -d --build
```

Then open <http://localhost:5000>.

On Windows there is a launcher that also opens a dedicated app window:

```powershell
.\Start-Typewright.ps1            # start and open
.\Start-Typewright.ps1 -Rebuild   # rebuild the image first
.\Start-Typewright.ps1 -Stop      # shut down
```

App mode (`chrome.exe --app=...`) matters more than it sounds: it removes the tab strip and with it the browser shortcuts that would otherwise fire mid-sentence. `Ctrl+W` cannot be intercepted by a web page, so the launcher removes the tab it would close.

### Without Docker

```bash
npm install
npm run dev     # http://localhost:5000, Express + Vite on one port
```

## Importing

Drag files onto the library page, or drop them in `./books` and click them in the **Watched folder** panel — that directory is mounted read-only into the container.

| Format | Prose | Code listings | Figures | Notes |
| --- | --- | --- | --- | --- |
| **EPUB** | Yes | Yes, exact | Yes, with captions | The best source. Structure is explicit in the markup. |
| **PDF** | Yes | Approximate | Yes | Text is reconstructed from glyph positions, so listing boundaries and indentation are guesses. |
| **Markdown** | Yes | Yes, from fenced blocks | No | Language tags on fences are used directly. |
| **HTML** | Yes | Yes, from `<pre>` | No | External images are not fetched. |
| **TXT** | Yes | Indent-detected | No | Project Gutenberg boilerplate is stripped automatically. |

Import both formats of the same book if you like — prefer the EPUB. On a Manning MEAP, the EPUB yields exact `<pre>` listings with their `Listing 10.1 …` captions and annotation legends, while the same PDF splits some listings and mixes annotation text into the flow.

Scanned PDFs with no text layer are rejected with an explanation rather than imported as gibberish.

## Documentation sites and wikis

Paste a link on the library page and Typewright types the article — not the site chrome. Navigation bars, cookie banners, "copy" buttons, edit links, and reference markers are dropped before anything reaches the page.

One page is imported at a time, but its table of contents comes with it. Every entry in that TOC is reachable from the keyboard, and an entry you have not read yet is fetched the moment you open it. Pasting one link therefore gives you the whole doc set without downloading it.

### How a page is read

Typewright picks a route per site, best first:

| Route | Used for | What it gets |
| --- | --- | --- |
| **Markdown source** | Microsoft Learn and other docs published from Git | The original `.md` behind the page, so code fences are exact. `:::code` references are followed into the sample repository and the named `#region` is extracted. |
| **Wiki API** | MediaWiki sites, including Wikipedia | The REST content endpoint, which returns clean article HTML. |
| **Article extraction** | Everything else | The main article element, chosen by scoring candidates on text density. |
| **Rendered page** | Sites that build their content in the browser | Optional. See below. |

Microsoft Learn is worth calling out: the page you see in a browser is a JavaScript shell with no code in it at all. Typewright reads the Markdown source instead, which is why C# listings come through with their indentation intact.

### Media and links

Figures, screenshots, and embedded video come across with the page. A YouTube or Vimeo embed becomes a player you can watch in place; it is shown, never typed, the same as a figure.

Links are kept rather than flattened. The words that carried a link are underlined with a dotted rule where they appear in the text, and `Ctrl+L` opens a side panel listing every destination with the block it came from — click a row to jump back to that paragraph. Links that lead to another page in the same table of contents get a **Type this page** button, so following a reference is the same gesture as opening any other page.

### Navigating a doc set

| Keys | Action |
| --- | --- |
| `Ctrl` `;` | Jump palette over the whole table of contents. Type to filter, arrows to move, `Enter` to open. |
| `Ctrl` `.` | Next page |
| `Ctrl` `,` | Previous page |
| `Ctrl` `O` | Contents panel — the doc set on one tab, this page's headings on the other |
| `Ctrl` `L` | Links on this page, and which block each came from |

A tick marks pages already in your library. The rest are one keystroke and one fetch away.

### Checking for updates

Documentation changes. The refresh button on a page's card in the library re-fetches it and compares content; if nothing changed it says so and leaves your progress alone. If it did change the page is rebuilt, which resets progress on that page.

The comparison is against the text Typewright extracted, not the raw HTML, so an improvement to the importer also counts as a change. That means a page imported by an older version can be brought up to date without deleting it.

### Pages that need JavaScript

Some sites ship an empty shell and assemble the article in the browser. Reading those needs a real browser, so headless Chromium runs as a second container that is **off by default**:

```bash
docker compose --profile render up -d
```

Without it, such a page fails with a message saying so rather than importing something empty. Everything above the "Rendered page" row works without it.

## Typing

| Key | Behaviour |
| --- | --- |
| Printable keys | Compared against the expected character |
| `Enter` | A real character inside a listing — a faint `⏎` marks where it is due |
| `Tab` | Fills in expected indentation, up to 8 spaces |
| `Backspace` | Steps back, clearing auto-filled indentation in one move |

### Shortcuts

Typing consumes every printable key, so commands sit on modifiers. `Ctrl+/` shows this list in-session, and the **Shortcuts** page in the nav has the same list with a search box.

Ligatures are switched off everywhere text is typed. A monospace font that draws `=>` as a single arrow hides the fact that two keystrokes are expected.

| Shortcut | Does |
| --- | --- |
| `Ctrl+M` | Switch in and out of reading mode |
| `Ctrl+/` | Show the shortcut list |
| `Esc` | Pause and resume |
| `Ctrl+↓` | Skip the rest of the current line |
| `Ctrl+→` | Skip this paragraph, listing, or figure |
| `Ctrl+←` | Back to the previous paragraph |
| `Ctrl+Shift+→` / `Ctrl+Shift+←` | Jump between section headings |
| `Ctrl+Backspace` | Start this block over |
| `Ctrl+O` | Contents panel |
| `Ctrl+L` | Links on this page |
| `Ctrl+;` | Jump to any page in the table of contents |
| `Ctrl+.` / `Ctrl+,` | Next or previous page in a documentation set |

**Reading mode** is a read-only pass over the same page at its own text size and leading — nothing is scored, and the HUD gets out of the way. Because no keystrokes are being graded there, the bare keys are free for navigation:

| Key | Does |
| --- | --- |
| `↓` / `J`, `↑` / `K` | Move a block forward or back |
| `Shift+→` / `Shift+←` | Next or previous section heading |
| `Space` | Scroll normally |
| `Enter` | Start typing from here |

### Typing settings

| Setting | Options | Notes |
| --- | --- | --- |
| **On a mistake** | Block / Mark / Fix | Block holds the cursor until you type the right character. Mark leaves it visible and moves on. Fix repairs the character so the page stays readable — the error still counts and the repair earns no credit. |
| **After finishing a block** | Move on / Wait for Enter | Whether the cursor advances by itself or you set the pace. |
| **Ignore capitalisation in prose** | On / Off | Prose only. Listings always compare exactly, because case matters in code. |
| **Auto-indent code** | On / Off | Fills the next line's leading whitespace after `Enter`. Those characters are not counted as keystrokes, so they neither help nor hurt your speed. |
| **Skip code listings** | On / Off | Read listings instead of typing them. |
| **Caret style** | Line / Block / Underline | Plus a separate blink toggle. |
| **Show newline markers** | On / Off | The `⏎` at each line end inside a listing. |
| **Keep active line in position** | On / Off | Pins the line you are typing instead of scrolling the page under you. |
| **Mark incorrect words** | On / Off | Underlines the whole mistyped word, not just the missed character. |
| **Auto-pause** | 2s / 5s / 10s / Never | Idle longer than this and the session parks itself. The same threshold stops the clock, so the timer and the screen always agree about whether you are working. |
| **Tone on a mistake** | On / Off | Synthesised, not a downloaded asset. |

Reading mode has its own text size and line height, separate from the typing prompt.

## Where your data lives

```
data/
  typewright.db        SQLite: books, blocks, sessions, settings
  typewright.db-wal    write-ahead log
  assets/<bookId>/     figures extracted from that book
```

Back up `./data` and you have backed up everything. Delete it and the app starts empty. Sessions shorter than a second or five keystrokes are discarded rather than polluting your averages.

## How it is put together

```
shared/schema.ts     Data model shared by client and server
server/import.ts     File -> ordered blocks. Format parsers, normalisation, segmentation
server/storage.ts    SQLite access, schema creation, statistics
server/routes.ts     JSON API
client/src/lib/typing.ts        Typing engine — pure functions, no React
client/src/components/shortcuts.tsx  One shortcut list, shared by the overlay and settings
client/src/components/reader.tsx  Renders prose, listings, and figures
client/src/pages/typing.tsx     Cursor, keyboard, metrics, windowed loading
```

Two decisions are worth knowing about if you extend it:

**Blocks, not a character stream.** A book is an ordered list of `prose | heading | code | image` blocks. That single choice is what lets code be typed verbatim while prose gets normalised, and lets figures sit in the flow without being typed.

**Normalise once, at import.** Curly quotes, em dashes, ellipses, non-breaking spaces, ligatures, and soft hyphens are folded to characters a keyboard can produce, and the result is what gets stored. The typing engine then compares keystrokes to exactly what is on screen. Inside listings, curly quotes are always straightened — no real source file contains them — while everything else stays byte-exact.

Long books stay responsive because the typing view only ever holds a 60-block window in memory, refetching as the cursor moves.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/books` | Library |
| `GET` | `/api/books/:id/blocks?from&count` | A window of blocks |
| `GET` | `/api/books/:id/outline` | Chapter and section headings |
| `POST` | `/api/import` | Multipart upload |
| `POST` | `/api/import/text` | Paste a passage or snippet |
| `POST` | `/api/import/url` | Import a documentation or wiki page, or return the copy already held |
| `POST` | `/api/books/:id/refresh` | Re-fetch a web page and report whether it changed |
| `GET` | `/api/books/:id/context` | Table of contents, position in it, previous and next pages |
| `GET` | `/api/books/:id/links` | Links on a page, with the block each appeared in |
| `GET` | `/api/collections` | Doc sets and how much of each is imported |
| `GET` | `/api/renderer` | Whether the optional Chromium sidecar is configured and answering |
| `GET` | `/api/library` | Files in the watched folder |
| `POST` | `/api/library/import` | Import from the watched folder |
| `GET` | `/api/assets/:id` | An extracted figure |
| `POST` | `/api/sessions` | Record a session |
| `GET` | `/api/stats` | Aggregates, daily series, worst keys |
| `GET`/`PATCH` | `/api/settings` | Preferences |

## Licence

Yours. The books you import stay yours too — they never leave the machine.
