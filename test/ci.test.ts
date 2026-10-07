import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployTarget, runContext, type Target } from '../scripts/ci/deploy.ts';
import { production, productionTarget } from '../scripts/ci/production.ts';
import type { Config, OperatorIO } from '../scripts/operator.ts';
import { harness } from './helpers.ts';

const sha = 'a'.repeat(40);
const deployment = `${sha}-42-1`;

void test('CI run context identifies the source commit and workflow attempt', () => {
  const env = {
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_REPOSITORY_ID: '123',
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
  };
  assert.deepEqual(runContext(env), {
    repository: 'owner/repo',
    repositoryId: '123',
    sha,
    deployment,
    event: 'workflow_dispatch',
    ref: 'refs/heads/main',
  });
  const head = 'b'.repeat(40);
  assert.equal(runContext({ ...env, REMOTE_CACHE_SOURCE_SHA: head }).sha, head);
  for (const override of [
    { GITHUB_REPOSITORY: 'owner' },
    { GITHUB_REPOSITORY_ID: '0' },
    { GITHUB_SHA: 'abc' },
    { GITHUB_RUN_ATTEMPT: '' },
  ])
    assert.throws(() => runContext({ ...env, ...override }));
});

void test('CI deployments set up every namespace before one Worker deployment and preserve withdrawals', async () => {
  const h = await harness({
    initializeDatabase: false,
    namespaces: ['one', 'two'],
    deploymentId: deployment,
  });
  const database = '12345678-1234-1234-1234-123456789abc';
  const repositories: Record<string, number> = { 'acme/one': 1, 'acme/two': 2 };
  let config: Config | undefined;
  let migrated = false;
  const log: string[] = [];
  const waits: number[] = [];
  const io: OperatorIO = {
    async api(path, method, body) {
      if (path === '/workers/subdomain') return { subdomain: 'team' };
      if (path === '/d1/database?name=prod-cache&per_page=100')
        return [{ name: 'prod-cache', uuid: database }];
      if (path === `/d1/database/${database}/query`) {
        const { sql, params } = body as { sql: string; params: (string | number | null)[] };
        return [
          await h.db
            .prepare(sql)
            .bind(...params)
            .all(),
        ];
      }
      if (path === '/r2/buckets/prod-cache') return { storage_class: 'Standard' };
      if (path === '/r2/buckets/prod-cache/domains/custom') return { domains: [] };
      if (path === '/r2/buckets/prod-cache/domains/managed')
        return method === 'PUT' ? {} : { enabled: false };
      throw new Error(`Unexpected API request: ${path}`);
    },
    async github(repository) {
      return {
        id: repositories[repository],
        full_name: repository,
        owner: { id: 456 },
        private: false,
        visibility: 'public',
        default_branch: 'main',
      };
    },
    async wrangler(args) {
      log.push(args.slice(0, 2).join(' '));
      if (args[1] === 'migrations' && !migrated) {
        await h.migrate();
        migrated = true;
      }
    },
    async readConfig() {
      return structuredClone(config!);
    },
    async writeConfig(value) {
      config = structuredClone(value);
    },
    async lifecycle() {},
    print() {},
  };
  const request: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const response = await h.mf.dispatchFetch(req.url, {
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: await req.arrayBuffer(),
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  };
  const target: Target = {
    name: 'prod-cache',
    profile: 'free',
    bindings: { one: 'acme/one', two: 'acme/two' },
    async prepare() {
      log.push('prepare');
    },
  };
  const run = (overrides: Partial<Target> = {}) =>
    deployTarget({ ...target, ...overrides }, { deployment }, io, request, async (ms) => {
      waits.push(ms);
    });
  const deploys = () => log.filter((entry) => entry === 'prepare' || entry.startsWith('deploy'));
  try {
    const result = await run();
    assert.deepEqual(deploys(), ['prepare', 'deploy --config']);
    assert.deepEqual(waits, []);
    assert.equal(config!.vars['DEPLOYMENT_ID'], deployment);
    assert.deepEqual(JSON.parse(config!.vars['NAMESPACES']!).sort(), ['one', 'two']);
    assert.deepEqual(result.endpoints, [
      {
        namespace: 'one',
        endpoint: 'https://prod-cache.team.workers.dev/projects/one',
        enabled: true,
      },
      {
        namespace: 'two',
        endpoint: 'https://prod-cache.team.workers.dev/projects/two',
        enabled: true,
      },
    ]);
    const scopes = await h.db
      .prepare('SELECT scope_id, repository_id FROM scopes ORDER BY scope_id')
      .all();
    assert.deepEqual(scopes.results, [
      { scope_id: 'one', repository_id: '1' },
      { scope_id: 'two', repository_id: '2' },
    ]);

    // A new runner has no wrangler.operator.json, and redeployment must not re-enable a namespace.
    await h.db.prepare("UPDATE scopes SET enabled = 0 WHERE scope_id = 'two'").run();
    config = undefined;
    log.length = 0;
    const retry = await run();
    assert.deepEqual(deploys(), ['prepare', 'deploy --config']);
    assert.equal(retry.endpoints[1]!.enabled, false);

    log.length = 0;
    repositories['acme/two'] = 3;
    await assert.rejects(run(), /different repository/);
    assert.deepEqual(deploys(), []);

    log.length = 0;
    await assert.rejects(run({ subdomain: 'other' }), /Workers subdomain/);
    assert.deepEqual(log, []);
  } finally {
    await h.close();
  }
});

void test('production deploys only manual default-branch runs from this repository', () => {
  const context = {
    repository: production.source,
    event: 'workflow_dispatch',
    ref: 'refs/heads/main',
  };
  assert.deepEqual(productionTarget(context), {
    name: production.name,
    profile: production.profile,
    bindings: production.bindings,
  });
  assert.throws(() => productionTarget({ ...context, event: 'push' }), /manually/);
  assert.throws(() => productionTarget({ ...context, ref: 'refs/heads/feature' }), /main/);
  assert.throws(() => productionTarget({ ...context, repository: 'someone/copy' }), /voidzero-dev/);
  for (const name of ['vp-cache-ci', 'vp-cache-ci-staging'])
    assert.throws(() => productionTarget(context, { ...production, name }), /staging/);
});
