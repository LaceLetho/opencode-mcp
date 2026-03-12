/**
 * Async task manager with webhook callback support for OpenClaw.
 *
 * This module manages fire-and-forget tasks and sends webhook callbacks
 * to OpenClaw when tasks complete.
 */

import { OpenCodeClient } from "./client.js";

export interface AsyncTask {
  id: string;
  sessionId: string;
  prompt: string;
  callbackUrl: string;
  status: "running" | "completed" | "failed" | "timeout";
  directory?: string;
  createdAt: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
  providerID?: string;
  modelID?: string;
}

interface TaskManagerConfig {
  pollIntervalMs?: number;
  defaultTimeoutMs?: number;
}

class AsyncTaskManager {
  private tasks = new Map<string, AsyncTask>();
  private client: OpenCodeClient;
  private config: Required<TaskManagerConfig>;
  private runningPolls = new Set<string>();

  constructor(client: OpenCodeClient, config: TaskManagerConfig = {}) {
    this.client = client;
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 5000,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 600000, // 10 minutes
    };
  }

  /**
   * Register a new async task and start monitoring it.
   */
  async registerTask(
    taskId: string,
    sessionId: string,
    prompt: string,
    callbackUrl: string,
    directory?: string,
    providerID?: string,
    modelID?: string,
  ): Promise<AsyncTask> {
    const task: AsyncTask = {
      id: taskId,
      sessionId,
      prompt,
      callbackUrl,
      status: "running",
      directory,
      createdAt: new Date(),
      providerID,
      modelID,
    };

    this.tasks.set(taskId, task);

    // Start monitoring in background
    void this.monitorTask(taskId);

    return task;
  }

  /**
   * Get task by ID.
   */
  getTask(taskId: string): AsyncTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): AsyncTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks by status.
   */
  getTasksByStatus(status: AsyncTask["status"]): AsyncTask[] {
    return this.getAllTasks().filter((t) => t.status === status);
  }

  /**
   * Monitor a task until completion and send webhook callback.
   */
  private async monitorTask(taskId: string): Promise<void> {
    if (this.runningPolls.has(taskId)) return;
    this.runningPolls.add(taskId);

    const task = this.tasks.get(taskId);
    if (!task) {
      this.runningPolls.delete(taskId);
      return;
    }

    try {
      const timeout = this.config.defaultTimeoutMs;
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        await this.sleep(this.config.pollIntervalMs);

        try {
          // Check session status
          const statuses = (await this.client.get(
            "/session/status",
            undefined,
            task.directory,
          )) as Record<string, unknown>;

          const status = this.resolveSessionStatus(statuses[task.sessionId]);

          if (status === "idle" || status === "completed") {
            task.status = "completed";
            task.completedAt = new Date();

            // Get final result
            try {
              const messages = (await this.client.get(
                `/session/${task.sessionId}/message`,
                { limit: "1" },
                task.directory,
              )) as unknown[];

              if (messages && messages.length > 0) {
                const lastMsg = messages[messages.length - 1] as Record<string, unknown>;
                task.result = this.extractMessageContent(lastMsg);
              }
            } catch (e) {
              console.error(`[AsyncTaskManager] Failed to get result for task ${taskId}:`, e);
            }

            await this.sendCallback(task);
            break;
          }

          if (status === "error") {
            task.status = "failed";
            task.completedAt = new Date();
            task.error = "Session ended with error status";
            await this.sendCallback(task);
            break;
          }
        } catch (e) {
          console.error(`[AsyncTaskManager] Error polling task ${taskId}:`, e);
        }
      }

      // Timeout reached
      if (task.status === "running") {
        task.status = "timeout";
        task.completedAt = new Date();
        task.error = `Task timed out after ${timeout}ms`;
        await this.sendCallback(task);
      }
    } finally {
      this.runningPolls.delete(taskId);
    }
  }

  private async sendCallback(task: AsyncTask): Promise<void> {
    try {
      const isOpenClawHook = task.callbackUrl.includes("/hooks/agent");
      const payload = isOpenClawHook
        ? this.buildOpenClawPayload(task)
        : this.buildGenericPayload(task);

      const response = await fetch(task.callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "opencode-mcp/1.10.0",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(
          `[AsyncTaskManager] Callback failed for task ${task.id}: ${response.status} ${response.statusText}`,
        );
      } else {
        console.error(`[AsyncTaskManager] Callback sent for task ${task.id} (${task.status})`);
      }
    } catch (e) {
      console.error(`[AsyncTaskManager] Failed to send callback for task ${task.id}:`, e);
    }
  }

  private buildOpenClawPayload(task: AsyncTask): Record<string, unknown> {
    const statusEmoji = task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : "⏱️";
    const resultText = task.result || task.error || "No result";
    const message = `${statusEmoji} Task ${task.id} ${task.status}

Prompt: ${task.prompt}

Result:
${resultText}`;

    return {
      message,
      name: "OpenCode Async Task",
      agentId: "main",
      wakeMode: "now",
      deliver: true,
      channel: "last",
      model: task.modelID,
      timeoutSeconds: 300,
    };
  }

  private buildGenericPayload(task: AsyncTask): Record<string, unknown> {
    return {
      taskId: task.id,
      sessionId: task.sessionId,
      status: task.status,
      result: task.result,
      error: task.error,
      prompt: task.prompt,
      providerID: task.providerID,
      modelID: task.modelID,
      directory: task.directory,
      createdAt: task.createdAt.toISOString(),
      completedAt: task.completedAt?.toISOString(),
    };
  }

  /**
   * Extract readable content from a message.
   */
  private extractMessageContent(msg: Record<string, unknown>): string {
    if (typeof msg.content === "string") return msg.content;

    const parts = msg.parts as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(parts)) {
      const textParts = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text);
      if (textParts.length > 0) return textParts.join("\n");
    }

    const info = msg.info as Record<string, unknown> | undefined;
    if (info?.content) return String(info.content);

    return JSON.stringify(msg);
  }

  /**
   * Resolve session status from various formats.
   */
  private resolveSessionStatus(status: unknown): string {
    if (!status) return "unknown";
    if (typeof status === "string") return status;
    if (typeof status === "object" && status !== null) {
      const s = status as Record<string, unknown>;
      return (s.status as string) ?? "unknown";
    }
    return "unknown";
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance
let taskManagerInstance: AsyncTaskManager | null = null;

export function initTaskManager(client: OpenCodeClient, config?: TaskManagerConfig): AsyncTaskManager {
  taskManagerInstance = new AsyncTaskManager(client, config);
  return taskManagerInstance;
}

export function getTaskManager(): AsyncTaskManager | null {
  return taskManagerInstance;
}

export { AsyncTaskManager };
