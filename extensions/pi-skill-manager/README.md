# pi-skill-manager

## What it does
A [Pi](https://pi.dev/) extension that adds the `/skills` command, opening an overview menu of skills. 
In the menu you can then toggle each skill between **visible** and **hidden**.

## Reason

Skills are cheap to install and not cheap to carry. Every visible skill puts its name and description
in the system prompt of every turn, and a dozen of them the model rarely wants is a dozen chances to
be distracted by the wrong one. Hiding a skill removes it from the system prompt while leaving it
installed and loadable on demand, so a rarely-used skill costs nothing until you ask for it. 
Pi doesn't make it easy to enable/disable skills, so therefore this extension.

## Install
```sh
pi install npm:pi-skill-manager
```

## Usage
```sh
/skills
```

| Key | Action |
|---|---|
| `↑` `↓` | Navigate |
| `enter` / `space` | Toggle visible/hidden |
| type | Filter the list |
| `esc` | Close |

Hiding a skill sets `disable-model-invocation: true` in its `SKILL.md`. 
Showing a skill removes the line again. 
A hidden skill stays loadable explicitly via `/skill:<name>`.

## Example
