# OpenHarness

**The open-source operating system for AI agents.**

Model is the CPU. Context window is RAM. OpenHarness is the kernel.

---

## What Is This

OpenHarness is a project-agnostic orchestration framework for autonomous AI agents. It provides the primitives that make agents productive at scale: task scheduling, agent lifecycle, failure classification, escalation boundaries, and garbage collection.

If 2025 was the year AI agents proved they could write code, 2026 is the year we learned the agent isn't the hard part - the harness is. OpenHarness is that harness, designed to be open, extensible, and reusable across any codebase.

## Why This Exists

In February 2026, OpenAI published ["Harness Engineering"](https://openai.com/index/harness-engineering/). A team of 3-7 engineers shipped a production product containing roughly one million lines of code - with zero manually written source code. Every line was written by agents. Humans steered. Agents executed.

The critical finding was not about the model. It was about everything around the model:

> "Early progress was slower than we expected, not because Codex was incapable, but because the environment was underspecified."

The bottleneck was the **harness** - the orchestration layer that manages context, enforces structure, coordinates execution, and provides feedback. A better harness with an average model outperforms a frontier model with a bad harness.

OpenHarness is our attempt to build that layer as open infrastructure - like Linux for agent orchestration.

## The OS Analogy

| OS Concept | Agent Equivalent | What It Does |
|---|---|---|
| **CPU** | The LLM (Claude, GPT, etc.) | Reasoning engine. Brilliant but amnestic. |
| **RAM** | Context window | Working memory. Scarce. |
| **Kernel** | OpenHarness | Orchestrates processes, enforces boundaries, manages resources. |
| **Processes** | Agent instances | Units of work. Spawn, run, monitor, recover, terminate. |
| **Scheduler** | Task scheduler | What to run next, in what order, how to parallelize. |
| **Filesystem** | Repository | Persistent storage. The repo is the system of record. |
| **Permissions** | Escalation framework | What agents can do autonomously vs. what requires human approval. |
| **Device drivers** | Adapters | Agent-agnostic. Plug in Claude, GPT, Codex, or custom. |

## What It Does

| Component | What |
|-----------|------|
| **Task Scheduler** | Priority + dependency ordering, age-based starvation prevention, cooldown backoff |
| **Supervisor** | 12-state machine, non-blocking spawn, drain-and-pause, total timeout enforcement |
| **Failure Classification** | 4 modalities: transient (retry with backoff), code rejection (revise with feedback), fatal environmental (escalate immediately), budget exhaustion |
| **Adapters** | Claude Code, GitHub Copilot, OpenAI Codex - shared process-adapter base with PGID management, timeout, output normalization |
| **Adversarial Evaluation** | Cross-model review: Claude generates, GPT/Codex evaluates. Neither model judges its own work. |
| **Merge Queue** | Serial, one per tick. Tests run post-merge; failures auto-revert. |
| **Worktree Isolation** | Detached HEAD per task. Restricted symlinks (node_modules only). Signal file cleanup. |
| **Runtime State** | SQLite WAL for task state. YAML files are read-only definitions. |
| **Crash Recovery** | Kill-and-retry orphan recovery, poison pill detection, signal-aware startup reconciliation |
| **WebSocket Server** | Runtime state hub with batched summaries, live output streaming, snapshot-on-subscribe, token auth |
| **CLI** | start, stop, restart, status, watch, pause, resume, help |

**Task Lifecycle:**
```
pending → reserved → pre_eval → generator_running → evaluator_running → completed → merge_pending → merged
```

**295 tests**, 29 source files, 55 test files. Architecture validated through 11 rounds of cross-model adversarial review (GPT-5.4, Gemini 3.1 Pro).

## Quick Start

```bash
git clone https://github.com/zhentan/openharness.git
cd openharness
npm install
npm run kernel:start
```

Create a task YAML in `tasks/`:

```yaml
id: t_example
title: Build the login page
priority: high
depends_on: []
agent: claude-code
evaluator_agent: codex
agent_prompt: |
  Build a login page with email and password fields.
  Write tests. Commit when done.
exploration_budget:
  max_attempts: 3
  timeout_per_attempt: 15
  total_timeout: 45
escalation_rules:
  - new_dependency
  - schema_change
```

The kernel picks it up, spawns an agent in an isolated worktree, evaluates the result with a different model, and merges passing work.

Other commands:

```bash
npm run kernel:status    # Task counts and status table
npm run kernel:watch     # Live task stream
npm run kernel:stop      # Graceful shutdown
npm run kernel:restart   # Stop + start
```

## Task Pack Warning

Task YAMLs in `tasks/` are executable workload, not passive planning files. If you start the kernel while tasks are present, OpenHarness will dispatch them according to normal scheduler rules.

## Trusted Host Environment

OpenHarness runs agents as native host subprocesses. It assumes a trusted host environment and should not be used defensively against untrusted code or prompts. Sandboxed execution is a future consideration.

See [VISION.md](VISION.md) for the full philosophy, design principles, inspiration, and trajectory (v2 → v3 → v4).

## License

[MIT](LICENSE)
