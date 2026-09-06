/**
 * The in-process MCP server carrying the read-only half of the pipeline.
 *
 * Nothing registered here can change anything. The irreversible tool
 * (send_notification) lands on its own server in step 4, so that dry-run mode
 * can omit it entirely rather than ask it to police itself.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { HttpEcbSource } from '../rates/ecb-source.js';
import type { ResolverDeps } from '../rates/resolver.js';
import { createComputeDiscrepancyTool } from './compute-discrepancy.js';
import { createFetchOfficialRateTool } from './fetch-official-rate.js';

export const FX_SERVER_NAME = 'fx';

export function createFxServer(deps?: Partial<ResolverDeps>) {
  const resolverDeps: ResolverDeps = {
    source: deps?.source ?? new HttpEcbSource(),
    ...(deps?.clock ? { clock: deps.clock } : {}),
    ...(deps?.allowTriangulation !== undefined ? { allowTriangulation: deps.allowTriangulation } : {}),
    ...(deps?.maxWalkBackDays !== undefined ? { maxWalkBackDays: deps.maxWalkBackDays } : {}),
  };

  return createSdkMcpServer({
    name: FX_SERVER_NAME,
    version: '0.1.0',
    tools: [createFetchOfficialRateTool(resolverDeps), createComputeDiscrepancyTool()],
  });
}

/** Fully-qualified names, for `allowedTools`. Both are read-only and safe to pre-approve. */
export const FX_TOOL_NAMES = {
  fetchOfficialRate: `mcp__${FX_SERVER_NAME}__fetch_official_rate`,
  computeDiscrepancy: `mcp__${FX_SERVER_NAME}__compute_discrepancy`,
} as const;
