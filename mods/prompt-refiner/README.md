# prompt-refiner

Before your prompt reaches the main model, a cheap model (Haiku by default) rewrites it as a structured brief: Goal, Requirements, Constraints, Done when, Open questions. The main model is still whichever model the session uses.

- **Default (`mode context`)**: your words go through unchanged and the brief is attached beside them for the model. Your words win wherever the two differ.
- **`mode replace`**: the brief is sent in place of your prompt, with your original appended.
- Skipped: slash commands, prompts under 8 words ("yes", "do it"), prompts a plugin sends, and anything you start with `raw:`.
- If the cheap model fails or times out (20 s), the prompt goes through as typed.

Commands: `/refine on`, `/refine off`, `/refine status`, `/refine show` (last brief), `/refine model haiku|sonnet|opus`, `/refine mode context|replace`.

The status line shows `✎ refine: haiku` or `✎ refine: off`. Turning it on or off writes `~/.claude/mod-switches.json`, which mod-hub shares.

**Cost**: each refined prompt adds one cheap-model call. It saves money only when clearer prompts cut back-and-forth with the expensive model. Use `/refine show` to judge whether the briefs help.
