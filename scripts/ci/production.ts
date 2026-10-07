import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { parse, type ParseError } from 'jsonc-parser';
import { query } from '../operator.ts';
import type { RunContext, Target } from './deploy.ts';

interface ProductionConfig {
  source: string;
  ref: string;
  name: string;
  profile: Target['profile'];
}

export const production: ProductionConfig = {
  source: 'voidzero-dev/vite-plus-remote-cache-cloudflare',
  ref: 'refs/heads/main',
  name: 'voidzero-remote-cache',
  profile: 'free',
};

// Add or remove production repositories in this file.
const repositoriesFile = new URL('../../.github/production-repositories.jsonc', import.meta.url);

export function parseRepositories(text: string): Record<string, string> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Production repositories must be a JSONC object of namespace to owner/repo');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 100)
    throw new Error('List between 1 and 100 production repositories');
  for (const [namespace, repository] of entries)
    if (
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace) ||
      typeof repository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    )
      throw new Error(`Invalid production repository entry: ${namespace}`);
  return Object.fromEntries(entries) as Record<string, string>;
}

export function productionTarget(
  context: Pick<RunContext, 'repository' | 'event' | 'ref'>,
  config: ProductionConfig = production,
  repositories: string = readFileSync(repositoriesFile, 'utf8'),
): Target {
  // Repositories created by Deploy to Cloudflare copy this workflow; they must not deploy it.
  if (context.repository !== config.source)
    throw new Error(`Production deploys only from ${config.source}`);
  if (context.event !== 'workflow_dispatch')
    throw new Error('Start production deployments manually');
  if (context.ref !== config.ref) throw new Error(`Production deploys only from ${config.ref}`);
  if (/-(ci|staging)$/.test(config.name))
    throw new Error('Production cannot use CI staging resources');
  const bindings = parseRepositories(repositories);
  const listed = JSON.stringify(Object.keys(bindings));
  return {
    name: config.name,
    profile: config.profile,
    bindings,
    // The list decides which namespaces serve reads and accept uploads, overriding
    // `pnpm operator policy`. Only changed rows are updated: the changed_policy trigger bumps
    // policy_version on any switch update, which stops in-flight uploads from publishing.
    async prepare(deployed, io) {
      await query(
        io,
        deployed,
        `UPDATE scopes SET enabled = 1, writes_enabled = 1
        WHERE scope_id IN (SELECT value FROM json_each(?)) AND (enabled = 0 OR writes_enabled = 0)`,
        [listed],
      );
      const disabled = await query(
        io,
        deployed,
        `UPDATE scopes SET enabled = 0, writes_enabled = 0
        WHERE scope_id NOT IN (SELECT value FROM json_each(?)) AND (enabled = 1 OR writes_enabled = 1)
        RETURNING scope_id`,
        [listed],
      );
      for (const scope of disabled)
        io.print(`Disabled namespace ${String(scope['scope_id'])}: it is not in the repository list`);
    },
  };
}
