# pi-skill-manager

Prompt-token audit, session-scoped skill/plugin switches, and project-aware recommendations for
[Pi](https://pi.dev). One Pi package, three surfaces:

| Surface | What it does |
| --- | --- |
| `/prompt-tokens` | Tokenizes the assembled system prompt, splits it into its real sections, and attributes cost per skill, per tool declaration and per context file. |
| `/resources` | Lists skills and plugins with their prompt cost; toggles them off for the current session. |
| `/pick` + `suggest_resources` tool | Reads the project (manifests, dependencies, file types, git changes, your prompt words), ranks what is worth enabling, and shows the same picker. |
| `/report [path]` | Writes `pi-installation-report.md` (or the given path): skills, plugins, built-in helpers, MCP servers, commands, context files, themes, scoped models and the prompt budget. |

A footer badge (`prompt 16.2k`) tracks the projected prompt cost across the session.

## Install

```bash
pi install git:github.com/pixel3design-hub/plugin_skill_manager   # from the repository
pi install /path/to/plugin_skill_manager                           # local checkout
pi -e /path/to/plugin_skill_manager                                # try it for one run
```

A local checkout needs `npm install` for the tokenizer dependency; Pi installs it for the git and
npm sources. Development: `npm test` and `npm run check` (the check needs the host types symlinked
into `.types/`, see below).

## Colour legend

| Colour | Meaning |
| --- | --- |
| green background | enabled and counted in the prompt |
| red background | locked: cannot be enabled this session (`disable-model-invocation` skill, package with nothing loaded, tool outside `defaultTools`) |
| yellow background | recommended, not installed — `i` copies its `pi install …` command |
| default background | turned off by you for this session |

## Keys

```
↑/↓ move · space toggle/accept · tab switch view · / filter · s sort · d details
p preview injected text · r write the installation report · A accept all · i copy install
c refresh catalog from npm · esc close
```

`p` shows exactly what Pi injects for the selected row: the `<skill>` block, the
pretty-printed tool declaration, the whole package payload, a prompt section verbatim, or a
project context file. Scroll with `↑↓`/`pgup`/`pgdn`, `p` or `esc` goes back.

`r` writes the installation report and opens it in the same scrollable view. The same report is
available as `/report` outside the manager, which accepts a target path:

```
/report                     → ./pi-installation-report.md
/report docs/pi-setup.md    → relative to the working directory
```

The report lists MCP servers by name, scope, transport and tool count. Transport is the command
name or the URL host only — arguments, headers and environment are never written down.

## Token accounting

- Counts come from `gpt-tokenizer` (`o200k_base`). Other model families are approximate; the audit
  header shows the tokenizer name. Without the dependency it falls back to Pi's own `chars/4`
  estimator and says `chars/4`.
- Sections are read from the real prompt Pi assembles (`preamble`, `tools`, `rules`, `docs`,
  `project_context`, `skills`, `cwd`, plus any extension sections), so no formatting is re-invented.
- Tool cost is the JSON declaration sent next to the system prompt, not the one-line snippet in it.
  Only `direct`-exposure tools are counted.
- Skill cost is the advertised `<skill>` block. The detail pane also shows what loading the full
  `SKILL.md` costs at runtime.

## What "off" actually does

- **Skill off** → removed from the skills section of the next request. `/skill:name` still works, so
  you can always force one.
- **Plugin off** → all of its direct tools are deactivated (`pi.setActiveTools`). Its commands,
  shortcuts and any text it appends to the system prompt keep working: Pi exposes no way to unload an
  extension mid-session and no ownership metadata for prompt sections. The tool declarations are
  where the prompt cost lives, so that is what the switch removes.
- Nothing is written to `settings.json`. State lives in a `skill-manager:state` session entry, so
  `/resume` and `/reload` keep it.

Optional `~/.pi/agent/skill-manager.json`:

```json
{ "statusBadge": false }
```

## Development

```bash
npm install
npm test          # node:test, type-stripped TypeScript, no build step
npm run check     # tsc --noEmit
```

`npm run check` resolves the Pi host types from `.types/node_modules`, which is a symlink to your Pi
installation's `node_modules` (gitignored):

```bash
mkdir -p .types && ln -sfn "$(dirname "$(readlink -f "$(command -v pi)")")/../node_modules" .types/node_modules
```

Host packages are `peerDependencies` marked optional on purpose: Pi maps them at runtime, and a
second physical copy inside this package can duplicate classes and registries.
