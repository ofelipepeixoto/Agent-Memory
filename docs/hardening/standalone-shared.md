# Standalone durability and explicit shared access (draft)

This fork retains upstream Apache-2.0 licensing and attribution. These changes
harden the existing standalone JSON fallback; they do not replace iii-engine.

## Durability contract

Invalid JSON or scope shape fails startup without modifying the source file.
Only a missing snapshot creates an empty store. Persistence obtains an exclusive
`.lock`, compares the loaded snapshot bytes to disk, writes a unique same-directory
0600 temporary file, fsyncs it, then renames and fsyncs the parent directory on
POSIX. Stale snapshots and concurrent lock owners are rejected; no automatic
merge or last-writer-wins. Any write error is surfaced and the instance must be
reopened before reads or writes. Snapshot format remains compatible with the
previous plain scope/key JSON object.

The parent directory must be private to the service user and on a local filesystem
with atomic same-directory rename. This is not protection against a malicious
local user with write access to that directory or an NFS/distributed lock scheme.
Windows has no directory fsync via this API: power-loss durability is not certified.
A crash may leave a `.lock` or `.tmp`; never auto-delete a lock owned by another
writer. Stop all writers, preserve artifacts, verify the committed snapshot, then
remove only the abandoned lock/temp files and reopen. A failed directory fsync
may leave a new committed file: recovery must inspect disk instead of replaying
an assumed failed write. The entire JSON snapshot is still synchronous and
unbounded; no performance or multi-tenant claim follows from this patch.

## Shared access

`AGENTMEMORY_ACCESS_MODE=shared` is an explicit operator opt-in, not configured by
this PR. It requires a nonempty, non-placeholder `AGENTMEMORY_SECRET` before any
provider or worker is started. REST and HTTP MCP share exact bearer validation.
The local viewer is not started in shared mode because it proxies using a server
credential without authenticating a distinct browser user. Liveness remains public.
The default `local` preserves upstream local behavior; keep all engine ports on
loopback/private networking. The worker cannot discover the engine's independent
bind configuration; deployments must set shared mode before exposing HTTP.

A shared bearer token is one trust domain, NOT per-user authorization or SaaS
isolation. Do not expose the engine WebSocket, state module, streams or worker
registration port. Do not store real customer data before tenant/role, export,
delete, cache and job-isolation tests. This change neither generates nor rotates
credentials and does not modify permissions.

## Verification and release gates

Run `npx vitest run test/durable-kv.test.ts test/shared-access.test.ts test/mcp-standalone.test.ts`.
The durability tests use synthetic temp directories and child processes. They
cover malformed files, roundtrip/deletion, stale writers, lock contention, rename
failure, two competing processes, and SIGKILL between temp fsync and rename.
The SIGKILL test uses the dev dependency tsx and POSIX; it is not a
power-cut or filesystem-corruption certification. Auth tests use mocked handlers.
No providers, agents, workflows or production integrations are started.

Before promotion: inspect full-suite failures, validate backup/restore with all
writers stopped, reconcile revocations, test directory permissions, perform
negative isolation tests and review dependency conflicts. A snapshot restores data,
not authorization freshness. Rollback must preserve current state and revocations;
never restart an older writer against unverified data. No merge/deploy authorized
by this document.

Observed locally (Node 24.19.0, Vitest 4.1.11, TypeScript 6.0.3): 46 focused
checks passed. The full suite before the final added HTTP-surface check had
1100 passed / 11 failed across 100 files. Those same 11 failures reproduce in
an unchanged checkout with the same dependencies and network guard: fs-watcher
(1), mesh (5), multimodal (5). They involve watcher/environment assumptions,
peer timeouts and an unavailable home-directory image path; they are unresolved.
External network was denied during these tests; loopback fixtures were allowed.
No claim that the complete test suite is green.

Strict scoped compilation of access-policy.ts and in-memory-kv.ts with explicit
Node types passed. Project-wide `tsc --noEmit` fails on the original checkout as
well (Node types configuration and SDK/type incompatibilities); the new node:crypto
and NodeJS references encounter that same missing Node types configuration.
Build/release packaging was not certified. Dependencies required legacy peer
resolution; lifecycle scripts were disabled. No dependency manifests changed.
