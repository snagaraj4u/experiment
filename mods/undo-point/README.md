# undo-point

A Claude Code mod that saves an undo point before risky actions, so you can roll back with one click.

- **Risky actions**: shell commands that delete, move or overwrite files (`rm`, `mv`, `rmdir`, `unlink`, `shred`, `truncate`, `> file`, `git clean`, `git reset --hard`, `git checkout -- …`, `git restore`), an Edit/Write/NotebookEdit of an existing file, and a turn that touches more than 5 files.
- **Storage**: `~/.undo-snapshots/<timestamp>/` holds `manifest.json` plus `files/<absolute path>` copies. Git operations also record `git stash create` under `refs/undo-point/<timestamp>`. One undo point per turn; the newest 50 are kept.
- **/restore** (or `/undo-restore` if `/restore` is already taken) lists undo points and opens a pane with a Restore button per point; `/restore 2` restores #2 directly. Restoring first saves the current state as a new undo point.
- A toast says "Undo point saved" each time; the status line shows the count.
- **Fail closed**: if the snapshot can't be made (copy error, over 1 GiB, files only known at run time such as `xargs rm` or `rm $VAR`), the action is blocked with the reason.
