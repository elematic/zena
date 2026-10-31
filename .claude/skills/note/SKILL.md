---
name: note
description: File a bad pattern or cleanup for later as a GitHub issue labelled cleanup, without leaving the current task. Use when the person says to note something for later or fix it everywhere later, or when you notice a problem outside your task's scope.
---

# Note a pattern for later

Fix the instance in front of you if it is part of the current task, then
file the rest so that a cleanup session can pick it up, and go back to the
task.

1. Search for an open issue that already covers it:
   `gh issue list --label cleanup --search "<words>"`. If one exists, add
   a comment with the new example instead of filing another.
2. File it:

   ```bash
   gh issue create --label cleanup --title "[<package>] <what to change>" \
     --body-file <file>
   ```

   (`gh label create cleanup` first if the label does not exist.) The
   body says:

   - the pattern, with one or two `path:line` examples;
   - what to write instead, as a short code example;
   - how to find the other instances: an `rg` command, or the `zena lint`
     rule that reports them;
   - whether a lint rule, a check or a compiler change could prevent it,
     since that is the fix the weekly retro will look for.

3. Run `npm run check -- --text <file>` on the body before filing, since
   issues are public.
4. Tell the person the issue number in one line and continue.
