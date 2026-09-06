/**
 * `fetch_official_rate` - the agent's read-only window onto the ECB feed.
 *
 * The handler owns retry and classification so the model never has to reason
 * about HTTP. It sees one of three shapes and is told plainly what to do next.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveOfficialRate, type ResolverDeps } from '../rates/resolver.js';
import type { RateLookupResult } from '../domain/rate-types.js';

const inputSchema = {
  date: z
    .string()
    .describe('The invoice date to price, as YYYY-MM-DD. Not today\'s date unless the invoice is dated today.'),
  base: z.string().describe('Source currency code, e.g. USD - the currency the invoice is denominated in.'),
  quote: z.string().describe('Target currency code, e.g. EUR - the currency the invoice was converted into.'),
};

/** Text is a human summary; `structuredContent` carries the fields to act on. */
export function summarise(result: RateLookupResult): string {
  switch (result.kind) {
    case 'resolved': {
      const { quote } = result;
      const dateNote =
        result.dateResolution === 'exact'
          ? `published for ${result.rateDate}`
          : `published for ${result.rateDate}, the last TARGET business day on or before ${result.requestedDate}`;
      const derivedNote = result.derived
        ? ` This rate is DERIVED (${result.derivation.type}) from published euro rates rather than published directly.`
        : '';
      return (
        `Official rate ${quote.base}/${quote.quote} = ${quote.rate} (${quote.quote} per 1 ${quote.base}), ${dateNote}.` +
        derivedNote +
        ` Pass this quote to compute_discrepancy unchanged.`
      );
    }
    case 'deferred':
      return (
        `No official rate available yet for ${result.requestedDate} (${result.reason}). ${result.detail} ` +
        `Do not retry this invoice in this pass and do not substitute another date's rate. ` +
        `Leave it deferred until ${result.retryAfter}.`
      );
    case 'escalate':
      return (
        `No official rate can be established for ${result.requestedDate ?? 'the given date'} (${result.reason}). ` +
        `${result.detail} Do not retry and do not estimate a rate. Record an escalation for human review.`
      );
  }
}

export function createFetchOfficialRateTool(deps: ResolverDeps) {
  return tool(
    'fetch_official_rate',
    'Look up the official ECB euro reference rate for a currency pair on a specific past date. ' +
      'Handles weekends and TARGET holidays by falling back to the last published business day and reporting ' +
      'which date the rate came from. Never estimates: if no rate can be established it returns a deferral or ' +
      'an escalation instead of a number.',
    inputSchema,
    async (args) => {
      let result: RateLookupResult;
      try {
        result = await resolveOfficialRate(
          { requestedDate: args.date, base: args.base, quote: args.quote },
          deps,
        );
      } catch (error) {
        // The resolver classifies everything it expects; anything reaching here
        // is a defect, so say so rather than letting it read as a rate problem.
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Rate lookup failed unexpectedly: ${error instanceof Error ? error.message : String(error)}. ` +
                `This is an internal fault, not a missing rate. Do not retry; record an escalation.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: summarise(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
        // Only an exhausted source counts as a tool failure. A deferral or an
        // escalation is a legitimate answer to a legitimate question.
        ...(result.kind === 'deferred' && result.reason === 'source_unavailable' ? { isError: true } : {}),
      };
    },
    {
      annotations: {
        title: 'Fetch official ECB rate',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
  );
}
