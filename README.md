# dsh-env-memory

An authoritative environment record for **DeepSeek Harness (DSH)** sessions.

Every new session starts blind: is Python installed? Which version? Is `docker`
usable *inside* the sandbox the commands actually run in? Is this machine the one
I remember, or a rebuilt container? Today each session re-discovers all of that
with its own tool calls — and pays for it in tokens, every time.

This plugin removes that discovery cost. It probes the machine **locally**
(milliseconds, zero model tokens), keeps one durable record, and publishes a
byte-stable snapshot into every session's system prompt.

## What it does

```
probe (local, ~4 ms)  ──▶  facts + changelog  ──▶  system prompt snapshot
        ▲                                              │
        └──────────── NOTES.md (session write-back) ◀───┘
```

* **Snapshot** — one `systemPrompt.section` (≈1050 chars, ~300 tokens) that is
  present from the session's first request. It states plainly that the record is
  authoritative and must not be re-verified, and what to do when reality
  disagrees.
* **Probe engine** — 75 capabilities in a single batch `command -v` plus version
  probes. Measured: 3.8 ms for 60 presence checks, 0.18 ms for the fingerprint.
* **Session-shell probe** — capabilities are also probed through
  `ctx.shell` + `sandboxPolicy`, i.e. the *same* execution path the `bash` tool
  uses, so the snapshot can distinguish "the host has docker" from "your shell
  can reach docker".
* **Environment fingerprint** — `hash(os-release, kernel, hostname, arch,
  profile)`. A change (rebuilt container, new machine) marks every durable fact
  `unverified` instead of silently running on another machine's memory.
* **Write-back channel** — append one line to `NOTES.md`; it is drained within
  seconds into the changelog and the snapshot:

  ```
  - python3 | /usr/bin/python3 | 3.10.12, installed via apt by session 7dce
  ```

* **Self-healing** — a `command not found` / `ModuleNotFoundError` against a fact
  that claimed "present" bumps a contradiction counter; two contradictions demote
  the fact to observe-only.

## Layout

```
~/.dsh/env-memory/
├── SNAPSHOT.md      # exactly what the model sees
├── CHANGELOG.md     # bounded change history (200 entries)
├── NOTES.md         # append-only inbox for session write-back
├── state.json       # facts, changelog, terrain, fingerprint
└── diagnostics.log  # errors only; empty means healthy
```

## Install

```bash
# from the DSH checkout directory that holds your profile
plugin_manager install_bundle /absolute/path/to/dsh-env-memory
```

The bundle patch inserts one row, `env-memory`. It depends on `systemPrompt` and
`tools` only — no third-party packages, no imports from `@deepseek-ai/*`
(marketplace bundles cannot resolve them).

## Configuration

Row config (in this package's `cordis.patch.yml`, override in your profile patch):

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `snapshotMaxChars` | `1100` | hard cap on the prompt section |
| `changelogLimit` | `200` | ring size of the change history |
| `probeOnStartup` | `true` | fingerprint-diff scan on load |

## Known limits

* The `env_memory` tool registers, but a preset that installs its own
  `tools.restrict` allow-list will hide it — add `env_memory` to that list, or
  use the `NOTES.md` channel (which needs no tool at all).
* The session-shell probe runs once per sandbox mode per process, using the first
  agent's policy; mixed policies within one process are not modelled.
* The `地形` (terrain) section is produced at scan time; new directories appear
  only after the fingerprint changes.

## Design notes

The snapshot is deliberately *not* an inventory dump. On a real workload the
repeated discovery calls were: `ls ~/.dsh` 64×, `ls /etc` 41×, `ls /usr` 40×,
`cat package.json` 34×, `dpkg -l` 16×. The section therefore leads with
capability, then terrain *and where detail lives*, then traps (negative facts),
then the last changes. Coverage measured over 296 discovery calls: the top 5
entries cover 74%, the top 8 cover 85%, the top 10 cover 90%.

MIT licensed.
