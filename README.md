# Ralph Wiggum

Multi-session task runner with automatic parallelization for OpenCode AI.

Based on the [Ralph technique](https://ghuntley.com/ralph/) by Geoff Huntley.

## What It Does

Breaks down complex prompts into atomic tasks and executes them in parallel using fresh sessions. Each task runs in isolation with strict boundaries to prevent context pollution.

## Features

- Automatic task decomposition
- Parallel execution (independent tasks run simultaneously)
- Fresh sessions for context isolation
- Dependency management
- State persistence (save/resume)
- Two modes: Automatic and Orchestrated

## Usage

Copy `ralph-wiggum.ts` to your `~/.config/opencode/plugin/` directory.

### Automatic Mode

```
ralph_auto "Implement user authentication with JWT"
```

### Orchestrated Mode

1. `ralph_start "prompt"` - Initialize the loop
2. `ralph_add_tasks [{id, content, dependencies?}]` - Add tasks
3. `ralph_run` - Execute with automatic parallelization

### State Management

- `ralph_quit` - Save state and quit
- `ralph_resume` - Resume from saved state
- `ralph_status` - Check current progress

## License

AGPL-3.0
