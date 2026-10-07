import type { RunContext, Target } from './deploy.ts';

interface ProductionConfig extends Target {
  source: string;
  ref: string;
}

// Bind another public repository with `namespace: 'owner/repository'`. Removing a binding does
// not withdraw its data; use `pnpm operator policy` or `pnpm operator purge` for that.
export const production: ProductionConfig = {
  source: 'voidzero-dev/vite-plus-remote-cache-cloudflare',
  ref: 'refs/heads/main',
  name: 'voidzero-remote-cache',
  profile: 'free',
  bindings: { rolldown: 'rolldown/rolldown' },
};

export function productionTarget(
  context: Pick<RunContext, 'repository' | 'event' | 'ref'>,
  config: ProductionConfig = production,
): Target {
  // Repositories created by Deploy to Cloudflare copy this workflow; they must not deploy it.
  if (context.repository !== config.source)
    throw new Error(`Production deploys only from ${config.source}`);
  if (context.event !== 'workflow_dispatch')
    throw new Error('Start production deployments manually');
  if (context.ref !== config.ref) throw new Error(`Production deploys only from ${config.ref}`);
  if (/-(ci|staging)$/.test(config.name))
    throw new Error('Production cannot use CI staging resources');
  return { name: config.name, profile: config.profile, bindings: config.bindings };
}
