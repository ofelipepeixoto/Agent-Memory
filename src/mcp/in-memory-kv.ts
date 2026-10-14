// Modifications: fail-closed snapshots, atomic persistence and stale-writer detection.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

type Snapshot = Record<string, Record<string, unknown>>;

function readSnapshot(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Snapshot must be a regular file");
    return readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseSnapshot(raw: string | null): Snapshot {
  if (raw === null) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new Error("Invalid snapshot JSON; repair or restore before reopening");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid snapshot: expected scope object");
  }
  for (const entries of Object.values(value)) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error("Invalid snapshot: expected key/value scope");
    }
  }
  return value as Snapshot;
}

export class InMemoryKV {
  private store = new Map<string, Map<string, unknown>>();
  private baseline: string | null = null;
  private failed = false;

  constructor(private persistPath?: string) {
    if (persistPath) {
      this.baseline = readSnapshot(persistPath);
      for (const [scope, entries] of Object.entries(parseSnapshot(this.baseline))) {
        this.store.set(scope, new Map(Object.entries(entries)));
      }
    }
  }

  private requireHealthy(): void {
    if (this.failed) throw new Error("Persistence failed; reopen the store after recovery");
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    this.requireHealthy();
    return (this.store.get(scope)?.get(key) as T) ?? null;
  }

  async set<T = unknown>(scope: string, key: string, data: T): Promise<T> {
    this.requireHealthy();
    if (!this.store.has(scope)) this.store.set(scope, new Map());
    this.store.get(scope)!.set(key, data);
    return data;
  }

  async delete(scope: string, key: string): Promise<void> {
    this.requireHealthy();
    this.store.get(scope)?.delete(key);
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    this.requireHealthy();
    return Array.from(this.store.get(scope)?.values() ?? []) as T[];
  }

  persist(): void {
    this.requireHealthy();
    if (!this.persistPath) return;
    const path = this.persistPath;
    const lockPath = `${path}.lock`;
    const tempPath = `${path}.${randomUUID()}.tmp`;
    let lock: number | undefined;
    let temp: number | undefined;
    let tempCreated = false;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      lock = openSync(lockPath, "wx", 0o600);
      if (readSnapshot(path) !== this.baseline) {
        throw new Error("Snapshot changed since load; reopen before writing");
      }
      const data = Object.fromEntries(Array.from(this.store, ([scope, entries]) =>
        [scope, Object.fromEntries(entries)]));
      const raw = JSON.stringify(data);
      parseSnapshot(raw);
      temp = openSync(tempPath, "wx", 0o600);
      tempCreated = true;
      writeFileSync(temp, raw, "utf-8");
      fsyncSync(temp);
      closeSync(temp);
      temp = undefined;
      renameSync(tempPath, path);
      tempCreated = false;
      // Windows does not support opening directories for fsync via this API.
      if (process.platform !== "win32") {
        const dir = openSync(dirname(path), "r");
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      this.baseline = raw;
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      try {
        if (temp !== undefined) closeSync(temp);
        if (tempCreated) unlinkSync(tempPath);
      } catch (error) {
        this.failed = true;
        throw error;
      } finally {
        if (lock !== undefined) {
          try {
            closeSync(lock);
            unlinkSync(lockPath);
          } catch (error) {
            this.failed = true;
            throw error;
          }
        }
      }
    }
  }
}
