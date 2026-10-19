# pi-tool-one-line

A [Pi](https://pi.dev) extension that folds a whole burst of tool calls into a
single summary line, with two levels of expansion when you want the details.

```
Thinking ×9 · Bash ×6 · Edit ×3 · 12.4s
```

Instead of one row per call (and dozens of rows of output), each *segment* of a
turn leaves one line. Click it to see what ran, click again for the untouched
built-in rendering of a single call.

## What a segment is

A segment is the run of tool calls that follows one assistant message which
contains text, up to the next assistant message that contains text:

```
assistant (text) ─┬─ tool call
                  ├─ tool call     ← these collapse into one line
                  └─ tool call
assistant (text) ─┬─ tool call     ← new segment, new summary line
                  └─ tool call
```

Thinking blocks belong to the segment that follows their message, so the summary
counts exactly the thinking that the expanded view shows.

## Install

```bash
pi install git:github.com/Polyaris-0413/pi-tool-one-line@v1.0.0
```

Try it for one run without installing:

```bash
pi -e git:github.com/Polyaris-0413/pi-tool-one-line@v1.0.0
```

From a local checkout:

```bash
pi install ./pi-tool-one-line
```

## Usage

| Level | What you see | How to get there |
| --- | --- | --- |
| 0 | One summary line per segment: `Thinking ×N · Bash ×M · Edit ×K · duration` | default |
| 1 | One row per call (`Bash...`, `Edit...`, …) plus one `Thinking...` row per thinking block | click the summary line |
| 2 | The call's normal rendering: command, output, diff, live timer | click that row |

Clicking the summary again collapses the segment; nothing is left behind.

Calls that are still streaming are already attributed to their row, so the line
never flickers between a placeholder and the real label. The duration keeps
ticking while the segment is open and freezes when it closes.

## Scope

The extension registers **renderers only**. It does not re-register tools, so
the model still receives the same `result.content` it would get without the
extension; truncation, timeouts and tool descriptions stay with Pi.

Collapsed rows take zero height rather than a blank line: the extension hides
hidden-thinking labels and collapses the per-message spacer that Pi adds around
invisible messages.

## Caveats

- Best with `hideThinkingBlock: true`. When thinking blocks are visible they
  keep their own rows *and* are counted in the summary.
- Interactive TUI only; print/JSON/HTML modes are untouched.
- This works by patching a few Pi rendering internals (the container spacer
  rule, the hidden thinking label, the theme's empty-text check, and the
  `lastComponent` reuse of built-in tool renderers). It is tested against Pi
  1.3.x and may need attention after a Pi upgrade.
- Developed and tested on Windows (Windows Terminal + ConPTY); it should be
  platform-neutral but that is the only setup the suites have run on.

## Development

```bash
cd tests/tool-one-line
node run-all.cjs                       # fake-runtime tests, a few seconds
node run-all.cjs --tui                 # add real-TUI suites (calls the model)
node run-all.cjs --tui --with-reload   # add the session-reload suite
```

The fast tier runs against a fake runtime and needs no credentials. The TUI tier
spawns a real `pi` in a pseudo terminal with only this extension loaded, in an
isolated config directory (`tmp/tui-home`, gitignored) so personal settings and
other extensions cannot influence the layout. It needs `pi` on `PATH`; the
first run installs `node-pty` and `@xterm/headless`, and it reuses your Pi
credentials, so it does make model calls.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
