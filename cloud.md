# cloud.md

Guidance for cloud-hosted agents working in this repo.

Everything in [AGENTS.md](./AGENTS.md) applies to you too: read it first. This file only adds what changes when you are not running on the user's machine.

## Where you differ from a local agent

- **The dev server is not yours to run.** You may not be able to reach the user's ports or processes. Unless the task depends on it, rely on `npm test` and `npm run typecheck` instead of a live preview; ask before starting anything that serves.
- **`~/.find-my-voice/` is not yours.** User data lives on the user's machine. Tests already build their own stores against `mkdtempSync` dirs — never assume the real home directory exists or is reachable.
- **Secrets stay server-side.** `voices.example.json` is a template; a real `voices.json` may not be present. Do not ask the user to paste API keys into the chat — guide them to set it up locally.
- **GUI verification is limited.** You cannot see the Tauri shell or the browser. When a change is visual, say what you changed and how to check it, rather than claiming it looks right.

## Testing

- **Test only on a finished feature.** Do not run tests on every intermediate step of a half-done change; wait until the feature is complete, then test once.
- **Run tests through a subagent on a cheap model.** Test runs are mechanical — read the output, report pass or fail. Delegate them, and spend the expensive model on the code, not on watching a test log.
