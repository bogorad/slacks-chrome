## General instructions

- For long-running operations use subagents.
- Use all tools provided by Serena-mcp.
- On ANY code or docs change (however small), bump patch version `zz` in `xx.yy.zz` across all relevant places before finishing work (at minimum `manifest.json` and popup version text in `popup/popup.html`, plus any other version surfaces in this repo).

## Beads usage

- If user tells you to use beads, read ./BEADS.md

## Serena Project State

- Serena config lives in `.serena/project.yml` and `~/.serena/serena_config.yml`
- Onboarding writes memory files under `.serena/memories/`
- Treat `.serena/` as local agent state unless explicitly intended for version control
