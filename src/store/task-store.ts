import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import Database from "better-sqlite3";
import type { Task, TaskStatus, PreviousAttempt } from "../types.js";

/** Task IDs end up in file paths, git refs, and shell commands. Reject anything unsafe. */
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const VALID_PRIORITIES = new Set<string>(["high", "medium", "low"]);

interface TaskStoreOptions {
  tasksDir: string;
  dbPath: string;
}

interface ListTasksOptions {
  initializeMissingState?: boolean;
}

export class TaskStore {
  private readonly tasksDir: string;
  private readonly db: Database.Database;

  constructor(options: TaskStoreOptions) {
    this.tasksDir = options.tasksDir;
    this.db = new Database(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_state (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        current_attempt INTEGER NOT NULL DEFAULT 1,
        previous_attempts TEXT NOT NULL DEFAULT '[]',
        enqueued_at TEXT,
        assigned_at TEXT,
        completed_at TEXT,
        cooldown_until TEXT,
        crash_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Schema migrations for databases created before enqueued_at was added
    this.migrateSchema();
  }

  validateTaskId(id: string): void {
    if (!id || !SAFE_ID.test(id)) {
      throw new Error(`Invalid task ID: "${id}" — must match ${SAFE_ID}`);
    }
  }

  async list(options: ListTasksOptions = {}): Promise<Task[]> {
    let files: string[];
    try {
      files = await readdir(this.tasksDir);
    } catch {
      return [];
    }

    const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    const initializeMissingState = options.initializeMissingState ?? true;
    const tasks: Task[] = [];
    const seenTaskIds = new Map<string, string>();

    for (const file of yamlFiles) {
      try {
        const content = await readFile(join(this.tasksDir, file), "utf-8");
        const def = parse(content) as Record<string, unknown>;

        // Schema validation: fail-closed on malformed task definitions.
        // Task files are the executable workload — silently skipping one
        // creates hidden starvation. One bad YAML should fail startup.
        const validationError = this.validateTaskDefinition(def);
        if (validationError) {
          throw new Error(`Invalid task definition in ${file}: ${validationError}`);
        }

        const task = def as unknown as Task;
        this.validateTaskId(task.id);

        const existingFile = seenTaskIds.get(task.id);
        if (existingFile) {
          throw new Error(`Invalid task definition in ${file}: duplicate task ID "${task.id}" also defined in ${existingFile}`);
        }
        seenTaskIds.set(task.id, file);

        task.depends_on = task.depends_on ?? [];

        // Merge runtime state from SQLite
        const state = this.readState(task.id);
        if (state) {
          task.status = state.status as TaskStatus;
          task.current_attempt = state.current_attempt;
          task.previous_attempts = JSON.parse(state.previous_attempts);
          task.enqueued_at = state.enqueued_at ?? undefined;
          task.assigned_at = state.assigned_at ?? undefined;
          task.completed_at = state.completed_at ?? undefined;
          task.cooldown_until = state.cooldown_until ?? undefined;
          task.crash_count = state.crash_count;
        } else {
          task.status = (task.status as TaskStatus) ?? "pending";
          task.current_attempt = task.current_attempt ?? 1;
          task.previous_attempts = task.previous_attempts ?? [];
          task.enqueued_at = undefined;
          task.crash_count = 0;

          if (initializeMissingState) {
            task.enqueued_at = new Date().toISOString();
            this.initializeState(task.id, task.enqueued_at);
          }
        }

        tasks.push(task);
      } catch (err) {
        // Validation errors are fatal — fail-closed
        if (err instanceof Error && err.message.startsWith("Invalid task definition")) {
          throw err;
        }
        // YAML parse errors (corrupt file, not YAML at all) are also fatal
        throw new Error(`Failed to parse ${file}: ${err}`);
      }
    }

    return tasks;
  }

  async get(id: string): Promise<Task | null> {
    const tasks = await this.list();
    return tasks.find((t) => t.id === id) ?? null;
  }

  async createTask(task: Task): Promise<void> {
    this.validateTaskId(task.id);

    const filePath = join(this.tasksDir, `${task.id}.yaml`);
    const alreadyExists = await access(filePath)
      .then(() => true)
      .catch(() => false);
    if (alreadyExists || this.readState(task.id)) {
      throw new Error(`Task already exists: ${task.id}`);
    }

    const definition: Record<string, unknown> = {
      id: task.id,
      title: task.title,
      priority: task.priority,
      depends_on: task.depends_on,
      agent_prompt: task.agent_prompt,
      exploration_budget: task.exploration_budget,
      escalation_rules: task.escalation_rules,
    };

    // Only include optional fields when they have values — avoids `field: null` noise in YAML
    if (task.source_task_id) definition.source_task_id = task.source_task_id;
    if (task.evaluate !== undefined) definition.evaluate = task.evaluate;
    if (task.agent) definition.agent = task.agent;
    if (task.evaluator_agent) definition.evaluator_agent = task.evaluator_agent;
    if (task.success_criteria) definition.success_criteria = task.success_criteria;
    if (task.recurring !== undefined) definition.recurring = task.recurring;
    if (task.recurring_interval_hours !== undefined) definition.recurring_interval_hours = task.recurring_interval_hours;

    await writeFile(filePath, stringify(definition), "utf-8");

    const enqueuedAt = task.enqueued_at ?? new Date().toISOString();
    const status = task.status ?? "pending";
    const currentAttempt = task.current_attempt ?? 1;
    const previousAttempts = JSON.stringify(task.previous_attempts ?? []);
    const crashCount = task.crash_count ?? 0;

    this.db
      .prepare(
        `INSERT INTO task_state (id, status, current_attempt, previous_attempts, enqueued_at, assigned_at, completed_at, cooldown_until, crash_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        status,
        currentAttempt,
        previousAttempts,
        enqueuedAt,
        task.assigned_at ?? null,
        task.completed_at ?? null,
        task.cooldown_until ?? null,
        crashCount,
      );
  }

  async updateStatus(id: string, status: TaskStatus, metadata?: Record<string, unknown>): Promise<void> {
    this.validateTaskId(id);
    const existing = this.readState(id);

    const currentAttempt = existing?.current_attempt ?? 1;
    const previousAttempts = existing?.previous_attempts ?? "[]";
    const enqueuedAt = existing?.enqueued_at ?? new Date().toISOString();
    const assignedAt = status === "reserved"
      ? (typeof metadata?.assignedAt === "string" ? metadata.assignedAt : new Date().toISOString())
      : (existing?.assigned_at ?? null);
    const completedAt =
      status === "completed" || status === "merged"
        ? new Date().toISOString()
        : (existing?.completed_at ?? null);
    const cooldownUntil = existing?.cooldown_until ?? null;
    const crashCount = typeof metadata?.crashCount === "number"
      ? metadata.crashCount
      : (existing?.crash_count ?? 0);

    this.db
      .prepare(
        `INSERT INTO task_state (id, status, current_attempt, previous_attempts, enqueued_at, assigned_at, completed_at, cooldown_until, crash_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           enqueued_at = excluded.enqueued_at,
           assigned_at = excluded.assigned_at,
           completed_at = excluded.completed_at,
           crash_count = excluded.crash_count`,
      )
      .run(
        id,
        status,
        currentAttempt,
        previousAttempts,
        enqueuedAt,
        assignedAt,
        completedAt,
        cooldownUntil,
        crashCount,
      );
  }

  async recordAttempt(id: string, attempt: PreviousAttempt): Promise<void> {
    this.validateTaskId(id);
    const existing = this.readState(id);

    const prevAttempts: PreviousAttempt[] = existing ? JSON.parse(existing.previous_attempts) : [];
    prevAttempts.push(attempt);

    const nextAttempt = (existing?.current_attempt ?? 1) + 1;
    const enqueuedAt = existing?.enqueued_at ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO task_state (id, status, current_attempt, previous_attempts, enqueued_at, assigned_at, completed_at, cooldown_until, crash_count)
         VALUES (?, 'retry_pending', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = 'retry_pending',
           enqueued_at = excluded.enqueued_at,
           current_attempt = excluded.current_attempt,
           previous_attempts = excluded.previous_attempts`,
      )
      .run(
        id,
        nextAttempt,
        JSON.stringify(prevAttempts),
        enqueuedAt,
        existing?.assigned_at ?? null,
        existing?.completed_at ?? null,
        existing?.cooldown_until ?? null,
        existing?.crash_count ?? 0,
      );
  }

  close(): void {
    this.db.close();
  }

  private migrateSchema(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(task_state)")
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));
    const backfillTimestamp = new Date().toISOString();

    if (!columnNames.has("enqueued_at")) {
      this.db.exec("ALTER TABLE task_state ADD COLUMN enqueued_at TEXT");
    }

    // Backfill any legacy rows that still have a null enqueued_at.
    // Not perfectly accurate (they were seen earlier), but better than null,
    // which would silently disable starvation scoring for migrated tasks.
    this.db
      .prepare("UPDATE task_state SET enqueued_at = ? WHERE enqueued_at IS NULL")
      .run(backfillTimestamp);
  }

  private initializeState(id: string, enqueuedAt: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_state (id, status, current_attempt, previous_attempts, enqueued_at, crash_count)
         VALUES (?, 'pending', 1, '[]', ?, 0)`,
      )
      .run(id, enqueuedAt);
  }

  private readState(id: string): StateRow | undefined {
    return this.db.prepare("SELECT * FROM task_state WHERE id = ?").get(id) as StateRow | undefined;
  }

  private validateTaskDefinition(def: Record<string, unknown>): string | null {
    if (typeof def.id !== "string" || !SAFE_ID.test(def.id)) return "missing or invalid id";
    if (typeof def.title !== "string") return "missing title";
    if (typeof def.agent_prompt !== "string") return "missing agent_prompt";
    if (def.priority !== undefined && !VALID_PRIORITIES.has(def.priority as string))
      return `invalid priority "${def.priority}" (must be high, medium, or low)`;

    if (def.depends_on !== undefined) {
      if (!Array.isArray(def.depends_on)) return "depends_on must be an array of task IDs";
      if (def.depends_on.some((dep) => typeof dep !== "string" || !SAFE_ID.test(dep))) {
        return "depends_on must contain only valid task IDs";
      }
    }

    if (def.agent !== undefined && typeof def.agent !== "string") {
      return "agent must be a string when provided";
    }
    if (def.evaluator_agent !== undefined && typeof def.evaluator_agent !== "string") {
      return "evaluator_agent must be a string when provided";
    }
    if (def.source_task_id !== undefined) {
      if (typeof def.source_task_id !== "string" || !SAFE_ID.test(def.source_task_id)) {
        return "source_task_id must be a valid task ID when provided";
      }
    }
    if (def.evaluate !== undefined && typeof def.evaluate !== "boolean") {
      return "evaluate must be a boolean when provided";
    }
    if (def.success_criteria !== undefined) {
      if (!Array.isArray(def.success_criteria)) {
        return "success_criteria must be an array of strings when provided";
      }
      if (def.success_criteria.some((criterion) => typeof criterion !== "string")) {
        return "success_criteria must contain only strings";
      }
    }
    if (def.escalation_rules !== undefined) {
      if (!Array.isArray(def.escalation_rules)) {
        return "escalation_rules must be an array of strings when provided";
      }
      if (def.escalation_rules.some((rule) => typeof rule !== "string")) {
        return "escalation_rules must contain only strings";
      }
    }
    if (def.recurring_interval_hours !== undefined) {
      if (typeof def.recurring_interval_hours !== "number") {
        return "recurring_interval_hours must be a number when provided";
      }
      if (def.recurring_interval_hours < 0) {
        return "recurring_interval_hours must be >= 0";
      }
    }
    if (def.recurring !== undefined && typeof def.recurring !== "boolean") {
      return "recurring must be a boolean when provided";
    }

    const budget = def.exploration_budget as Record<string, unknown> | undefined;
    if (!budget) return "missing exploration_budget";
    if (typeof budget.max_attempts !== "number") return "missing exploration_budget.max_attempts";
    if (typeof budget.timeout_per_attempt !== "number") return "missing exploration_budget.timeout_per_attempt";
    if (typeof budget.total_timeout !== "number") return "missing exploration_budget.total_timeout";
    if (budget.max_attempts < 1) return "exploration_budget.max_attempts must be >= 1";
    if (budget.timeout_per_attempt <= 0) return "exploration_budget.timeout_per_attempt must be > 0";
    if (budget.total_timeout <= 0) return "exploration_budget.total_timeout must be > 0";
    if (budget.timeout_per_attempt > budget.total_timeout) {
      return "exploration_budget.timeout_per_attempt must be <= exploration_budget.total_timeout";
    }

    return null;
  }
}

interface StateRow {
  id: string;
  status: string;
  current_attempt: number;
  previous_attempts: string;
  enqueued_at: string | null;
  assigned_at: string | null;
  completed_at: string | null;
  cooldown_until: string | null;
  crash_count: number;
}
