import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployTarget, runContext, type Target } from '../scripts/ci/deploy.ts';
import { parseRepositories, production, productionTarget } from '../scripts/ci/production.ts';
import { readTemplate, type Config, type OperatorIO } from '../scripts/operator.ts';
import { harness } from './helpers.ts';

const sha = 'a'.repeat(40);
const deployment = `${sha}-42-1`;
const database = '12345678-1234-1234-1234-123456789abc';
const dispatch = {
  repository: production.source,
  event: 'workflow_dispatch',
  ref: 'refs/heads/main',
};

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
  const context = dispatch;
  // Also validates the committed repository list.
  const target = productionTarget(context);
  assert.equal(target.name, production.name);
  assert.equal(target.profile, production.profile);
  assert.ok(Object.keys(target.bindings).length > 0);
  assert.throws(() => productionTarget({ ...context, event: 'push' }), /manually/);
  assert.throws(() => productionTarget({ ...context, ref: 'refs/heads/feature' }), /main/);
  assert.throws(() => productionTarget({ ...context, repository: 'someone/copy' }), /voidzero-dev/);
  for (const name of ['vp-cache-ci', 'vp-cache-ci-staging'])
    assert.throws(() => productionTarget(context, { ...production, name }), /staging/);
});

void test('production repository lists map namespaces to public owner/repo names', () => {
  assert.deepEqual(
    parseRepositories('// comment\n{ "one": "acme/one", "two-x": "Acme/two.js", }'),
    { one: 'acme/one', 'two-x': 'Acme/two.js' },
  );
  for (const text of [
    '',
    '{}',
    '["acme/one"]',
    '{ "One": "acme/one" }',
    '{ "-one": "acme/one" }',
    '{ "one": "https://github.com/acme/one" }',
    '{ "one": 1 }',
    '{ "one": "acme/one" ',
  ])
    assert.throws(() => parseRepositories(text), /production repositor/i);
});

void test('production deployments enable listed namespaces and disable all others', async () => {
  const h = await harness();
  const config = await readTemplate();
  config.d1_databases[0]!.database_id = database;
  const printed: string[] = [];
  const unexpected = async () => {
    throw new Error('Unexpected operator call');
  };
  const io: OperatorIO = {
    async api(path, _method, body) {
      assert.equal(path, `/d1/database/${database}/query`);
      const { sql, params } = body as { sql: string; params: (string | number | null)[] };
      return [
        await h.db
          .prepare(sql)
          .bind(...params)
          .all(),
      ];
    },
    github: unexpected,
    wrangler: unexpected,
    readConfig: unexpected,
    writeConfig: unexpected,
    lifecycle: unexpected,
    print: (message) => printed.push(message),
  };
  const policies = async () =>
    (
      await h.db
        .prepare('SELECT scope_id, enabled, writes_enabled, policy_version FROM scopes ORDER BY scope_id')
        .all()
    ).results;
  const target = productionTarget(dispatch, production, '{ "test": "owner/repo" }');
  const expected = [
    { scope_id: 'other', enabled: 0, writes_enabled: 0, policy_version: 2 },
    { scope_id: 'test', enabled: 1, writes_enabled: 1, policy_version: 3 },
  ];
  try {
    // A manual upload pause on a listed namespace lasts only until the next deployment.
    // The pause and its reversal each bump policy_version.
    await h.db.prepare("UPDATE scopes SET writes_enabled = 0 WHERE scope_id = 'test'").run();
    await target.prepare!(config, io);
    assert.deepEqual(await policies(), expected);
    assert.deepEqual(printed, ['Disabled namespace other: it is not in the repository list']);

    // A deployment that changes no switch leaves in-flight uploads alone.
    printed.length = 0;
    await target.prepare!(config, io);
    assert.deepEqual(await policies(), expected);
    assert.deepEqual(printed, []);
  } finally {
    await h.close();
  }
});
