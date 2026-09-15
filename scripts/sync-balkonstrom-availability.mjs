import { writeFile } from 'node:fs/promises';

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'f3yf3y-qu.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const DRY_RUN = process.env.DRY_RUN === '1';
const PRICE_DRY_RUN = process.env.PRICE_DRY_RUN !== '0';
const PRICE_MARKUP = Number(process.env.PRICE_MARKUP || '0.17');
const MAX_PRICE_CHANGE_RATIO = Number(process.env.MAX_PRICE_CHANGE_RATIO || '0.50');
const REPORT_PATH = process.env.SYNC_REPORT_PATH || 'sync-report.json';
const SUPPLIER_MIN_REQUEST_INTERVAL_MS = Number(process.env.SUPPLIER_MIN_REQUEST_INTERVAL_MS || '900');
const SUPPLIER_MAX_RETRIES = Number(process.env.SUPPLIER_MAX_RETRIES || '5');
const SUPPLIER_RETRY_BASE_MS = Number(process.env.SUPPLIER_RETRY_BASE_MS || '2000');
const SUPPLIER_RETRY_MAX_MS = Number(process.env.SUPPLIER_RETRY_MAX_MS || '30000');

if (!SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing SHOPIFY_ADMIN_TOKEN. No Shopify changes were made.');
  process.exit(2);
}

if (!Number.isFinite(PRICE_MARKUP) || PRICE_MARKUP < 0) {
  console.error(`Invalid PRICE_MARKUP: ${process.env.PRICE_MARKUP}`);
  process.exit(2);
}

const SOURCE_HANDLE_OVERRIDES = new Map([
  ['ecoflow-delta-pro-3-powerstation', 'ecoflow-delta-pro-3'],
]);

const GENERIC_PRODUCT_TOKENS = new Set([
  'mit', 'und', 'oder', 'der', 'die', 'das', 'ein', 'eine', 'set', 'pro', 'premium', 'basic',
  'bifazial', 'balkon', 'balcony', 'solarmeister', 'komplett', 'komplettset', 'inkl', 'inklusive',
]);

class SourceProductRemovedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SourceProductRemovedError';
    this.code = 'SOURCE_REMOVED';
    Object.assign(this, details);
  }
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

function normalizeProductTitle(value) {
  return normalizeText(value)
    .replace(/[®™]/g, '')
    .replace(/\s*[-–—]\s*/g, ' ')
    .replace(/[^a-z0-9äöüß.+/ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVariantTitle(value) {
  return normalizeText(value)
    .replace(/\(\s*\+?\s*\d+(?:[.,]\d+)?\s*€\s*\)/g, ' ')
    .replace(/\bzusatzspeicher\b/g, 'zusatzbatterie')
    .replace(/\berweiterungsspeicher\b/g, 'zusatzbatterie')
    .replace(/\bzusatzakku\b/g, 'zusatzbatterie')
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9äöüß.+/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactVariantTitle(value) {
  return normalizeVariantTitle(value)
    .replace(/\b(kwh|kw|wh|watt|meter|metern)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function productTokens(value) {
  return normalizeProductTitle(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !GENERIC_PRODUCT_TOKENS.has(token));
}

function identityTokens(value) {
  return [...new Set(productTokens(value).filter((token) =>
    /[a-zäöüß]\d|\d[a-zäöüß]/i.test(token) || /^\d{3,}(?:\.\d+)?$/.test(token)
  ))];
}

function safeTitleSimilarity(targetTitle, candidateTitle) {
  const target = [...new Set(productTokens(targetTitle))];
  const candidate = new Set(productTokens(candidateTitle));
  if (!target.length) return 0;
  const overlap = target.filter((token) => candidate.has(token)).length;
  return overlap / target.length;
}

function extractVariantConfiguration(value) {
  const text = normalizeVariantTitle(value);
  const models = [...new Set(text.match(/\b[a-z]{1,12}\d[a-z0-9-]*\b/gi) || [])].map((v) => v.toLowerCase());
  let quantity = null;
  const quantityMatch = text.match(/(?:^|\s)(\d+)\s*x\s+[a-z0-9]/i);
  if (quantityMatch) quantity = Number(quantityMatch[1]);
  if (quantity === null && /\bohne\s+(?:zusatz)?(?:batterie|speicher|akku)\b/.test(text)) quantity = 0;
  const capacities = [...new Set((text.match(/\b\d+(?:\.\d+)?\s*kwh\b/g) || []).map((v) => v.replace(/\s+/g, '')))];
  return { models, quantity, capacities };
}

function configurationMatches(target, candidate) {
  if (target.models.length) {
    const candidateModels = new Set(candidate.models);
    if (!target.models.every((model) => candidateModels.has(model))) return false;
  }
  if (target.quantity !== null && candidate.quantity !== target.quantity) return false;
  if (target.capacities.length && candidate.capacities.length) {
    const candidateCapacities = new Set(candidate.capacities);
    if (!target.capacities.some((capacity) => candidateCapacities.has(capacity))) return false;
  }
  return target.models.length > 0 || target.quantity !== null || target.capacities.length > 0;
}

function roundMarkedUpPriceToWholeEuro(sourcePriceCents) {
  if (!Number.isInteger(sourcePriceCents) || sourcePriceCents <= 0) {
    throw new Error(`Invalid supplier price in cents: ${sourcePriceCents}`);
  }
  return Math.round((sourcePriceCents / 100) * (1 + PRICE_MARKUP));
}

function shopifyPriceToEuros(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function matchSupplierVariant(shopifyVariant, supplierVariants) {
  if (supplierVariants.length === 1) return { variant: supplierVariants[0], method: 'ONLY_VARIANT' };

  const shopifySku = String(shopifyVariant.sku || '').trim();
  const strippedSku = shopifySku.replace(/^SM-/i, '');
  if (shopifySku) {
    const skuMatches = supplierVariants.filter((variant) => {
      const supplierSku = String(variant.sku || '').trim();
      return supplierSku && (supplierSku === shopifySku || supplierSku === strippedSku);
    });
    if (skuMatches.length === 1) return { variant: skuMatches[0], method: 'SKU' };
  }

  const exactTitle = normalizeText(shopifyVariant.title);
  if (exactTitle) {
    const matches = supplierVariants.filter((variant) => normalizeText(variant.title) === exactTitle);
    if (matches.length === 1) return { variant: matches[0], method: 'EXACT_TITLE' };
  }

  const canonicalTitle = normalizeVariantTitle(shopifyVariant.title);
  if (canonicalTitle) {
    const matches = supplierVariants.filter((variant) => normalizeVariantTitle(variant.title) === canonicalTitle);
    if (matches.length === 1) return { variant: matches[0], method: 'CANONICAL_TITLE' };
  }

  const compactTitle = compactVariantTitle(shopifyVariant.title);
  if (compactTitle) {
    const matches = supplierVariants.filter((variant) => compactVariantTitle(variant.title) === compactTitle);
    if (matches.length === 1) return { variant: matches[0], method: 'COMPACT_TITLE' };
  }

  const targetConfig = extractVariantConfiguration(shopifyVariant.title);
  const configMatches = supplierVariants.filter((variant) =>
    configurationMatches(targetConfig, extractVariantConfiguration(variant.title))
  );
  if (configMatches.length === 1) return { variant: configMatches[0], method: 'CONFIGURATION' };

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let nextSupplierRequestAt = 0;
async function throttleSupplierRequest() {
  const waitMs = Math.max(0, nextSupplierRequestAt - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  nextSupplierRequestAt = Date.now() + SUPPLIER_MIN_REQUEST_INTERVAL_MS;
}

function retryAfterMs(response) {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const retryAt = Date.parse(raw);
  if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  return null;
}

function shouldRetrySupplierStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchJson(url) {
  let lastError = null;
  for (let attempt = 0; attempt <= SUPPLIER_MAX_RETRIES; attempt += 1) {
    await throttleSupplierRequest();
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'SolarMeister-Balkonstrom-Sync/1.6',
          accept: 'application/json,text/javascript,*/*;q=0.8',
        },
        redirect: 'follow',
      });
      if (response.ok) return response.json();

      const error = new Error(`HTTP ${response.status} for ${url}`);
      error.httpStatus = response.status;
      lastError = error;
      if (!shouldRetrySupplierStatus(response.status) || attempt >= SUPPLIER_MAX_RETRIES) throw error;

      const exponentialDelay = Math.min(SUPPLIER_RETRY_BASE_MS * (2 ** attempt), SUPPLIER_RETRY_MAX_MS);
      const waitMs = Math.max(retryAfterMs(response) || 0, exponentialDelay);
      console.warn(`Balkonstrom HTTP ${response.status}. Retry ${attempt + 1}/${SUPPLIER_MAX_RETRIES} in ${waitMs}ms: ${url}`);
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      const status = Number(error.httpStatus || String(error.message || '').match(/^HTTP (\d+)/)?.[1] || 0) || null;
      if (status !== null || attempt >= SUPPLIER_MAX_RETRIES) throw error;
      const waitMs = Math.min(SUPPLIER_RETRY_BASE_MS * (2 ** attempt), SUPPLIER_RETRY_MAX_MS);
      console.warn(`Balkonstrom request error. Retry ${attempt + 1}/${SUPPLIER_MAX_RETRIES} in ${waitMs}ms: ${error.message}`);
      await sleep(waitMs);
    }
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

function extractHandleFromUrl(url) {
  const match = String(url || '').match(/\/products\/([^/?#]+)/i);
  return match ? match[1] : null;
}

async function searchSupplierProducts(productTitle) {
  const params = new URLSearchParams({
    q: productTitle,
    'resources[type]': 'product',
    'resources[limit]': '10',
  });
  const payload = await fetchJson(`https://www.balkonstrom.com/search/suggest.json?${params.toString()}`);
  const results = payload?.resources?.results?.products;
  return Array.isArray(results) ? results : [];
}

async function resolveSupplierHandleByTitle(productTitle) {
  const results = await searchSupplierProducts(productTitle);
  if (!results.length) return null;

  const normalizedTarget = normalizeProductTitle(productTitle);
  const exactMatches = results.filter((item) => normalizeProductTitle(item.title) === normalizedTarget);
  if (exactMatches.length === 1) {
    return { handle: extractHandleFromUrl(exactMatches[0].url), method: 'TITLE_SEARCH_EXACT', title: exactMatches[0].title };
  }

  const targetIdentity = identityTokens(productTitle);
  const scored = results
    .map((item) => ({
      item,
      score: safeTitleSimilarity(productTitle, item.title),
      identityOk: targetIdentity.every((token) => productTokens(item.title).includes(token)),
    }))
    .filter((entry) => entry.identityOk && entry.score >= 0.72)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 || (scored.length > 1 && scored[0].score >= scored[1].score + 0.15)) {
    return { handle: extractHandleFromUrl(scored[0].item.url), method: 'TITLE_SEARCH_SAFE_RENAME', title: scored[0].item.title };
  }

  return null;
}

async function supplierProduct(requestedHandle, productTitle) {
  let sourceHandle = requestedHandle;
  let url = `https://www.balkonstrom.com/products/${sourceHandle}.js`;
  let product;
  let resolutionMethod = 'HANDLE';

  try {
    product = await fetchJson(url);
  } catch (error) {
    const status = Number(error.httpStatus || String(error.message || '').match(/^HTTP (\d+)/)?.[1] || 0);
    if (status !== 404) throw error;

    const resolved = await resolveSupplierHandleByTitle(productTitle);
    if (!resolved?.handle || resolved.handle === sourceHandle) {
      throw new SourceProductRemovedError(`Balkonstrom no longer exposes a safely matching product for ${productTitle}`, {
        requestedHandle,
      });
    }

    sourceHandle = resolved.handle;
    url = `https://www.balkonstrom.com/products/${sourceHandle}.js`;
    product = await fetchJson(url);
    resolutionMethod = resolved.method;
    console.log(`Resolved Balkonstrom product: ${requestedHandle} -> ${sourceHandle} (${resolutionMethod})`);
  }

  if (!product || !Array.isArray(product.variants) || product.variants.length === 0) {
    throw new Error(`No variants returned by Balkonstrom for ${sourceHandle}`);
  }

  const available = product.variants.some((variant) => variant.available === true);
  const explicitlyUnavailable = product.variants.every((variant) => variant.available === false);
  if (!available && !explicitlyUnavailable) throw new Error(`Unknown Balkonstrom availability for ${sourceHandle}`);

  return {
    available,
    url,
    sourceHandle,
    sourceTitle: String(product.title || sourceHandle).trim(),
    resolutionMethod,
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
        id title handle status
        variants(first: 250) {
          nodes { id title sku price inventoryPolicy availableForSale inventoryQuantity }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const UPDATE_PRODUCT = `
  mutation UpdateSupplierProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title handle status }
      userErrors { field message code }
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
      title status
      variants(first: 250) { nodes { id price inventoryPolicy } }
    }
  }
`;

async function updateProduct(productId, input) {
  if (DRY_RUN) return null;
  const data = await shopifyGraphQL(UPDATE_PRODUCT, { product: { id: productId, ...input } });
  const errors = data.productUpdate.userErrors || [];
  if (errors.length) throw new Error(`Shopify productUpdate errors: ${JSON.stringify(errors)}`);
  return data.productUpdate.product;
}

async function listSupplierProducts() {
  const products = [];
  let after = null;
  do {
    const data = await shopifyGraphQL(LIST_PRODUCTS, { first: 100, after });
    const connection = data.products;
    for (const product of connection.nodes) {
      const isSupplierProduct = product.variants.nodes.some((variant) =>
        typeof variant.sku === 'string' && variant.sku.startsWith('SM-')
      );
      if (isSupplierProduct) products.push(product);
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return products;
}

async function fetchSupplierCatalog() {
  const catalog = [];
  for (let page = 1; page <= 20; page += 1) {
    const payload = await fetchJson(`https://www.balkonstrom.com/products.json?limit=250&page=${page}`);
    const batch = Array.isArray(payload?.products) ? payload.products : [];
    for (const product of batch) catalog.push({ handle: product.handle, title: product.title });
    if (batch.length < 250) break;
  }
  return catalog;
}

const report = [];
let failures = 0;
let archivedProducts = 0;
let renamedProducts = 0;
let priceCandidates = 0;
let priceUpdates = 0;
let priceSkipped = 0;
const matchedSupplierHandles = new Set();
const products = await listSupplierProducts();

for (const product of products) {
  const requestedSourceHandle = SOURCE_HANDLE_OVERRIDES.get(product.handle) || product.handle;

  try {
    const supplier = await supplierProduct(requestedSourceHandle, product.title);
    const sourceHandle = supplier.sourceHandle;
    matchedSupplierHandles.add(sourceHandle);

    if (supplier.sourceTitle && supplier.sourceTitle !== product.title) {
      await updateProduct(product.id, { title: supplier.sourceTitle });
      renamedProducts += 1;
      report.push({
        product: product.title,
        newProductTitle: supplier.sourceTitle,
        sourceHandle,
        sourceResolution: supplier.resolutionMethod,
        check: 'CATALOG',
        status: DRY_RUN ? 'WOULD_RENAME' : 'TITLE_CHANGED',
      });
    }

    const policy = supplier.available ? 'CONTINUE' : 'DENY';
    const updatesById = new Map();

    for (const variant of product.variants.nodes) {
      if (variant.inventoryPolicy !== policy) {
        updatesById.set(variant.id, { id: variant.id, inventoryPolicy: policy });
      }

      const matched = matchSupplierVariant(variant, supplier.variants);
      const supplierVariant = matched?.variant || null;
      const currentPrice = shopifyPriceToEuros(variant.price);

      if (!supplierVariant) {
        priceSkipped += 1;
        report.push({ product: supplier.sourceTitle || product.title, variant: variant.title, sourceHandle, sourceResolution: supplier.resolutionMethod, check: 'PRICE', status: 'SKIP_UNMATCHED_VARIANT', currentPrice });
        continue;
      }

      const sourcePriceCents = Number(supplierVariant.price);
      if (!Number.isInteger(sourcePriceCents) || sourcePriceCents <= 0) {
        priceSkipped += 1;
        report.push({ product: supplier.sourceTitle || product.title, variant: variant.title, sourceHandle, sourceResolution: supplier.resolutionMethod, variantMatch: matched.method, check: 'PRICE', status: 'SKIP_INVALID_SOURCE_PRICE', sourcePriceCents, currentPrice });
        continue;
      }

      const sourcePrice = sourcePriceCents / 100;
      const targetPrice = roundMarkedUpPriceToWholeEuro(sourcePriceCents);
      priceCandidates += 1;

      if (currentPrice === null) {
        priceSkipped += 1;
        report.push({ product: supplier.sourceTitle || product.title, variant: variant.title, sourceHandle, sourceResolution: supplier.resolutionMethod, variantMatch: matched.method, check: 'PRICE', status: 'SKIP_INVALID_SHOPIFY_PRICE', sourcePrice, targetPrice, currentPrice: variant.price });
        continue;
      }

      const differenceRatio = Math.abs(targetPrice - currentPrice) / currentPrice;
      if (differenceRatio > MAX_PRICE_CHANGE_RATIO) {
        priceSkipped += 1;
        report.push({ product: supplier.sourceTitle || product.title, variant: variant.title, sourceHandle, sourceResolution: supplier.resolutionMethod, variantMatch: matched.method, check: 'PRICE', status: 'SKIP_SUSPICIOUS_CHANGE', sourcePrice, currentPrice, targetPrice, differencePct: `${(differenceRatio * 100).toFixed(1)}%` });
        continue;
      }

      if (Math.abs(currentPrice - targetPrice) < 0.005) {
        report.push({ product: supplier.sourceTitle || product.title, variant: variant.title, sourceHandle, sourceResolution: supplier.resolutionMethod, variantMatch: matched.method, check: 'PRICE', status: 'PARITY_OK', sourcePrice, currentPrice, targetPrice });
        continue;
      }

      if (PRICE_DRY_RUN || DRY_RUN) {
        report.push({ product: supplier.sourceTitle || product.title, variant: variant.title, sourceHandle, sourceResolution: supplier.resolutionMethod, variantMatch: matched.method, check: 'PRICE', status: 'WOULD_UPDATE', sourcePrice, currentPrice, targetPrice });
      } else {
        const pending = updatesById.get(variant.id) || { id: variant.id };
        pending.price = targetPrice.toFixed(2);
        updatesById.set(variant.id, pending);
        report.push({ product: supplier.sourceTitle || product.title, variant: variant.title, sourceHandle, sourceResolution: supplier.resolutionMethod, variantMatch: matched.method, check: 'PRICE', status: 'UPDATE_QUEUED', sourcePrice, currentPrice, targetPrice });
      }
    }

    const updates = [...updatesById.values()];
    if (!DRY_RUN && updates.length) {
      const updated = await shopifyGraphQL(UPDATE_VARIANTS, { productId: product.id, variants: updates });
      const errors = updated.productVariantsBulkUpdate.userErrors || [];
      if (errors.length) throw new Error(`Shopify mutation errors: ${JSON.stringify(errors)}`);

      if (!PRICE_DRY_RUN && updates.some((item) => item.price)) {
        const verified = await shopifyGraphQL(VERIFY_PRODUCT, { id: product.id });
        const variants = verified.product?.variants?.nodes || [];
        const byId = new Map(variants.map((variant) => [variant.id, variant]));
        for (const update of updates.filter((item) => item.price)) {
          const actual = byId.get(update.id)?.price;
          if (actual !== update.price) throw new Error(`Price verification failed for ${update.id}: expected ${update.price}, got ${actual}`);
          priceUpdates += 1;
        }
      }
    }

    report.push({
      product: supplier.sourceTitle || product.title,
      sourceHandle,
      requestedSourceHandle,
      sourceResolution: supplier.resolutionMethod,
      check: 'AVAILABILITY',
      supplier: supplier.available ? 'AVAILABLE' : 'SOLD_OUT',
      shopifyPolicy: policy,
      variantsChanged: product.variants.nodes.filter((variant) => variant.inventoryPolicy !== policy).length,
      dryRun: DRY_RUN,
    });
  } catch (error) {
    if (error?.code === 'SOURCE_REMOVED') {
      try {
        await updateProduct(product.id, { status: 'ARCHIVED' });
        archivedProducts += 1;
        report.push({
          product: product.title,
          sourceHandle: requestedSourceHandle,
          check: 'CATALOG',
          status: DRY_RUN ? 'WOULD_ARCHIVE_SOURCE_REMOVED' : 'SOURCE_REMOVED_ARCHIVED',
          shopifyPolicy: 'ARCHIVED',
          error: error.message,
        });
        console.warn(`${DRY_RUN ? 'Would archive' : 'Archived'} source-removed product: ${product.title}`);
      } catch (archiveError) {
        failures += 1;
        report.push({ product: product.title, sourceHandle: requestedSourceHandle, check: 'PRODUCT', status: 'FAILED_ARCHIVE', supplier: 'MISSING', shopifyPolicy: 'UNCHANGED', error: archiveError.message });
      }
      continue;
    }

    failures += 1;
    report.push({ product: product.title, sourceHandle: requestedSourceHandle, check: 'PRODUCT', status: 'FAILED', supplier: 'UNKNOWN', shopifyPolicy: 'UNCHANGED', error: error.message });
  }
}

let supplierCatalog = [];
try {
  supplierCatalog = await fetchSupplierCatalog();
  for (const item of supplierCatalog) {
    if (!item.handle || matchedSupplierHandles.has(item.handle)) continue;
    report.push({
      product: item.title,
      sourceHandle: item.handle,
      check: 'CATALOG',
      status: 'NEW_SOURCE_PRODUCT',
      action: 'REVIEW_FOR_IMPORT',
    });
  }
} catch (error) {
  report.push({ check: 'CATALOG', status: 'SUPPLIER_CATALOG_SCAN_FAILED', error: error.message });
}

const inventoryUpdates = report.filter((item) => item.check === 'AVAILABILITY').reduce((sum, item) => sum + Number(item.variantsChanged || 0), 0);
const priceWouldUpdate = report.filter((item) => item.status === 'WOULD_UPDATE').length;
const priceParity = report.filter((item) => item.status === 'PARITY_OK').length;
const newSupplierProducts = report.filter((item) => item.status === 'NEW_SOURCE_PRODUCT').length;
const questionable = report.filter((item) => item.status === 'FAILED' || item.status === 'FAILED_ARCHIVE' || item.status === 'SUPPLIER_CATALOG_SCAN_FAILED' || String(item.status || '').startsWith('SKIP_'));
const changes = report.filter((item) => ['WOULD_UPDATE', 'UPDATE_QUEUED', 'TITLE_CHANGED', 'WOULD_RENAME', 'SOURCE_REMOVED_ARCHIVED', 'WOULD_ARCHIVE_SOURCE_REMOVED', 'NEW_SOURCE_PRODUCT'].includes(item.status) || (item.check === 'AVAILABILITY' && Number(item.variantsChanged || 0) > 0));

const structuredReport = {
  generatedAt: new Date().toISOString(),
  store: SHOPIFY_STORE_DOMAIN,
  source: 'https://www.balkonstrom.com',
  catalogPolicy: {
    supplierIsSourceOfTruth: true,
    renameFromSupplier: true,
    removedSupplierProducts: 'ARCHIVE',
    newSupplierProducts: 'REPORT_FOR_IMPORT',
  },
  pricing: {
    markupPercent: PRICE_MARKUP * 100,
    roundingRule: 'nearest whole euro',
    maxPriceChangePercent: MAX_PRICE_CHANGE_RATIO * 100,
    mode: PRICE_DRY_RUN || DRY_RUN ? 'DRY_RUN' : 'LIVE',
  },
  supplierRequestPolicy: {
    minRequestIntervalMs: SUPPLIER_MIN_REQUEST_INTERVAL_MS,
    maxRetries: SUPPLIER_MAX_RETRIES,
    retryBaseMs: SUPPLIER_RETRY_BASE_MS,
    retryMaxMs: SUPPLIER_RETRY_MAX_MS,
  },
  summary: {
    productsChecked: products.length,
    supplierCatalogProducts: supplierCatalog.length,
    renamedProducts,
    archivedProducts,
    newSupplierProducts,
    inventoryUpdates,
    priceCandidates,
    priceUpdates,
    priceWouldUpdate,
    priceSkipped,
    priceParity,
    failures,
    needReview: questionable.length,
    noActionNeeded: questionable.length === 0,
  },
  questionable,
  changes,
  details: report,
};

await writeFile(REPORT_PATH, `${JSON.stringify(structuredReport, null, 2)}\n`, 'utf8');
console.log(`Structured report written to ${REPORT_PATH}.`);
console.table(report);
console.log(`Checked ${products.length} active SolarMeister supplier product(s).`);
console.log(`Catalog lifecycle: ${renamedProducts} renamed, ${archivedProducts} archived because source removed, ${newSupplierProducts} new supplier product(s) flagged.`);
console.log(`Price candidates checked: ${priceCandidates}. Price writes: ${priceUpdates}. Price skips: ${priceSkipped}.`);
console.log(`Price mode: ${PRICE_DRY_RUN || DRY_RUN ? 'DRY RUN - no price writes' : 'LIVE - validated price writes enabled'}.`);
console.log(`Price rule: Balkonstrom x ${(1 + PRICE_MARKUP).toFixed(2)}, rounded to the nearest whole euro.`);
console.log(`Supplier request policy: ${SUPPLIER_MIN_REQUEST_INTERVAL_MS}ms minimum interval, up to ${SUPPLIER_MAX_RETRIES} retries with backoff.`);

if (failures) {
  console.error(`${failures} product(s) could not be safely reconciled. Unverified changes were intentionally left unchanged.`);
  process.exitCode = 1;
} else {
  console.log('Balkonstrom catalog reconciliation complete. Availability and catalog lifecycle are live. Price parity remains under the configured price mode.');
}
