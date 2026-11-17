# Agents

Four helper agents, each with a "This project" section holding Study Sprint's rules (sw.js hash, no helper text, mobile-first, both styles, test commands, safety).

| Agent | Model | Used for |
|---|---|---|
| Code Reviewer | Opus | Review before every merge |
| Accessibility Auditor | Opus | WCAG 2.2 AA checks in both styles, phone and computer |
| Minimal Change Engineer | Sonnet | Writing the code for a planned work package |
| Test Automation Engineer | Sonnet | Writing and fixing unit and browser tests |

Planning uses the built-in Plan agent on Opus.

Adapted from [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (MIT licence, see LICENSE-agency-agents). The other twelve imported agents were removed in November 2026 because they were generic (React, editor plugins, playful copy) and didn't know this project's rules.
