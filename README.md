# Slacks Chrome Extension

This extension makes Slack tabs easier to manage when you have many of them open.

With Slack defaults, tab favicons look nearly identical, so it is hard to tell which workspace a tab belongs to at a glance. This extension replaces the default Slack favicon with the workspace team icon, so each tab is visually distinct.

It also adds unread markers on top of that icon:

- general unread activity -> ring marker
- personal unread activity (mentions/DM/thread attention) -> filled marker

Both marker colors are configurable in the popup (pink, red, green, blue, yellow).

For implementation details, detection logic, rendering behavior, and selector/debounce notes, see `TECHNICAL.md`.
