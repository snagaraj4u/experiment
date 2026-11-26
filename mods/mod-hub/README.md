# mod-hub

A control panel for your Claude Code mods.

- `/mods` opens a pane listing every mod in your mods folder, plus any other plugin that loads after the hub. Each mod has an **On/Off** button, and the pane has **All on**, **All off** and **Refresh** buttons. A **Reload mods** button appears when the CLI has `/reload-plugins`.
- `/mods on <name>`, `/mods off <name>`, `/mods all on|off` do the same from the prompt.
- The status line shows `⚙ mods 2/2 on`.

How switching works: the switches live in `~/.claude/mod-switches.json` as `{ "<mod>": false }`.
- Mods that read that file (prompt-refiner, undo-point) obey at once.
- Any other user mod is refused when it next loads (a reload or a new session), provided it loads after the hub. Mods required by your organization are never refused.
