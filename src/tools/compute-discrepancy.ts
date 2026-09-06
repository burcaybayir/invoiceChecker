/**
 * `compute_discrepancy` - the arithmetic, in TypeScript, where it belongs.
 *
 * The model decides which invoice to check and what to do with the verdict. It
 * never multiplies anything itself.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { roundingFor, toleranceFor } from '../config.js';
import { computeDiscrepancy, type DiscrepancyResult } from '../domain/discrepancy.js';

const inputSchema = {
  invoice_id: z.string().describe('The invoice identifier, echoed back on the result.'),
  source_currency: z.string().describe('Currency the invoice is denominated in, e.g. USD.'),
  target_currency: z.string().describe('Currency the invoice was converted into, e.g. EUR.'),
  source_amount: z.string().describe('Invoice amount in the source currency, as a decimal string, e.g. "12500.00".'),
  applied_rate: z
    .string()
    .describe('The rate actually applied on the invoice, as target-per-source (the number multiplied by the amount).'),
  official_rate: z
    .string()
    .describe('The rate string returned by fetch_official_rate. Pass it through unchanged.'),
  official_rate_base: z
    .string()
    .describe('The base of the official quote, from fetch_official_rate. Must equal source_currency.'),
  official_rate_quote: z
    .string()
    .describe('The quote of the official quote, from fetch_official_rate. Must equal target_currency.'),
  recorded_target_total: z
    .string()
    .optional()
    .describe('The converted total as recorded on the invoice, if present. Cross-checked against amount x applied rate.'),
};

export function summarise(result: DiscrepancyResult): string {
  if (result.verdict === 'anomaly') {
    return (
      `Invoice ${result.invoiceId} could not be checked (${result.anomaly?.reason}). ${result.anomaly?.detail} ` +
      `Record an escalation; do not send a correction.`
    );
  }

  const head =
    `Invoice ${result.invoiceId}: applied ${result.appliedRate}, official ${result.officialRate} ` +
    `(${result.relativeDeltaPct}% apart, ${result.absoluteDelta} ${result.targetCurrency} on the total).`;

  if (result.verdict === 'cleared') {
    const why = !result.thresholds.relativeExceeded
      ? 'the rate gap is within the relative tolerance'
      : 'the rate gap exceeds the relative tolerance but the cash impact is below the absolute floor';
    return `${head} CLEARED - ${why}. No correction and no email.`;
  }

  return (
    `${head} FLAGGED - both tolerances exceeded. Applied total ${result.appliedTotal} ${result.targetCurrency}, ` +
    `corrected total ${result.correctedTotal} ${result.targetCurrency}, correction ${result.correctionAmount} ` +
    `${result.targetCurrency}.`
  );
}

export function createComputeDiscrepancyTool() {
  return tool(
    'compute_discrepancy',
    'Compare the FX rate applied to an invoice against the official rate and decide whether it is a reportable ' +
      'discrepancy. Performs all arithmetic in exact decimal maths and returns the corrected total. An invoice is ' +
      'flagged only when the rate gap exceeds BOTH the relative tolerance and the absolute cash floor.',
    inputSchema,
    async (args) => {
      const sourceCurrency = args.source_currency.trim().toUpperCase();
      const targetCurrency = args.target_currency.trim().toUpperCase();

      const result = computeDiscrepancy({
        invoiceId: args.invoice_id,
        sourceCurrency,
        targetCurrency,
        sourceAmount: args.source_amount,
        appliedRate: args.applied_rate,
        officialQuote: {
          base: args.official_rate_base.trim().toUpperCase(),
          quote: args.official_rate_quote.trim().toUpperCase(),
          rate: args.official_rate,
        },
        ...(args.recorded_target_total !== undefined
          ? { recordedTargetTotal: args.recorded_target_total }
          : {}),
        tolerance: toleranceFor(sourceCurrency, targetCurrency),
        rounding: roundingFor(targetCurrency),
      });

      return {
        content: [{ type: 'text' as const, text: summarise(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
    {
      annotations: {
        title: 'Compute FX discrepancy',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  );
}
