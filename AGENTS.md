# AGENTS.md

Project context and conventions for AI coding agents. See PLAN.md for
scope, DECISIONS.md for rationale, PROGRESS.md for current state.

## Session start

Read PROGRESS.md before reading any source file.

## Commits

- Author and committer are always the identity from the local git config.
  Never override `user.name`/`user.email`, never pass `--author`.
- Commit messages describe the change and nothing else: no attribution
  footers, no `Co-Authored-By` trailers, no tooling references. This repo
  keeps a single human author on record because authorship here means
  accountability for the decision, not credit for the keystrokes — the
  reasoning behind every non-obvious choice is in DECISIONS.md.
- Many small commits with meaningful messages. Never one large commit at
  the end of a phase.
- Update PROGRESS.md in the same commit as the phase work it describes,
  never as a separate "update docs" commit.

## The one exception

The scheduled collector workflow (`.github/workflows/collect.yml`) commits
under a distinct bot identity by design — see DECISIONS.md #13. That is
the only place a non-human author is correct.
