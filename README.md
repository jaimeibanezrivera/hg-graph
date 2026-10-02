# Hg Graph

A graphical changeset graph for Mercurial repositories, with lanes for topics
and named branches.

Run **Hg Graph: Open** from the command palette, click **Hg Graph** in the
status bar, or use the graph button in the Source Control view. The graph highlights the checked-out changeset, defaults
to the active topic, and supports topic and text filters.

Click a changeset to see its details and the files it changed. Click a file to
open a side-by-side diff against the changeset's first parent.

Settings:

- `hgGraph.maxCommits` controls how many changesets are loaded.
- `hgGraph.laneWidth` controls the horizontal spacing between graph lanes.
- `hgGraph.showStatusBarItem` shows or hides the status bar button.

Values set under the old `mercurialTopicMap.*` keys are still read when the
new keys are not set.
