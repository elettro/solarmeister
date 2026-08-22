# Balkonstrom → SolarMeister sync policy

Balkonstrom is the supplier source of truth for synchronized SolarMeister dropship products.

## Mandatory sync behavior

Every Balkonstrom price-sync run must also run the availability sync in the same maintenance cycle.

### Price

- Read the current Balkonstrom source price.
- SolarMeister target price is source price + 17%.
- Customer-facing SolarMeister prices use whole euros, no cents.
- For source/target amounts under €15, do not force a `.99` ending. Use the post-markup whole-euro value.
- Only write a Shopify price when the calculated target price changed.

### Availability

- Balkonstrom AVAILABLE / `available: true` → SolarMeister must be sellable.
- For zero local Shopify inventory, use Shopify inventory policy `CONTINUE` so zero local quantity does not create a false `Ausverkauft` state.
- Balkonstrom explicitly SOLD OUT / all source variants unavailable → SolarMeister inventory policy `DENY`.
- Supplier fetch error, parse error, timeout, CAPTCHA, missing product, or ambiguous status → do not change Shopify availability. Preserve the last-known Shopify status and flag the product for review.
- Never infer supplier sold-out status from SolarMeister's local Shopify quantity.
- Never convert an unknown supplier result into `Ausverkauft`.

## Current implementation

`scripts/sync-balkonstrom-availability.mjs` implements the availability guardrail for mapped products.

`.github/workflows/sync-balkonstrom-availability.yml` runs the availability check daily and can also be run manually.

When the automated price writer is added or updated, it must invoke the same availability logic as a required stage of that run. Price synchronization is not considered complete until supplier availability has also been checked.

## Mapping rule

Each synchronized SolarMeister product must have an explicit Balkonstrom source mapping. Do not guess source products by title similarity at write time.
