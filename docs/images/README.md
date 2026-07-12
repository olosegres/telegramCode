# README screenshots

The Quick Start in the top-level `README.md` references the images below. Drop
the real PNGs here with these exact filenames and they render inline. Portrait
phone screenshots look best (the README sizes them to `width="360"`).

| File | Step | What to capture (where the user clicks) |
|---|---|---|
| `01-botfather.png` | 2. Create the bot | The @BotFather chat: `/newbot` giving the token, then `/setprivacy` → this bot → **Disable**. |
| `02-enable-topics.png` | 3. Set up a group | Group settings with the **Topics** (Forum mode) toggle switched on. |
| `03-promote-admin.png` | 3. Set up a group | The bot's admin-rights screen with **Manage Topics**, **Delete Messages**, **Pin Messages** ticked. |
| `04-bind-and-run.png` | 5. Bind a topic | A topic where `/bind <subdir>` then `/claude` (or `/opencode`) was sent and the agent is replying. |

Notes:
- Blur/redact anything private before committing (real chat/group/user ids,
  group name, tokens, home paths). The repo is public.
- Paths are relative, matching `demo.gif`, so they render in the GitHub/GitLab
  web view. Relative images do **not** render on the npmjs.com package page
  (the same limitation applies to `demo.gif`); switch every image reference —
  including `demo.gif` — to an absolute raw URL if npm-page rendering is needed.
