import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { namespaceEnabled, waitForDeployment } from '../deploy.ts';
import { operatorIO, query, runOperator, type Config, type OperatorIO } from '../operator.ts';

export interface RunContext {
  repository: string;
  repositoryId: string;
  sha: string;
  deployment: string;
  event: string;
  ref: string;
}

// Each target applies its own event and branch rules to this identity.
export function runContext(env: Record<string, string | undefined>): RunContext {
  const repository = env['GITHUB_REPOSITORY'];
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error('Invalid repository');
  const repositoryId = env['GITHUB_REPOSITORY_ID'];
  if (!repositoryId || !/^[1-9][0-9]*$/.test(repositoryId))
    throw new Error('Invalid repository ID');
  const sha = env['REMOTE_CACHE_SOURCE_SHA'] || env['GITHUB_SHA'];
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Use the full source commit SHA');
  const run = env['GITHUB_RUN_ID'];
  const attempt = env['GITHUB_RUN_ATTEMPT'];
  if (!run || !attempt || !/^\d+$/.test(run) || !/^\d+$/.test(attempt))
    throw new Error('Invalid workflow run identity');
  return {
    repository,
    repositoryId,
    sha,
    deployment: `${sha}-${run}-${attempt}`,
    event: env['GITHUB_EVENT_NAME'] ?? '',
    ref: env['GITHUB_REF'] ?? '',
  };
}

export interface Target {
  name: string;
  // Expected account subdomain. Defaults to the authenticated account's subdomain.
  subdomain?: string;
  profile: 'free' | 'paid';
  // Namespace to public GitHub owner/repository.
  bindings: Readonly<Record<string, string>>;
  setupArgs?: string[];
  // Runs after every namespace is set up, before the Worker deployment.
  prepare?(config: Config): Promise<void>;
}

export interface Deployment {
  config: Config;
  deployment: string;
  endpoints: { namespace: string; endpoint: string; enabled: boolean }[];
}

export async function deployTarget(
  target: Target,
  context: Pick<RunContext, 'deployment'>,
  io: OperatorIO = operatorIO,
  request: typeof fetch = fetch,
  wait: (ms: number) => Promise<unknown> = setTimeout,
): Promise<Deployment> {
  const namespaces = Object.keys(target.bindings);
  if (!namespaces.length) throw new Error('Bind at least one namespace');
  const account = (await io.api('/workers/subdomain')) as { subdomain?: unknown };
  if (typeof account.subdomain !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(account.subdomain))
    throw new Error('Create a workers.dev subdomain in your Cloudflare account before deploying');
  if (target.subdomain !== undefined)
    assert.equal(
      account.subdomain,
      target.subdomain,
      'The configured Workers subdomain must belong to the authenticated Cloudflare account',
    );
  const origin = `https://${target.name}.${account.subdomain}.workers.dev`;
  const setupIO: OperatorIO = {
    ...io,
    async wrangler(args) {
      // Install every namespace policy before the single final deployment.
      if (args[0] !== 'deploy') await io.wrangler(args);
    },
    async writeConfig(config) {
      config.vars['DEPLOYMENT_ID'] = context.deployment;
      await io.writeConfig(config);
    },
  };
  for (const namespace of namespaces)
    await runOperator(
      [
        'setup',
        '--name',
        target.name,
        '--namespace',
        namespace,
        '--repo',
        target.bindings[namespace]!,
        '--origin',
        origin,
        '--profile',
        target.profile,
        ...(target.setupArgs ?? []),
      ],
      setupIO,
    );
  const config = await io.readConfig();
  await target.prepare?.(config);
  const scopes = await query(io, config, 'SELECT scope_id FROM scopes');
  config.vars['NAMESPACES'] = JSON.stringify(scopes.map((scope) => String(scope['scope_id'])));
  await io.writeConfig(config);
  await io.wrangler(['deploy', '--config', 'wrangler.operator.json']);
  const bucket = config.r2_buckets[0]!.bucket_name;
  const managed = (await io.api(`/r2/buckets/${bucket}/domains/managed`)) as { enabled: boolean };
  const custom = (await io.api(`/r2/buckets/${bucket}/domains/custom`)) as { domains: unknown[] };
  assert.equal(managed.enabled, false, 'R2 must remain private');
  assert.deepEqual(custom.domains, [], 'R2 must have no public custom domain');
  const endpoints: Deployment['endpoints'] = [];
  for (const namespace of namespaces) {
    const endpoint = `${origin}/projects/${namespace}`;
    const enabled = await namespaceEnabled(io, config, namespace);
    await waitForDeployment(endpoint, context.deployment, enabled, request, wait);
    endpoints.push({ namespace, endpoint, enabled });
  }
  return { config, deployment: context.deployment, endpoints };
}

export async function reportDeployment(
  result: Deployment,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (env['GITHUB_OUTPUT'])
    await appendFile(env['GITHUB_OUTPUT'], `url=${result.endpoints[0]!.endpoint}\n`);
  if (env['GITHUB_STEP_SUMMARY'])
    await appendFile(
      env['GITHUB_STEP_SUMMARY'],
      `### Remote cache deployment\n\nWorker: \`${result.config.name}\`. Deployment: \`${result.deployment}\`\n\n` +
        result.endpoints
          .map(({ endpoint, enabled }) => `- ${endpoint}${enabled ? '' : ' (disabled)'}`)
          .join('\n') +
        '\n',
    );
}
