# pi-title

Auto-titles [pi](https://github.com/earendil-works/pi) sessions: after the
first completed exchange, one cheap nested model call turns the opening
exchange into a 2–6 word title and sets it with pi's own session naming — so
the session selector shows *"Fix the Rate Limiter Bug"* instead of the raw
first prompt.

Nothing about the conversation changes: the title call rides
`streamSimple` (like a nested tool call), is fire-and-forget at the run
boundary, and a manual title is never overwritten.

## Commands

| Command | What it does |
|---|---|
| `/title` | Show the current title and mode |
| `/title <text>` | Set a manual title — auto never overrides it |
| `/title auto` | Regenerate now from the first exchange |
| `/title on` / `/title off` | Toggle auto-titling (process-wide) |

## Behavior

- Fires once per session, on the first `agent_end` whose run contains a user
  message. Aborted or empty runs don't burn an attempt.
- The titler runs on the session's active model by default; override with
  `PI_TITLE_MODEL=provider/id` (e.g. a small cheap model). Reasoning is
  disabled for the call.
- Output is sanitized (quotes, `Title:` prefixes, markdown, trailing
  punctuation stripped; capped at 60 chars).
- Fail-open: provider errors leave the session unnamed and retry on the next
  run, at most 3 attempts, then warn once. `PI_TITLE=off` disables the
  extension entirely.
- A resumed session that already carries a name is left alone.
- Nested calls skip pi's `before_provider_headers` hooks, so the titling call
  carries the OpenCode identity itself (CLI User-Agent, `x-opencode-client`,
  canonical `ses_...` session id) and picks its auth the same way the
  opencode-free-tier hook does. Without it, `-free` OpenCode models answer
  `403 FreeTierError`. See `opencode-nested.ts`.

## Install

```bash
pi install git:github.com/hakergeniusz/pi-title
```

Try it without installing:

```bash
pi -e https://github.com/hakergeniusz/pi-title
```

Or copy `index.ts` anywhere and load it with `pi -e ./index.ts`.

## Test

```bash
bun test.ts
```

## License

MIT
