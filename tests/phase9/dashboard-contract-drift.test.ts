import { describe, expectTypeOf, it } from "vitest";
import type { Task as CoreTask, TaskPriority as CoreTaskPriority } from "../../src/types.js";
import type {
  ExplorationBudget as DashboardExplorationBudget,
  Task as DashboardTask,
  TaskPriority as DashboardTaskPriority,
} from "../../dashboard/src/types.js";

describe("Phase 9 dashboard contract drift", () => {
  it("keeps dashboard task priority aligned with the kernel task priority", () => {
    expectTypeOf<DashboardTaskPriority>().toEqualTypeOf<CoreTaskPriority>();
    expectTypeOf<DashboardTask["priority"]>().toEqualTypeOf<CoreTask["priority"]>();
  });

  it("keeps dashboard exploration budget aligned with the kernel task shape", () => {
    expectTypeOf<DashboardExplorationBudget>().toEqualTypeOf<CoreTask["exploration_budget"]>();
    expectTypeOf<DashboardTask["exploration_budget"]>().toEqualTypeOf<CoreTask["exploration_budget"]>();
  });
});
