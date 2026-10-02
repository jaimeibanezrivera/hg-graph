# Hg Graph

A graphical changeset graph for Mercurial repositories, with lanes for topics
and named branches.

Run **Hg Graph: Open** from the command palette, click **Hg Graph** in the
status bar, or use the graph button in the Source Control view. The graph highlights the checked-out changeset, defaults
to the active topic, and supports topic and text filters.

Click a changeset to open its details and changed files in a panel below the
row, with added and deleted line counts per file. Click the row again or press
Escape to close it. Click a file to open a side-by-side diff against the
changeset's first parent.

Settings:

- `hgGraph.maxCommits` controls how many changesets are loaded at first, and
  how many more the **Load more changesets** button at the bottom adds.
- `hgGraph.laneWidth` controls the horizontal spacing between graph lanes.
- `hgGraph.detailsLocation` is `inline` (panel below the row, default) or
  `side` (panel to the right of the graph).
- `hgGraph.showStatusBarItem` shows or hides the status bar button.

Values set under the old `mercurialTopicMap.*` keys are still read when the
new keys are not set.
