# lane-tracker

A Claude Code plugin for running one project with several Claude sessions at once: an **orchestrator** and its **lanes** (A, B, C, …). Each session of a project sees the whole team; sessions outside the project see nothing.

## What you get

- **Status line** in every session of the project: `Lanes ✓A ●B ◆C ○D`.
- **Lanes pane** (`/lanes`; opens by itself in the orchestrator):
  - one card per lane: its area (blue), what it works on now as bullets (yellow), its next job (green), and a mark for its state: ● in work, ◆ ready to merge, ✓ done, ✖ blocked, ○ idle, ⚑ waiting for you;
  - a lane's corner **moves**: it spins while that lane's session is running a turn, and its ⚑ pulses while it waits for you;
  - **Sessions**: each session's model, effort and context window use, as a bar that shimmers while the session works, gets a pulsing ring while it waits for you, and pulses red from 80%;
  - **↺ Handoff & restart**: the session writes a handoff file, clears itself, and is told to read it back (highlighted from 60% context);
  - **☾ Sleep all / ☀ Wake up**: every session finishes its step, commits to its own branch, saves a handoff and stops; Wake up has each one carry on from it;
  - **⚙ Lanes** (orchestrator): add, rename or reassign lanes.
  - **✖ Delete project** (orchestrator, after a yes): the team is forgotten in every session; the board file and handoffs stay on disk.
- **`/clear_context`** (any session): the session writes a handoff (`HANDOFF.md` in its folder, or its lane's handoff file in a project), clears itself, and the fresh session is told to read it and carry on.
- **`/lanes` outside a project** lists the projects with **＋ Join** (a new lane, or a lane waiting for a session) and **✖ Delete** next to each, and offers **＋ New project** (this session orchestrates: name, number of lanes, each lane's name and session).
  - The session picker lists only the sessions working in the project's folder (or a worktree beside it): open the lane sessions there first, or leave a lane on "None yet" and have that session join with `/lanes`.
  - A session that joins a project from another folder is moved to the project's folder (the app asks you first).
- **Session names**: each session is renamed after its role, `Orchestrator (Shop)` and `A · Backend (Shop)`, when the project is created, when it joins, and when ⚙ Lanes changes it.

The board is a plain text file of one line per lane, which the sessions keep current:

```
@lane A | Role | Feature / work item | Status | Next job | MM-DD
```

Status starts with Working, Ready to merge, Blocked, Done, Idle or Paused.

It sits next to the project folder (`<parent>/<project>-LANES.md`, handoffs in `<parent>/<project>-handoffs/`) so worktrees beside it share it. Where that folder takes no files, such as a drive root or `/home` for a project at your home folder, both go inside the project, in `.lanes/`.

## Install

In a terminal session of Claude Code:

```
/plugin install lane-tracker --marketplace Du1eks/lane-tracker
```

Answer `y` to add the marketplace and pick the user scope. From a local folder instead:

```
claude plugin marketplace add <path to this folder>
claude plugin install lane-tracker@du1eks-mods --scope user
```

## Limits

- Works in Claude Code sessions on your own computer (the desktop app's Code tab or a terminal), not in cloud sessions.
- Session details, context bars, reset, sleep and wake use the desktop app's session tools; in a plain terminal the pane shows the board only.
- The setup form needs text fields, so it runs in the desktop app or a terminal, not on mobile.
- Each install (Windows, WSL) keeps its own list of projects.

## Development

```
claude plugin validate .
claude plugin test .
```
