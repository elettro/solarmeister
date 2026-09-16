const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'f3yf3y-qu.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const STOREFRONT_BASE_URL = process.env.STOREFRONT_BASE_URL || 'https://solarmeister-shop.de';
const MODE = String(process.env.TEST10_MODE || 'preview').toLowerCase();
const LIVE_CONFIRMATION = process.env.TEST10_CONFIRM || '';
const PRICE_MARKUP = Number(process.env.PRICE_MARKUP || '0.17');
const MAX_PRICE_CHANGE_RATIO = Number(process.env.MAX_PRICE_CHANGE_RATIO || '0.50');
const TEST_PRODUCT_LIMIT = 10;
const STRONG_MATCH_METHODS = new Set(['ONLY_VARIANT', 'SKU', 'EXACT_TITLE']);

if (!SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing SHOPIFY_ADMIN_TOKEN. No Shopify changes were made.');
  process.exit(2);
}
if (!['preview', 'live'].includes(MODE)) {
  console.error(`Invalid TEST10_MODE: ${MODE}`);
  process.exit(2);
}
if (MODE === 'live' && LIVE_CONFIRMATION !== 'WRITE 10') {
  console.error('LIVE mode blocked. Enter exactly WRITE 10 in the confirmation input.');
  process.exit(2);
}
if (!Number.isFinite(PRICE_MARKUP) || PRICE_MARKUP < 0) {
  console.error(`Invalid PRICE_MARKUP: ${process.env.PRICE_MARKUP}`);
  process.exit(2);
}
if (!Number.isFinite(MAX_PRICE_CHANGE_RATIO) || MAX_PRICE_CHANGE_RATIO < 0) {
  console.error(`Invalid MAX_PRICE_CHANGE_RATIO: ${process.env.MAX_PRICE_CHANGE_RATIO}`);
  process.exit(2);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[×]/g, 'x')
    .replace(/\s+/g, ' ');
}

function shopifyPriceToEuros(price) {
  const value = Number(price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function roundTarget(sourcePriceCents) {
  return Math.round((sourcePriceCents / 100) * (1 + PRICE_MARKUP));
}

function strongVariantMatch(shopifyVariant, supplierVariants) {
  if (supplierVariants.length === 1) {
    return { variant: supplierVariants[0], method: 'ONLY_VARIANT' };
  }

  const shopifySku = String(shopifyVariant.sku || '').trim();
  const strippedSku = shopifySku.replace(/^SM-/i, '');
  if (shopifySku) {
    const skuMatches = supplierVariants.filter((variant) => {
      const supplierSku = String(variant.sku || '').trim();
      return supplierSku && (supplierSku === shopifySku || supplierSku === strippedSku);
    });
    if (skuMatches.length === 1) return { variant: skuMatches[0], method: 'SKU' };
  }

  const title = normalizeText(shopifyVariant.title);
  if (title) {
    const titleMatches = supplierVariants.filter((variant) => normalizeText(variant.title) === title);
    if (titleMatches.length === 1) return { variant: titleMatches[0], method: 'EXACT_TITLE' };
  }

  return null;
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
  query Test10Products($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      nodes {
        id title handle
        variants(first: 250) {
          nodes { id title sku price }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const UPDATE_VARIANTS = `
  mutation Test10PriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;

const VERIFY_PRODUCT = `
  query VerifyTest10Product($id: ID!) {
    product(id: $id) {
      variants(first: 250) { nodes { id price } }
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
      if (product.variants.nodes.some((variant) => String(variant.sku || '').startsWith('SM-'))) {
        products.push(product);
      }
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return products.sort((a, b) => a.handle.localeCompare(b.handle, 'de'));
}

async function fetchSupplierProduct(handle) {
  const url = `https://www.balkonstrom.com/products/${handle}.js`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'SolarMeister-Balkonstrom-Test10/1.0',
      accept: 'application/json,text/javascript,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Balkonstrom HTTP ${response.status} for ${url}`);
  const product = await response.json();
  if (!product || !Array.isArray(product.variants) || !product.variants.length) return null;
  return product;
}

async function buildCandidate(product) {
  const supplier = await fetchSupplierProduct(product.handle);
  if (!supplier) return null;

  const variants = [];
  for (const shopifyVariant of product.variants.nodes) {
    const matched = strongVariantMatch(shopifyVariant, supplier.variants);
    if (!matched || !STRONG_MATCH_METHODS.has(matched.method)) return null;

    const sourcePriceCents = Number(matched.variant.price);
    const currentPrice = shopifyPriceToEuros(shopifyVariant.price);
    if (!Number.isInteger(sourcePriceCents) || sourcePriceCents <= 0 || currentPrice === null) return null;

    const sourcePrice = sourcePriceCents / 100;
    const targetPrice = roundTarget(sourcePriceCents);
    const differenceRatio = Math.abs(targetPrice - currentPrice) / currentPrice;
    if (differenceRatio > MAX_PRICE_CHANGE_RATIO) return null;

    variants.push({
      id: shopifyVariant.id,
      title: shopifyVariant.title,
      sku: shopifyVariant.sku,
      match: matched.method,
      sourcePrice,
      currentPrice,
      targetPrice,
      needsUpdate: Math.abs(currentPrice - targetPrice) >= 0.005,
    });
  }

  if (!variants.some((variant) => variant.needsUpdate)) return null;

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    solarMeisterUrl: `${STOREFRONT_BASE_URL}/products/${product.handle}`,
    balkonstromUrl: `https://www.balkonstrom.com/products/${product.handle}`,
    variants,
  };
}

const products = await listSupplierProducts();
const selected = [];
for (const product of products) {
  if (selected.length >= TEST_PRODUCT_LIMIT) break;
  try {
    const candidate = await buildCandidate(product);
    if (candidate) selected.push(candidate);
  } catch (error) {
    console.warn(`Skipped ${product.handle}: ${error.message}`);
  }
}

if (selected.length < TEST_PRODUCT_LIMIT) {
  console.error(`Safety stop: only ${selected.length} products met all TEST 10 requirements. Need exactly ${TEST_PRODUCT_LIMIT}. No price writes were made.`);
  process.exit(2);
}

console.log('\n=== TEST 10 PRODUCT MANIFEST ===');
selected.forEach((product, index) => {
  console.log(`\n${index + 1}. ${product.title}`);
  console.log(`SolarMeister: ${product.solarMeisterUrl}`);
  console.log(`Balkonstrom:  ${product.balkonstromUrl}`);
  for (const variant of product.variants) {
    console.log(`  - ${variant.title} | ${variant.match} | Balkonstrom €${variant.sourcePrice.toFixed(2)} | Current €${variant.currentPrice.toFixed(2)} | Target €${variant.targetPrice.toFixed(2)}${variant.needsUpdate ? '' : ' | PARITY'}`);
  }
});
console.log('\nSafety rules: direct supplier handle only, ONLY_VARIANT/SKU/EXACT_TITLE only, +17% markup, whole-euro rounding, 50% max change.');

if (MODE === 'preview') {
  console.log('\nPREVIEW complete. ZERO prices were written. Re-run this workflow with mode=live and confirmation=WRITE 10 only after reviewing this manifest.');
  process.exit(0);
}

let verifiedWrites = 0;
for (const product of selected) {
  const updates = product.variants
    .filter((variant) => variant.needsUpdate)
    .map((variant) => ({ id: variant.id, price: variant.targetPrice.toFixed(2) }));

  if (!updates.length) continue;

  const data = await shopifyGraphQL(UPDATE_VARIANTS, { productId: product.id, variants: updates });
  const errors = data.productVariantsBulkUpdate.userErrors || [];
  if (errors.length) throw new Error(`Shopify mutation errors for ${product.handle}: ${JSON.stringify(errors)}`);

  const verify = await shopifyGraphQL(VERIFY_PRODUCT, { id: product.id });
  const actualById = new Map((verify.product?.variants?.nodes || []).map((variant) => [variant.id, variant.price]));
  for (const update of updates) {
    const actual = actualById.get(update.id);
    if (actual !== update.price) {
      throw new Error(`Post-write verification failed for ${product.handle} ${update.id}: expected ${update.price}, got ${actual}`);
    }
    verifiedWrites += 1;
  }
  console.log(`Verified ${product.handle}: ${updates.length} variant price write(s).`);
}

console.log(`\nTEST 10 LIVE complete: ${selected.length} products, ${verifiedWrites} verified variant price write(s).`);
console.log('No descriptions, images, product titles, availability policies, or products outside the selected 10 were changed by this test script.');
