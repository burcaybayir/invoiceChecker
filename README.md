# invoiceChecker

Finds currency errors in invoices: compares the FX rate applied to an invoice
against the official ECB euro reference rate for that date, and reports the
correction.

**Status: step 1 of 5.** `fetch_official_rate` and `compute_discrepancy` exist as
standalone tools with unit tests. There is no pipeline, no state store, and no
notification path yet.

## Design decisions worth knowing

- **Source of truth:** ECB euro foreign exchange reference rates, published on
  TARGET business days at about 16:00 Frankfurt time.
- **Rate direction:** every rate is normalised to *units of target per one unit
  of source*. The ECB publishes units-per-euro, so non-euro pairs are derived and
  flagged as such (`derived: true`) in the audit trail.
- **Nothing is estimated.** A date with no published rate is a deferral (retry
  later) or an escalation (a human looks at it) - never an interpolated,
  averaged, or substituted value.
- **A same-day invoice before publication is deferred,** not filled with
  yesterday's rate. This is the rule that stops the system producing a wrong
  number with a clean audit trail.
- **A business day missing from the feed is an escalation,** not a walk-back. The
  walk-back skips days the market was closed; it never skips a day the ECB
  should have published.
- **An invoice is flagged only when BOTH tolerances are exceeded:** the relative
  rate gap (default 0.5%) and the absolute cash impact (default 25 units).
- **All arithmetic is exact decimal maths**, never floats, and happens in
  TypeScript rather than in the model.

## Layout

    src/domain/      dates, TARGET calendar, decimal money, the pure comparison
    src/rates/       ECB feed client, failure classification, the date resolver
    src/tools/       the two SDK tools and their in-process MCP server
    test/            unit tests; test/fixtures holds STUB_ data (never real rates)

## Commands

    npm test          run the unit tests
    npm run build     typecheck

## Test data

Everything under `test/fixtures` is synthetic and prefixed `STUB_`. No file in
this repository contains a real published exchange rate.
