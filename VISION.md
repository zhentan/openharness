# OpenHarness: Vision

## The Shift

Today, the bottleneck in agent-driven development is not just the model. It is everything around the model: context management, task coordination, failure recovery, merge discipline, evaluation. Right now, a better harness with an average model can outperform a frontier model with a bad harness.

That is the present-tense reality. Richard Sutton's "The Bitter Lesson" adds the longer-term correction: what makes a harness good is not permanent.

Across AI, the same pattern repeats. Human-engineered cleverness works for a while, then more general methods leveraging scale absorb it. In our domain, chain of thought used to be a prompting technique engineered into the harness. Now models do it natively. Tool use was orchestration-layer scaffolding. Now it is a model capability. Planning was multi-step prompt chains. Now models plan internally.

So the point is not that the harness stops mattering. The point is that the *kind* of harness value changes over time.

The harness capabilities that matter most today - scheduling heuristics, failure taxonomies, workflow sequencing, decomposition strategies - are likely to be absorbed into the models over time. The harness capabilities that endure are the ones models cannot provide for themselves: durable state, evidence, resource boundaries, trust verification, and coordination protocols.

**Both things are true at once.** The harness matters enormously right now. And the cleverest parts of the harness are still perishable.

The design consequence: **treat intelligence as perishable, infrastructure as compounding.** Build the scheduling logic and failure classification that agents need today, but invest most deeply in the evidence, boundaries, persistence, and protocols that agents will still need when they are much smarter than they are now.

OpenHarness is built around that distinction.

## The OS Analogy - Substrate, Not Brain

A modern operating system is the right mental model, but only if we use it correctly.

The weak interpretation: the kernel is the brain, the kernel decides everything, agents are dumb workers. That interpretation ages badly as models improve.

The strong interpretation: **the kernel provides substrate.** It owns durable truth, enforces boundaries, records evidence, and provides stable protocols. Increasingly capable agents coordinate on top of that substrate.

Linux did not become obsolete when deep learning arrived. It became the platform deep learning runs on. The kernel did not need to be smart. It needed to be reliable infrastructure that stayed out of the way.

| OS Concept | Agent Equivalent | Why It Is Infrastructure |
|---|---|---|
| Kernel | OpenHarness | Substrate, not decision-maker |
| /proc | Runtime introspection | Truth surface - models decide what to do with it |
| Filesystem | Repository + state store | Persistence that survives context windows |
| cgroups | Resource accounting | External enforcement of budgets |
| Capabilities | Permission model | Boundaries, not intelligence |
| Syscalls | Agent-to-kernel services | Stable protocols |
| Signals | Control primitives | Coordination interface |
| Device drivers | Adapters | Pluggable, not hardcoded |

We study kernel engineering patterns and port the design ideas that provide durable infrastructure - not the ones that encode temporary human cleverness.

## What We Are Building

OpenHarness is infrastructure for autonomous AI agents operating under real constraints. It provides what agents need but cannot provide for themselves:

- **Evidence and auditability.** No matter how capable agents become, regulated environments need verifiable records. The kernel produces these as a side effect of normal operation.
- **Resource boundaries.** Smarter agents still operate under real budgets: token cost, runtime capacity, human review attention. External enforcement avoids the conflict of interest in self-policing.
- **Durable state.** Agents are context-window bounded. They need substrate-level persistence for task state, run history, review artifacts, and dependency tracking.
- **Trust verification.** No system evaluates itself. Cross-model adversarial review is not a scaling problem - it is an epistemological one.
- **Coordination protocols.** Even self-organizing agents need shared interfaces to request services, exchange state, and report outcomes.

What the kernel does NOT try to be: the ultimate scheduler, the smartest failure classifier, or the best decomposition engine. Those capabilities will improve inside the models faster than they will improve as handcrafted kernel logic. The kernel provides the ground truth and boundaries within which models do increasingly sophisticated work.

## Why An OS, Not A Board

Most agent orchestration tools treat the problem as project management: a task board with lanes, agents as workers, humans as reviewers.

That works for a solo developer with 2-3 agents. It breaks under sustained concurrency.

When you run 50+ agents across a complex codebase with dependencies between their work, merge conflicts, shared resources, regulatory constraints, and multiple failure modes, you need infrastructure, not just a board.

A board may still be a useful surface. It is just not enough as the underlying control model once concurrency, regulation, and recovery start to matter.

Specifically, you need:

- **Real introspection**, not colored status cards. A canonical truth surface for every runtime object - what is running, what is blocked, what evidence exists, what approvals are missing.
- **Real isolation**, not separate task cards. Kernel-enforced boundaries around what a given run is allowed to access or modify.
- **Real resource accounting**, not WIP limits. Token budgets, cost ceilings, human attention backlog - dynamic admission based on actual resource consumption.
- **Real evidence generation**, not post-hoc log scraping. Structured audit records produced automatically for every accepted change.
- **Real failure recovery**, not "retry" and "failed." Crash-safe state preservation, orphan detection, signal-aware reconciliation.

## The Target: Small Teams, Large Products

The vision is not "make individual developers faster." Individual developers already have good tools.

The vision is: **a small team of humans, leveraging a large fleet of AI agents, building and operating a product with the complexity of a major financial platform.**

A product like that has hundreds of services, multiple regulatory domains (securities, futures, banking, crypto), strict compliance requirements, security-critical code paths, real-time systems, and massive reporting obligations. Today, building that usually requires hundreds of engineers. The economics of agent-driven development could change that, if the infrastructure is good enough.

"Good enough" in this context means more than throughput. It means:

- **Throughput** - meaningful concurrency on one node first, then 50-500+ agents as the control plane evolves
- **Control** - capability-mediated execution, kernel-enforced policy boundaries, graduated trust
- **Auditability** - every agent action produces the evidence that regulators, auditors, and the team itself needs to operate safely

For a regulated product, an agent action is not only an engineering event. It may also be a change-control event, an access-control event, a review-and-approval event, a vendor-usage event, and a record-retention event. The kernel must produce evidence for all of them automatically, as a side effect of normal operation.

## Design Principles

**1. Infrastructure over intelligence.** Build what stays valuable as models improve. Evidence, boundaries, persistence, protocols, and accounting are infrastructure. Scheduling heuristics, failure taxonomies, and decomposition strategies are intelligence that models will absorb. Invest accordingly.

**2. Humans steer, agents execute.** Humans set architecture, make product decisions, establish taste, interpret regulations, and approve critical changes. Agents implement, refactor, test, fix, maintain, and review each other's work.

**3. No model judges its own work.** Every output is reviewed by a different model. This is not optional. Cross-model adversarial review catches what self-evaluation reliably misses.

**4. Fail closed.** When in doubt, escalate. Evaluator crash? Block the merge. Unknown exit code? Don't retry blindly. Conflicting signals? Escalate to human. The cost of a false negative is always higher than the cost of a false positive.

**5. The kernel owns the truth.** Runtime state, task status, evidence records, approval chains - all owned by the kernel, not reconstructed from logs or inferred from file system state. Dashboard and CLI consume kernel truth; they don't create it.

**6. Policy separates from mechanism.** The scheduler dispatches tasks (mechanism). What gets dispatched, with what capabilities, requiring what approvals: that is policy. Different organizations, teams, or regulatory domains can have different policies over the same kernel.

**7. Continuous garbage collection.** Technical debt, stale state, and dead coordination artifacts should not compound. Agents and runtime maintenance loops should keep the system clean continuously rather than relying on periodic painful resets.

**8. Progressive disclosure.** Agents don't need the full codebase upfront. Load context in layers: project identity first, then task-specific references, then on-demand deep reads. Context budget management is memory management.

## The Economic Argument

Traditional scaling means hiring more engineers. Marginal productivity drops sharply due to coordination costs.

Agent-driven scaling means humans become architects and reviewers while agents handle the mechanical work. One human can guide many agents through code review, architecture decisions, and task specification.

The math only works if the infrastructure is good. Bad infrastructure means agents loop on the same bug, miss context, corrupt state, produce unreviewed code, and waste tokens. Good infrastructure means agents are faster, cheaper, and more consistent than humans at repetitive implementation work - while humans retain judgment, taste, and accountability.

The infrastructure is the leverage point. The models are the workers.

## Trajectory

The endgame is a team of 5-10 humans, armed with the right infrastructure, building and operating a product that today requires hundreds of engineers. Not because AI replaces engineers, but because it changes what "engineering" means. Humans do less typing and more thinking. Less implementing and more deciding. Less reviewing diffs and more setting direction.

### v2: Prove the patterns (current)

A single-node TypeScript kernel that processes task backlogs by spawning AI agents in isolated git worktrees. The architecture was validated through 11 rounds of cross-model adversarial review and proven through real agent execution.

v2 establishes:
- Task lifecycle with 12 states and 18 transition reasons
- 4 failure modalities with classified recovery paths
- Cross-model adversarial evaluation
- Serial dependency-aware merge queue
- SQLite-backed runtime state
- WebSocket observability with batched summaries
- CLI control surface
- Detached worktree isolation

v2 is a single-node kernel proving that the core infrastructure model works in practice.

### v3: Regulated single-node kernel

v3 adds the infrastructure primitives needed for regulated, high-complexity environments - emphasizing what stays valuable as models improve:

- **Introspection layer** - `/proc`-like canonical truth surface for every runtime object
- **Syscall boundary** - agents explicitly request kernel services through a formal interface (likely MCP-backed)
- **Capability model** - fine-grained permissions enforced by the kernel before dispatch
- **Evidence generation** - every accepted change produces structured audit evidence
- **Resource accounting** - token budgets, cost attribution, human attention tracking
- **Policy-as-code** - kernel-enforced rules for adapters, capabilities, and approval chains
- **Durable state** - review chains, approval records, and policy decisions as first-class runtime objects

v3 is the single-node kernel made trustworthy enough for regulated organizations. As models improve, the kernel provides better truth and stronger boundaries - not smarter decisions.

### v4: Distributed control plane

v4 extends the substrate across multiple nodes, not by making the distributed scheduler maximally clever, but by making the infrastructure available at scale:

- Distributed state (beyond single-node SQLite)
- Multi-node scheduling with agent placement
- Partitioned merge lanes (per-service, parallel)
- Federation across repos and org boundaries
- Cluster-level quotas and admission control
- Hierarchical resource accounting across teams

If self-organizing agent collaboration improves dramatically, a strong substrate compounds in value. A brittle central planner does not.

v4 should only happen after the single-node abstractions are proven under real load in v3. Distribution is a scaling step, not a substitute for sound kernel semantics.

## Inspiration

**[Richard Sutton's "The Bitter Lesson"](http://www.incompleteideas.net/IncIdeas/BitterLesson.html)** - the foundational insight that general methods leveraging computation outperform hand-engineered cleverness. Applied to OpenHarness: build infrastructure that stays valuable as models improve, not kernel intelligence that models will absorb.

**[OpenAI's "Harness Engineering"](https://openai.com/index/harness-engineering/)** - their finding that the orchestration layer matters more than the model, and the patterns they discovered (progressive disclosure, repo as system of record, mechanical enforcement, continuous garbage collection), directly shaped our architecture.

**[Anthropic's "Harness Design for Long-Running Application Development"](https://www.anthropic.com/engineering/harness-design-long-running-apps)** - validated file-based agent handoffs, context resets per attempt, and inspired our evaluator module. Key finding: agents exhibit self-evaluation bias. Separating generation from evaluation dramatically improves output quality.

**[Peter Steinberger's OpenClaw](https://steipete.me/posts/2026/openclaw)** - demonstrated that a single developer with the right abstractions can build infrastructure used by hundreds of thousands, and that MIT licensing creates trust and adoption velocity that no alternative can match.

The OS metaphor is our architectural framework. The Bitter Lesson is the strategic foundation it rests on.

## License

[MIT](LICENSE)
