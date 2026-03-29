/**
 * Dependency graph validation.
 *
 * Pure functions — no I/O, no state. Used by startup preflight (Phase 1)
 * and scheduler (Phase 2). Detects cycles and missing dependencies before
 * scheduling begins.
 */

export interface DepNode {
  id: string;
  depends_on: string[];
}

export interface ValidationResult {
  valid: boolean;
  cycles?: string[][];
  missingDeps?: string[];
}

/**
 * Validate a dependency graph for cycles and missing references.
 *
 * Uses DFS-based cycle detection (Kahn's algorithm alternative).
 * Returns all cycles found and all missing dependency references.
 */
export function validateDependencyGraph(tasks: DepNode[]): ValidationResult {
  const ids = new Set(tasks.map((t) => t.id));
  const missingDeps: string[] = [];
  const cycles: string[][] = [];

  // Check for missing dependencies
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) {
        missingDeps.push(dep);
      }
    }
  }

  // DFS cycle detection
  const adjList = new Map<string, string[]>();
  for (const task of tasks) {
    adjList.set(task.id, task.depends_on.filter((d) => ids.has(d)));
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      // Found a cycle — extract just the cycle portion
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart).concat(node));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of adjList.get(node) ?? []) {
      dfs(dep, path);
    }

    path.pop();
    inStack.delete(node);
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      dfs(task.id, []);
    }
  }

  const valid = cycles.length === 0 && missingDeps.length === 0;

  return {
    valid,
    ...(cycles.length > 0 ? { cycles } : {}),
    ...(missingDeps.length > 0 ? { missingDeps } : {}),
  };
}
