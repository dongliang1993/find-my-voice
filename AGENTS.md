# AGENTS.md

Guidance for agents working in this repo.

## What this is

A local AI companion chat app: Hono + WebSocket server in `src/`, React UI in `web/src/`, Tauri shell in `src-tauri/`. All user data lives in `~/.find-my-voice/` (override with `FIND_MY_VOICE_HOME`).

## Commands

```sh
npm run dev        # server (auto-restart) + Vite
npm test           # node:test via tsx
npm run typecheck  # tsc over both projects
```

**The user starts the dev server themselves.** Do not background `npm run dev` unless asked.

## Design

**Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**

A hint under a field, a caption under a heading, a "STARTING" under a progress bar — each one has to earn its place. If the shape of the screen already says it, delete the words. Prefer one strong element over a labelled one.

The app is quiet by design: OS1 cream and coral, her voice, generous space. Text is the content, not the chrome.

## Code

- Comments explain *why*, in English, and only where the reason is not obvious from the code.
- Immutable updates; no mutation of state.
- Web imports use `@/` (→ `web/src/`) and `@shared/` (→ `src/shared/`). Server imports use relative paths with `.js` extensions.
- Feature code lives under `web/src/features/<feature>/`; `components/ui` is shadcn primitives.
- Motion belongs in `motion/react` or on a canvas — never drive animation through per-frame React state if a transform or a draw call will do.

## Testing

`node:test` + `node:assert/strict`, one file per subject in `test/`. Tests build real stores against `mkdtempSync` dirs rather than mocking.
