import { canSpawnRecurringFixTask } from "./scheduler/scheduler.js";
import type { Task } from "./types.js";

interface HarvestStore {
  createTask(task: Task): Promise<void>;
}

interface HarvestRecurringFixTasksOptions {
  candidates: Task[];
  existingTasks: Task[];
  maxRecurringFixTasks: number;
  store: HarvestStore;
}

export async function harvestRecurringFixTasks(options: HarvestRecurringFixTasksOptions): Promise<Task[]> {
  const { candidates, existingTasks, maxRecurringFixTasks, store } = options;
  const knownTasks = [...existingTasks];
  const createdTasks: Task[] = [];

  for (const candidate of candidates) {
    if (!canSpawnRecurringFixTask(candidate, knownTasks, maxRecurringFixTasks)) {
      continue;
    }

    await store.createTask(candidate);
    createdTasks.push(candidate);
    knownTasks.push(candidate);
  }

  return createdTasks;
}