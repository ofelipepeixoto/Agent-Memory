import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";

const dirs: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentmemory-durable-"));
  dirs.push(dir);
  return join(dir, "state.json");
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("durable standalone KV", () => {
  it.each(["{invalid", "null", "[]", '{"scope":null}', '{"scope":[]}'])('rejects invalid state %s without replacing it', (raw) => {
    const path = fixture(); writeFileSync(path, raw);
    expect(() => new InMemoryKV(path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(raw);
  });
  it("persists, restores and deletes with restrictive permissions", async () => {
    const path = fixture(); const kv = new InMemoryKV(path);
    await kv.set("scope", "id", { text: "synthetic" }); kv.persist();
    const reopened = new InMemoryKV(path);
    expect(await reopened.get("scope", "id")).toEqual({ text: "synthetic" });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    await reopened.delete("scope", "id"); reopened.persist();
    expect(await new InMemoryKV(path).list("scope")).toEqual([]);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
  it("rejects stale writers instead of losing a committed update", async () => {
    const path = fixture(); const a = new InMemoryKV(path); const b = new InMemoryKV(path);
    await a.set("scope", "a", "first"); await b.set("scope", "b", "second");
    a.persist(); expect(() => b.persist()).toThrow("changed since load");
    await expect(b.list("scope")).rejects.toThrow("reopen");
    expect(await new InMemoryKV(path).list("scope")).toEqual(["first"]);
  });
  it("propagates lock contention, keeps the owner's lock and denies further reads", async () => {
    const path = fixture(); const kv = new InMemoryKV(path); await kv.set("scope", "x", "synthetic");
    writeFileSync(`${path}.lock`, "fixture-owner");
    expect(() => kv.persist()).toThrow();
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("fixture-owner");
    await expect(kv.get("scope", "x")).rejects.toThrow("reopen");
  });
  it("propagates serialization errors without replacing the snapshot", async () => {
    const path = fixture(); const kv = new InMemoryKV(path); await kv.set("scope", "x", "old"); kv.persist();
    const old = readFileSync(path,"utf8"); await kv.set("scope", "bad", 1n);
    expect(() => kv.persist()).toThrow(); expect(readFileSync(path,"utf8")).toBe(old);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
  it("propagates rename failure and preserves the previous snapshot", async () => {
    const path = fixture(); const kv = new InMemoryKV(path); await kv.set("scope", "x", "old"); kv.persist();
    const module = new URL('../src/mcp/in-memory-kv.ts', import.meta.url).href;
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      fs.renameSync = () => { throw Object.assign(new Error('injected EIO'),{code:'EIO'}); }; syncBuiltinESMExports();
      const {InMemoryKV} = await import(${JSON.stringify(module)});
      const kv = new InMemoryKV(process.argv[1]); await kv.set('scope','x','new');
      try { kv.persist(); process.exit(9); } catch (e) { if(e.code !== 'EIO') throw e; }
      try { await kv.list('scope'); process.exit(8); } catch {}`;
    const result = spawnSync(process.execPath, ['--import','tsx', '--input-type=module','-e',script,path], {timeout:10000,env:{PATH:process.env.PATH}});
    expect(result.status, result.stderr?.toString()).toBe(0);
    expect(await new InMemoryKV(path).get('scope','x')).toBe('old');
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
  it("permits only one of two processes loaded from the same snapshot to commit", async () => {
    const path = fixture();
    const module = new URL('../src/mcp/in-memory-kv.ts', import.meta.url).href;
    const script = `const {InMemoryKV} = await import(${JSON.stringify(module)});
      const kv = new InMemoryKV(process.argv[1]); await kv.set('scope',String(process.pid),'synthetic');
      process.on('message', () => { try { kv.persist(); process.send('committed'); } catch { process.send('rejected'); } process.disconnect(); });
      process.send('ready');`;
    const children = [0,1].map(() => spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,path],{stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH}}));
    try {
      await Promise.all(children.map(child => new Promise<void>((resolve,reject) => {
        child.once('message', m => m === 'ready' ? resolve() : reject(new Error('not ready')));
        child.once('error', reject);
        child.once('exit', code => { if(code) reject(new Error(`child exit ${code}`)); });
      })));
      const outcomes = children.map(child => new Promise(resolve => child.once('message',resolve)));
      children.forEach(child => child.send('persist'));
      expect((await Promise.all(outcomes)).sort()).toEqual(['committed','rejected']);
      expect(await new InMemoryKV(path).list('scope')).toEqual(['synthetic']);
    } finally { children.forEach(child => child.kill()); }
  });
  it.skipIf(process.platform === "win32")("survives process interruption after temp fsync before rename", async () => {
    const path = fixture(); const kv = new InMemoryKV(path); await kv.set("scope", "x", "old"); kv.persist();
    const module = new URL('../src/mcp/in-memory-kv.ts', import.meta.url).href;
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const real = fs.fsyncSync; fs.fsyncSync = fd => { real(fd); process.kill(process.pid, 'SIGKILL'); }; syncBuiltinESMExports();
      const {InMemoryKV} = await import(${JSON.stringify(module)});
      const kv = new InMemoryKV(process.argv[1]); await kv.set('scope','x','new'); kv.persist();`;
    const result = spawnSync(process.execPath, ['--import','tsx', '--input-type=module','-e',script,path], {timeout:10000,env:{PATH:process.env.PATH}});
    expect(result.signal).toBe("SIGKILL");
    expect(await new InMemoryKV(path).get("scope","x")).toBe("old");
    expect(existsSync(`${path}.lock`)).toBe(true);
    expect(() => new InMemoryKV(path).persist()).toThrow();
  });
});
