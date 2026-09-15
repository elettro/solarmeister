const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'f3yf3y-qu.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const DRY_RUN = process.env.DRY_RUN === '1';
const PRICE_DRY_RUN = process.env.PRICE_DRY_RUN !== '0';
const PRICE_MARKUP = Number(process.env.PRICE_MARKUP || '0.17');
const MAX_PRICE_CHANGE_RATIO = Number(process.env.MAX_PRICE_CHANGE_RATIO || '0.50');

if (!SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing SHOPIFY_ADMIN_TOKEN. No Shopify changes were made.');
  process.exit(2);
}

if (!Number.isFinite(PRICE_MARKUP) || PRICE_MARKUP < 0) {
  console.error(`Invalid PRICE_MARKUP: ${process.env.PRICE_MARKUP}`);
  process.exit(2);
}

// Balkonstrom is the availability and supplier-price source of truth for SolarMeister supplier products.
// Supplier products are identified by SolarMeister SKUs beginning with "SM-".
// Most cloned products retain the same Shopify product handle as Balkonstrom.
// Only genuine handle differences belong in this override map.
const SOURCE_HANDLE_OVERRIDES = new Map([
  ['ecoflow-delta-pro-3-powerstation', 'ecoflow-delta-pro-3'],
]);

function normalizeText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function roundMarkedUpPriceToWholeEuro(sourcePriceCents) {
  if (!Number.isInteger(sourcePriceCents) || sourcePriceCents <= 0) {
    throw new Error(`Invalid supplier price in cents: ${sourcePriceCents}`);
  }

  const sourceEuros = sourcePriceCents / 100;
  return Math.round(sourceEuros * (1 + PRICE_MARKUP));
}

function shopifyPriceToEuros(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function matchSupplierVariant(shopifyVariant, supplierVariants) {
  if (supplierVariants.length === 1) return supplierVariants[0];

  const shopifySku = String(shopifyVariant.sku || '').trim();
  const strippedSku = shopifySku.replace(/^SM-/i, '');
  if (shopifySku) {
    const skuMatches = supplierVariants.filter((variant) => {
      const supplierSku = String(variant.sku || '').trim();
      return supplierSku && (supplierSku === shopifySku || supplierSku === strippedSku);
    });
    if (skuMatches.length === 1) return skuMatches[0];
  }

  const title = normalizeText(shopifyVariant.title);
  if (title) {
    const titleMatches = supplierVariants.filter((variant) => normalizeText(variant.title) === title);
    if (titleMatches.length === 1) return titleMatches[0];
  }

  return null;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'SolarMeister-Balkonstrom-Sync/1.2',
      accept: 'application/json,text/javascript,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function supplierProduct(sourceHandle) {
  const url = `https://www.balkonstrom.com/products/${sourceHandle}.js`;
  const product = await fetchJson(url);
  if (!product || !Array.isArray(product.variants) || product.variants.length === 0) {
    throw new Error(`No variants returned by Balkonstrom for ${sourceHandle}`);
  }

  const available = product.variants.some((variant) => variant.available === true);
  const explicitlyUnavailable = product.variants.every((variant) => variant.available === false);

  if (!available && !explicitlyUnavailable) {
    throw new Error(`Unknown Balkonstrom availability for ${sourceHandle}`);
  }

  return {
    available,
    url,
    sourceTitle: product.title || sourceHandle,
    variants: product.variants,
  };
}

async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Shopify HTTP ${response.status}`);
  const json = await response.json();
  if (json.errors?.length) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

const LIST_PRODUCTS = `
  query SupplierProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      nodes {
        id
        title
        handle
        variants(first: 250) {
          nodes { id title sku price inventoryPolicy availableForSale inventoryQuantity }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const UPDATE_VARIANTS = `
  mutation SyncSupplierVariantData($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price inventoryPolicy availableForSale inventoryQuantity }
      userErrors { field message code }
    }
  }
`;

const VERIFY_PRODUCT = `
  query VerifyProduct($id: ID!) {
    product(id: $id) {
      variants(first: 250) {
        nodes { id price inventoryPolicy }
      }
    }
  }
`;

async function listSupplierProducts() {
  const products = [];
  let after = null;

  do {
    const data = await shopifyGraphQL(LIST_PRODUCTS, { first: 100, after });
    const connection = data.products;

    for (const product of connection.nodes) {
      const supplierProduct = product.variants.nodes.some((variant) =>
        typeof variant.sku === 'string' && variant.sku.startsWith('SM-')
      );
      if (supplierProduct) products.push(product);
    }

    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return products;
}

const report = [];
let failures = 0;
let priceCandidates = 0;
let priceUpdates = 0;
let priceSkipped = 0;
const products = await listSupplierProducts();

for (const product of products) {
  const sourceHandle = SOURCE_HANDLE_OVERRIDES.get(product.handle) || product.handle;

  try {
    const supplier = await supplierProduct(sourceHandle);
    const policy = supplier.available ? 'CONTINUE' : 'DENY';
    const updatesById = new Map();

    for (const variant of product.variants.nodes) {
      if (variant.inventoryPolicy !== policy) {
        updatesById.set(variant.id, { id: variant.id, inventoryPolicy: policy });
      }

      const supplierVariant = matchSupplierVariant(variant, supplier.variants);
      const currentPrice = shopifyPriceToEuros(variant.price);

      if (!supplierVariant) {
        priceSkipped += 1;
        report.push({
          product: product.title,
          variant: variant.title,
          sourceHandle,
          check: 'PRICE',
          status: 'SKIP_UNMATCHED_VARIANT',
          currentPrice,
        });
        continue;
      }

      const sourcePriceCents = Number(supplierVariant.price);
      if (!Number.isInteger(sourcePriceCents) || sourcePriceCents <= 0) {
        priceSkipped += 1;
        report.push({
          product: product.title,
          variant: variant.title,
          sourceHandle,
          check: 'PRICE',
          status: 'SKIP_INVALID_SOURCE_PRICE',
          sourcePriceCents,
          currentPrice,
        });
        continue;
      }

      const sourcePrice = sourcePriceCents / 100;
      const targetPrice = roundMarkedUpPriceToWholeEuro(sourcePriceCents);
      priceCandidates += 1;

      if (currentPrice === null) {
        priceSkipped += 1;
        report.push({
          product: product.title,
          variant: variant.title,
          sourceHandle,
          check: 'PRICE',
          status: 'SKIP_INVALID_SHOPIFY_PRICE',
          sourcePrice,
          targetPrice,
          currentPrice: variant.price,
        });
        continue;
      }

      const differenceRatio = Math.abs(targetPrice - currentPrice) / currentPrice;
      if (differenceRatio > MAX_PRICE_CHANGE_RATIO) {
        priceSkipped += 1;
        report.push({
          product: product.title,
          variant: variant.title,
          sourceHandle,
          check: 'PRICE',
          status: 'SKIP_SUSPICIOUS_CHANGE',
          sourcePrice,
          currentPrice,
          targetPrice,
          differencePct: `${(differenceRatio * 100).toFixed(1)}%`,
        });
        continue;
      }

      if (Math.abs(currentPrice - targetPrice) < 0.005) {
        report.push({
          product: product.title,
          variant: variant.title,
          sourceHandle,
          check: 'PRICE',
          status: 'PARITY_OK',
          sourcePrice,
          currentPrice,
          targetPrice,
        });
        continue;
      }

      if (PRICE_DRY_RUN || DRY_RUN) {
        report.push({
          product: product.title,
          variant: variant.title,
          sourceHandle,
          check: 'PRICE',
          status: 'WOULD_UPDATE',
          sourcePrice,
          currentPrice,
          targetPrice,
        });
      } else {
        const pending = updatesById.get(variant.id) || { id: variant.id };
        pending.price = targetPrice.toFixed(2);
        updatesById.set(variant.id, pending);
      }
    }

    const updates = [...updatesById.values()];
    if (!DRY_RUN && updates.length) {
      const updated = await shopifyGraphQL(UPDATE_VARIANTS, {
        productId: product.id,
        variants: updates,
      });
      const errors = updated.productVariantsBulkUpdate.userErrors || [];
      if (errors.length) throw new Error(`Shopify mutation errors: ${JSON.stringify(errors)}`);

      if (!PRICE_DRY_RUN && updates.some((item) => item.price)) {
        const verified = await shopifyGraphQL(VERIFY_PRODUCT, { id: product.id });
        const variants = verified.product?.variants?.nodes || [];
        const byId = new Map(variants.map((variant) => [variant.id, variant]));

        for (const update of updates.filter((item) => item.price)) {
          const actual = byId.get(update.id)?.price;
          if (actual !== update.price) {
            throw new Error(`Price verification failed for ${update.id}: expected ${update.price}, got ${actual}`);
          }
          priceUpdates += 1;
        }
      }
    }

    report.push({
      product: product.title,
      sourceHandle,
      check: 'AVAILABILITY',
      supplier: supplier.available ? 'AVAILABLE' : 'SOLD_OUT',
      shopifyPolicy: policy,
      variantsChanged: product.variants.nodes.filter((variant) => variant.inventoryPolicy !== policy).length,
      dryRun: DRY_RUN,
    });
  } catch (error) {
    failures += 1;

    // FAIL SAFE:
    // A source lookup error, timeout, CAPTCHA, parser change, 404, ambiguous variant match,
    // invalid source price, or verification failure must never become an unverified write.
    report.push({
      product: product.title,
      sourceHandle,
      check: 'PRODUCT',
      status: 'FAILED',
      supplier: 'UNKNOWN',
      shopifyPolicy: 'UNCHANGED',
      error: error.message,
    });
  }
}

console.table(report);
console.log(`Checked ${products.length} active SolarMeister supplier product(s).`);
console.log(`Price candidates checked: ${priceCandidates}. Price writes: ${priceUpdates}. Price skips: ${priceSkipped}.`);
console.log(`Price mode: ${PRICE_DRY_RUN || DRY_RUN ? 'DRY RUN - no price writes' : 'LIVE - validated price writes enabled'}.`);
console.log(`Price rule: Balkonstrom x ${(1 + PRICE_MARKUP).toFixed(2)}, rounded to the nearest whole euro.`);

if (failures) {
  console.error(`${failures} product(s) could not be fully verified. Unverified changes were intentionally left unchanged.`);
  process.exitCode = 1;
} else {
  console.log('Balkonstrom sync complete. Availability is live. Price parity audit completed under the configured price mode.');
}
