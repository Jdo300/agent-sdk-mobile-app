# Press stills

Six transparent-background PNGs of the app, for blog posts and decks.

| file | scene |
|---|---|
| `chat-light.png` / `chat-dark.png` | a coding turn: collapsed tool run, markdown reply with inline code, bullets, and a fenced TS block |
| `approval-light.png` / `approval-dark.png` | a tool approval with a permission suggestion, working directory, and allow/deny |
| `agents-light.png` / `agents-dark.png` | the agent list, one agent running |

1206×2622 (iPhone 17 Pro @3x), RGBA. The screen is opaque; the rounded corners
are transparent, so each still drops onto any background without a matte.

## How they were made

The app name ("Bloop") and its blue-sphere mark are placeholders carrying no
brand — see the repository README.

Captured from the dev-only `/stills` route (`src/app/stills.tsx`), which renders
the app's real components against curated fixtures — **no live account data**:
no real agent names, conversation titles, paths, or transcripts. Regenerate with
`?scene=chat|approval|agents`, and `?chrome=off` to drop the status sub-row.

Post-processing does two things only: Expo Go's floating dev-menu button (a
development-client overlay, not app UI) is painted out row-by-row using each
row's own background colour, and the corners are given an alpha mask. No app
pixels are retouched.
