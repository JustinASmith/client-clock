# client-clock

A Claude Code mod that shows which client is using your time and your usage limits.

![The /clock pane: usage bars and a table of clients](docs/clock-pane.png)

For each client repo it logs:

- **your time**: the gap before each prompt you send, up to 10 minutes, plus time you spend watching Claude work from your phone or the web
- **Claude's time**: how long each turn ran
- **each client's share of your 5-hour and weekly limits**, in percentage points
- **estimated cost** at API prices
- **time locked out** when a limit hits 100%
- **your commits** on any local branch

Everything stays on your machine.

## Requirements

Claude Code with mods (function hooks). Built and tested on Claude Code 2.1.286. Mods are early access, so a later release may change the API this uses.

## Install

Clone it and point Claude Code at the folder:

```bash
git clone https://github.com/JustinASmith/client-clock ~/.claude/mods/client-clock
```

Then add this to the `env` block of `~/.claude/settings.json` so every session loads it:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/client-clock"
```

To try it in one session first, run `claude --plugin-dir ~/.claude/mods/client-clock`.

The repo is also a plugin marketplace:

```
/plugin marketplace add JustinASmith/client-clock
/plugin install client-clock@client-clock
```

## Use

1. **Label each repo once.** In a client's repo, run `/client acme`. Every session in that repo counts toward acme from then on, and earlier sessions there count too. For your own projects, `/client personal` logs the time without billing it. In a repo with no label, the band above the prompt asks which client it is.
2. **Open the dashboard** with `/clock`: usage bars, a row per client, Today, Week and Last week, and CSV export.
3. **Print the table** with `/ledger today`, `/ledger week` or `/ledger lastweek`. `/ledger csv week` writes a CSV. `/ledger add 30m call with acme` adds time you spent away from the keyboard.
4. **Set a budget** with `/client budget 25`, in points of your weekly limit. You get a heads-up when the client reaches it, and when one client is at least half of a 5-hour window that's 80% used.

The band above the prompt shows today's totals for the repo's client.

## How it counts

- **You**: the gap before each prompt you type, capped at 10 minutes so a break doesn't count. Watching from your phone or the web counts while Claude is working. Overlapping sessions count once, split between the clients active at that moment.
- **Claude**: each turn's duration. Turns in parallel sessions can overlap, so this can add up to more than the clock time.
- **Points**: the 5-hour and weekly limits are account-wide, so each rise between two readings is split by the tokens each client's turns used while they ran. Usage it can't tie to a turn (claude.ai, another machine, or a turn still running) shows as "other". These are estimates.
- **Cost**: what Claude Code reports the session would cost at API prices, counted from when the clock started.
- **Locked out**: time at 100% of a limit, split by each client's share of that window.
- **Commits**: your commits (by `git config user.email`) on any local branch of the client's repos, each counted once even across worktrees.

## Data

- One JSONL file per session in `~/.claude/client-clock/ledger/`
- CSV exports in `~/.claude/client-clock/exports/`
- Labels and budgets in the mod's own store

The mod makes no network requests.

## Develop

```bash
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
```

Claude Code writes the API's type declarations into `.claude-plugin/types/` when it loads the mod from your folder.

## License

[MIT](LICENSE)
