# RFC: Several entries per key

Status: Draft design.

Updated: 2026-11-06. Changes the fetch and store behavior of [RFC 0001](0001-remote-cache.md) and nothing else. Writes keep RFC 0001's policy: protected pushes to the registered branch, and pull requests only where a namespace opts in. Scoped selectors, with per-PR scopes, remain a possible later design. Remote caching hasn't shipped, so this RFC keeps no compatibility with RFC 0001 clients or data.

## 1. Motivation

A namespace keeps one entry per key, and a store with the same key replaces it. A run hits only if its state is the last one stored.

**Ordinary pull request runs don't suffer from this.** They build the PR merged into the current default branch. A task the PR doesn't touch has the same state as the latest default-branch run. A task the PR does touch would miss anyway.

**Runs built on an older default-branch commit do suffer:**

- PR runs without a merged result
- stacked PRs
- PRs into other branches
- developer machines that haven't pulled

These runs miss whenever a task's inputs changed since that commit, even though the namespace stored that state earlier.

**Keeping the last N entries per key lets these runs hit** without any PR uploads.

## 2. Changes

| Area                         | RFC 0001                               | This RFC                                                    |
| ---------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| Fetch                        | the exact entry, or the associated key | the key's live entries, newest first, or the associated key |
| Store                        | replaces the key's entry               | adds an entry; the key keeps its newest N                   |
| N                            |                                        | `entries_per_key`, per namespace, default 8, at most 16     |
| Concurrent stores to one key | the last one wins                      | all are kept, within N                                      |
| Writes                       | protected pushes; PR opt-in            | unchanged                                                   |
| Data                         |                                        | cleared; no data migration                                  |

## 3. HTTP API

### Fetch

The request is unchanged:

```text
POST {endpoint}/fetch
Content-Type: application/cbor

{ key: bytes, secondary_key: bytes }
```

The response is one of:

```text
{ kind: "exact", entries: [{ value: bytes, blob_id: string | null }] }
{ kind: "fallback", key: bytes }
```

- **`entries`** holds the key's live entries, newest first. There's at least one and at most `entries_per_key`.
- **The fallback and `404`** are unchanged. When the key has no live entry, the Worker resolves `secondary_key` to a stored key and returns only that key. If neither resolves, it returns `404`.

### Store

The request and response are unchanged. The behavior changes:

- **A store adds an entry for `key`.** It doesn't replace the key's other entries.
- **If the key then has more than `entries_per_key` live entries,** the oldest are retired in the same transaction. Their blobs stay downloadable for the existing ten-minute grace period.
- **The association** `secondary_key → key` is set as before.
- **Each entry expires** the namespace's retention after its own store, as each generation does today.

## 4. Storage

The tables stay. These change:

- **`scopes`** gains `entries_per_key INTEGER NOT NULL DEFAULT 8 CHECK (entries_per_key BETWEEN 1 AND 16)`.
- **`entries`** gets one row per live entry instead of one per key:

  ```sql
  CREATE TABLE entries (
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
    key BLOB NOT NULL CHECK (typeof(key) = 'blob'),
    generation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (scope_id, key, generation_id),
    FOREIGN KEY (scope_id, generation_id) REFERENCES generations(scope_id, generation_id) ON DELETE CASCADE
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX entries_seq ON entries(scope_id, key, seq);
  ```

  `seq` numbers a key's publications in order. A timestamp would tie when two stores publish in the same second.

- **The publication trigger** adds the entry, then retires the entries past the newest N:

  ```sql
  CREATE TRIGGER publish_generation AFTER UPDATE OF state ON generations
  WHEN OLD.state = 'uploading' AND NEW.state = 'ready'
  BEGIN
    INSERT INTO entries (scope_id, key, generation_id, seq)
      VALUES (NEW.scope_id, NEW.key, NEW.generation_id,
        (SELECT coalesce(max(seq), 0) + 1 FROM entries WHERE scope_id = NEW.scope_id AND key = NEW.key));
    UPDATE generations SET state = 'retired', retired_at = unixepoch(),
      gc_after = (CASE WHEN expires_at > unixepoch() THEN unixepoch() + 600 ELSE unixepoch() END)
      WHERE state = 'ready' AND generation_id IN (
        SELECT generation_id FROM entries WHERE scope_id = NEW.scope_id AND key = NEW.key
        ORDER BY seq DESC
        LIMIT -1 OFFSET (SELECT entries_per_key FROM scopes WHERE scope_id = NEW.scope_id));
    DELETE FROM entries WHERE scope_id = NEW.scope_id AND key = NEW.key AND generation_id IN (
      SELECT generation_id FROM entries WHERE scope_id = NEW.scope_id AND key = NEW.key
      ORDER BY seq DESC
      LIMIT -1 OFFSET (SELECT entries_per_key FROM scopes WHERE scope_id = NEW.scope_id));
    INSERT INTO associations (scope_id, secondary_key, target_key) VALUES (NEW.scope_id, NEW.secondary_key, NEW.key)
      ON CONFLICT (scope_id, secondary_key) DO UPDATE SET target_key = excluded.target_key;
  END;
  ```

- **`entry_limit` still counts keys.** `count_entry` fires only for a key's first row, as today. `uncount_entry` fires only when a key's last row is deleted (`WHEN NOT EXISTS` a remaining row for the key). Bytes stay bounded by the byte budget.
- **Fetch** reads the newest `entries_per_key` live entries for the key, joined with their generations. It reads the association only when there are none.
- **Cleanup** is unchanged. Deleting an expired generation deletes its entry row through the foreign key.

## 5. Costs and limits

**Fetch.** A fetch makes up to N R2 reads, at most six at a time, and returns up to N values. The value limit stays 4 MiB, so a response can reach N × 4 MiB; the Worker streams it.

**Values must be compressed.** `vp run` should compress values with zstd before storing them. In a replay of five public repositories' CI, values as the client sends them today measured:

| Values       | Median | p90     | Max     |
| ------------ | ------ | ------- | ------- |
| Uncompressed | 111 KB | 1.66 MB | 3.10 MB |
| Compressed   | 9.1 KB | 123 KB  | 191 KB  |

With eight entries, a fetch carries eight times that. Large repositories also exceed the 4 MiB limit with uncompressed values.

**Storage.** A key holds up to N generations, so it holds N blobs where it held one. The byte budget, rate limits and retention are unchanged.

**Store.** Publication writes up to N more rows, for retiring and deleting old entries.

**Choosing N.** A run hits if its state is among the last N stored for the key:

- A task whose inputs change on every merge reaches back N merges.
- A task that rarely changes reaches back N input changes, which is usually days or weeks.

Most of the gain over one entry comes by 8–16. The default is 8, and operators can raise it to 16.

## 6. Client changes in `vp run`

- **Fetch.** Decode `entries` and validate them newest first. Restore the first match's blob. With no match, explain the miss against the newest entry.
- **Store.** Compress the value with zstd before upload, and decompress it after fetch. The request is otherwise unchanged.
- **Tests.** The test server in `vt_remote_cache` and the e2e `remote_cache_backend` fixture return entry lists.

## 7. Rollout

- **Migration `0003_entries_per_key` drops and recreates** `generations`, `entries` and `associations` and their triggers. It adds `entries_per_key` and resets the byte and entry counters. Namespace registrations and policy stay.
  - The R2 bucket's lifecycle rules delete the old objects. Operators who want the bytes back sooner can empty the bucket.
- **The operator script** gains `--entries-per-key`.
- **The Worker and `vp run` ship together.** Older clients fail to decode the new fetch response; they treat that as a failed read and run the task.

## 8. Alternatives considered

- **Scoped selectors:**
  - one compressed list of runs per key, sorted by path
  - a version check on store
  - PR scopes

  They reach further for fewer bytes and add hits on a PR's later runs, but need much more server work. They can still come later.

- **Renewing a key's older entries on each store.** It keeps old states past their own retention. The measured gain at N ≤ 16 was small, and it costs a write per kept entry.
- **One entry per key with a version check that keeps the newer run.** Out-of-order stores turned out to cost almost nothing, so this wouldn't help.

## 9. Open questions

- **Whether the default N should be 8 or 16.**
- **The PR upload opt-in.** With entries added rather than replaced, PR stores would also push the default branch's entries out of a key's N slots. Should it be removed with this change?
