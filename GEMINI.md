# OpenHarness Session Context: Phase 9 Dashboard Dogfooding

## Current Project State (2026-03-28)
OpenHarness v2 is in the middle of a Phase 9 dogfooding run. The kernel is active, but several implementation tasks have reached a "ghost merge" state where the task store marks them as `merged` despite the source code (specifically the `dashboard/` directory) and handoff artifacts being missing from the main repository.

### Task Status Summary
- **Slices 1–6 (Scaffold to Summary Grid):** Mark as `merged` in the kernel but implementation is missing from the file system.
- **Slice 7 (Task Detail):** Escalated. The `task-detail-store.ts` and its tests were successfully written to `src/dashboard/` and `tests/phase9/`, but the task escalated due to a missing reviewer.
- **Slices 8–9 (Controls & Validation):** Escalated. Blocked by the missing dashboard scaffold.

## Technical Findings
- **Ghost Merge Cause:** Agents in Phase 9 reported "Worktree deleted during execution." They likely completed their internal logic but failed to commit or copy the files back to the root before the worktree was cleaned up or the process terminated.
- **Runtime Integrity:** The backend IPC contracts (`src/server/ipc-types.ts`) and the `RuntimeStateHub` are successfully updated. They support snapshots, deltas with sequence numbers, and `runHealth` (active/quiet) tracking.
- **Task Detail Store:** A functional, tested state management layer for the dashboard exists in `src/dashboard/task-detail-store.ts`. It handles `get-task`, `get-logs`, and output subscriptions.

## Critical Blockers
1. **Missing Dashboard Scaffold:** The `dashboard/` directory does not exist. The Vite/React foundation, build pipeline, and static serving path in `src/runtime.ts` are missing.
2. **Dead Code:** `src/server/http-server.ts` is currently dead code. It needs to be wired into `startKernelRuntime` (preferably using the "shared port" Option B from the reviewer spec).
3. **Escalated Reviews:** `phase9_review_task_detail` and `phase9_review_controls` need a finalized review artifact in `docs/phase9/reviews/` to allow the generator agents to resume.

## Instructions for Next Session
1. **Restore Scaffold:** Manually implement Slice 1 & 2 (Vite scaffold + bootstrap endpoint) in the root `dashboard/` folder.
2. **Wire HTTP Server:** Update `src/runtime.ts` to start the HTTP server on the same port as the `WsServer`.
3. **Resolve Escalations:** Act as the Reviewer to fill in the missing TDD criteria in `docs/phase9/reviews/task-detail.md` and `controls.md`.
4. **Validation:** Verify the dashboard can be served by running the kernel and visiting the localhost port.
