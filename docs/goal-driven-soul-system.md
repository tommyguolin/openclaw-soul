# Goal-Driven Soul System Design

## Purpose

Turn Soul from a signal-reactive assistant into a strict goal-driven system that can:

1. Keep a small set of explicit long-term goals as the top anchor.
2. Decompose those goals into measurable subgoals.
3. Detect concrete optimization opportunities from evidence.
4. Rank opportunities by alignment with the active goal tree.
5. Execute only the highest-value improvement.
6. Recompute goal progress after every meaningful action.
7. Report convergence or stalling instead of drifting indefinitely.

The key idea is simple:

> Soul should not ask "what looks interesting?"  
> Soul should ask "which action best advances the current goal tree, based on evidence?"

## Current Baseline

The codebase already has the ingredients for this:

- `Goal` objects in `ego.goals`
- goal metadata and summaries in `src/goal-system.ts`
- maintenance opportunity detection in `src/intelligent-thought.ts`
- task execution in `src/autonomous-actions.ts`
- prompt surface integration in `src/prompts.ts`
- task/behavior memory in `ego.behaviorLog`, `ego.activeTasks`, and `ego.mentalContext.maintenanceBacklog`

What is still missing is a strict control loop that treats the goal tree as the primary decision surface.

## Design Goals

### 1. Goals are explicit

Every important objective must exist as a named goal, not as a vague feeling.

Examples:

- Know the User
- Build Trust
- Self-Improve
- Project-specific goals created from user directives

### 2. Goals are measurable

Each goal must have at least:

- a target state
- one or more measurement criteria
- one or more child goals
- a last evaluated time
- a progress estimate based on evidence

### 3. Optimization is evidence-led

An optimization candidate is only useful if it can point to:

- behavior logs
- task outcomes
- task result files
- recent user feedback
- user facts or preferences

### 4. Alignment is explicit

Maintenance work must explain:

- which goal it serves
- why it serves that goal
- what evidence supports the choice
- what change is expected to improve progress

### 5. One iteration, then verify

Each maintenance run should do one small useful thing:

- inspect
- patch
- restart if needed
- verify
- record the result

No broad speculative refactors.

### 6. Convergence must be visible

Soul should be able to answer:

- what goal is currently primary
- what subgoal is most under-served
- whether the latest change improved progress
- whether the system is stuck and needs a different tactic

## Goal Model

`Goal` already carries the core fields needed for this design:

- `parentId`
- `childGoals`
- `goalFamily`
- `targetState`
- `measurementCriteria`
- `evaluationSummary`
- `lastEvaluatedAt`

These fields should be treated as the canonical goal contract.

### Goal families

The implementation should treat goals as one of four families:

- `knowledge`
- `trust`
- `improvement`
- `generic`

The family is inferred from title and description, but can also be persisted.

### Goal hierarchy

The runtime should support a shallow hierarchy:

- root goal
- active subgoals
- leaf maintenance targets

The hierarchy does not need to be fully recursive on day one. The important part is that every maintenance action can be traced to a goal path.

## Runtime Loop

### Step 1. Refresh goal state

Before maintenance or prompt assembly, Soul recomputes goal state from current evidence.

This refresh should update:

- progress
- target state
- measurement criteria
- child goals
- family
- evaluation summary
- evaluation timestamp

### Step 2. Select a primary goal

Soul should identify one goal as the primary focus for the current cycle.

Selection should prefer goals with:

- larger progress gaps
- stronger evidence of current relevance
- higher user importance
- current maintenance signals

### Step 3. Build a maintenance backlog

Maintenance discovery should scan for concrete signals such as:

- repeated failure modes
- stale or partial results
- blocked or failed autonomous tasks
- poor report fidelity
- missing verification
- goal mismatch
- over-conservative routing

Each candidate should include:

- domain
- objective
- next step
- evidence snippets
- aligned goals
- score
- preferred action

### Step 4. Rank candidates

Rank by:

- evidence strength
- recency
- frequency
- directness of goal alignment
- fixability within one iteration

Only the top candidate, or at most top two, should be executed.

### Step 5. Execute with capability-aware routing

The system must prefer the strongest available execution path:

- use `subagent-improve` when a subagent runtime is available
- fall back to `observe-and-improve` only when the subagent runtime is unavailable

Do not downgrade the route unless capability really is missing.

### Step 6. Verify and record

After a code or behavior change:

- restart the Gateway if the change needs a restart
- rebuild the project
- run the smallest relevant verification command
- store the result in the task report

### Step 7. Recompute progress

After verification:

- recompute goal progress
- update the backlog
- update the goal evaluation summary
- surface the result in prompt context

## Candidate Scoring

Each candidate should be scored with four dimensions:

- `frequency`: how often this issue appears
- `impact`: how much it hurts the goal tree
- `fixability`: whether a small change can improve it now
- `confidence`: how solid the evidence is

The combined score should bias toward:

- concrete failures over vague discomfort
- verified signals over speculative guesses
- goal-aligned issues over locally interesting ones

## Goal Decomposition Rules

### Know the User

Subgoals:

- identify the user's current projects
- capture stable preferences and habits
- keep factual memory current and accurate

Signals:

- repeated confirmation of stable facts
- project mentions
- preference updates

### Build Trust

Subgoals:

- return complete and verified outcomes
- avoid false claims and unsupported completion
- recover cleanly from failure

Signals:

- completed vs failed task ratio
- verification success
- positive feedback
- fewer partial or blocked outcomes

### Self-Improve

Subgoals:

- find the real bottleneck
- patch the smallest high-value issue
- restart and verify the code path
- avoid truncated or misleading reports

Signals:

- successful maintenance runs
- verified code changes
- full report capture
- reduced recurrence of the same failure mode

## Reporting Contract

Every maintenance task should produce a report with these fields:

- `Outcome`
- `Changes`
- `Verification`
- `Metrics`
- `Next`

If a task fails or only partially completes, the report must still say why and what was observed.

## Convergence Report

Soul should periodically produce a convergence summary that answers:

- which goal is primary
- which goals are stalled
- which measurements improved
- which issue types repeat most often
- which next action best advances the tree

This report is important because it prevents "busy but aimless" behavior.

## Implementation Phases

### Phase 1: Goal visibility

- Refresh goal state on every maintenance cycle.
- Show goal tree summaries in prompt context.
- Make the primary goal explicit.

### Phase 2: Goal-aware maintenance ranking

- Attach goal paths to maintenance candidates.
- Rank candidates by alignment and evidence.
- Execute only the top candidate or top two.

### Phase 3: Convergence tracking

- Emit a convergence report after maintenance.
- Track whether goal progress actually moves.
- Detect repeat failures and route them to a different tactic.

### Phase 4: Persistent learning

- Persist goal evaluation history.
- Learn which maintenance actions produce real progress.
- Promote effective patterns and demote noisy ones.

## Acceptance Criteria

The design is good enough when:

- active goals always have a measurable target state
- maintenance work names the goal it is serving
- optimization candidates can be traced to evidence
- execution uses the best available capability path
- code changes are followed by restart and verification
- goal progress can be recomputed after each maintenance pass
- the system can explain why a maintenance action was chosen

## Non-Goals

This design does not try to:

- predict the user's life perfectly
- solve open-ended strategic planning without human input
- eliminate all ambiguity from goal selection

The goal is strictness and convergence, not omniscience.

