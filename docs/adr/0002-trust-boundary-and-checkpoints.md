# Restricted model tools, explicit permission and preserved Git ownership

Status: Accepted for this unmerged implementation

The reviewer uses deny-by-default session permissions and only bounded source inspection plus validated result submission. The fixer loses shell/delegation during automatic fix phases; approved checks run in the controller. Custom tools use native permission assert when available, otherwise V2 session permission creation, accepting only explicit allow. Unsupported APIs fail before checks or model calls; they never become an unconditional bypass.

File access rejects symlink components, including dangling aliases and ancestors of new paths. Logical protected paths and Git ignore rules are also checked. Searches skip symlinks before containment/read checks; direct reads reject them. These checks reduce alias attacks but do not remove hostile concurrent-filesystem races. Existing trusted plugins and approved repository code still have host authority: this is not an OS sandbox.

Review submission is provisional until successful turn completion and integrity verification. All prior blocking findings require explicit resolution, even when their file leaves the current diff. Typed validation/input errors may recover through later successful execution; an unknown-tool-name validation failure may recover through a later valid submission. Infrastructure, authorization and unclassified errors remain fatal.

Reviewed projects are never automatically staged, committed, pushed, merged, stashed or reset. Findings, fix summaries, checks and fingerprints provide audit evidence instead of automatic checkpoint commits, preserving the user's index and avoiding commit-hook mutation. Development of this plugin uses incremental commits separately.

Tracked integrity uses Git's binary working diff against pinned HEAD rather than hashing every unchanged tracked asset in JavaScript. Untracked content is separately fingerprinted. This reduces repeated work and removes the artificial 64 MiB limit on unchanged tracked assets, but inherits Git's filter/index semantics and is not forensic whole-filesystem integrity. Explicit output and review-input budgets remain fail-closed.
