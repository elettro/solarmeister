const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'f3yf3y-qu.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const DRY_RUN = process.env.DRY_RUN === '1';

if (!SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing SHOPIFY_ADMIN_TOKEN. No Shopify changes were made.');
  process.exit(2);
}

// Balkonstrom is the availability source of truth for SolarMeister supplier products.
// Supplier products are identified by SolarMeister SKUs beginning with "SM-".
// Most cloned products retain the same Shopify product handle as Balkonstrom.
// Only genuine handle differences belong in this override map.
const SOURCE_HANDLE_OVERRIDES = new Map([
  ['ecoflow-delta-pro-3-powerstation', 'ecoflow-delta-pro-3'],
]);

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'SolarMeister-Balkonstrom-Sync/1.1',
      accept: 'application/json,text/javascript,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function supplierAvailability(sourceHandle) {
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

  return { available, url, sourceTitle: product.title || sourceHandle };
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
          nodes { id title sku inventoryPolicy availableForSale inventoryQuantity }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const UPDATE_VARIANTS = `
  mutation SetAvailability($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id inventoryPolicy availableForSale inventoryQuantity }
      userErrors { field message code }
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
const products = await listSupplierProducts();

for (const product of products) {
  const sourceHandle = SOURCE_HANDLE_OVERRIDES.get(product.handle) || product.handle;

  try {
    const supplier = await supplierAvailability(sourceHandle);
    const policy = supplier.available ? 'CONTINUE' : 'DENY';
    const changed = product.variants.nodes.filter((variant) => variant.inventoryPolicy !== policy);

    if (!DRY_RUN && changed.length) {
      const updated = await shopifyGraphQL(UPDATE_VARIANTS, {
        productId: product.id,
        variants: changed.map((variant) => ({ id: variant.id, inventoryPolicy: policy })),
      });
      const errors = updated.productVariantsBulkUpdate.userErrors || [];
      if (errors.length) throw new Error(`Shopify mutation errors: ${JSON.stringify(errors)}`);
    }

    report.push({
      product: product.title,
      sourceHandle,
      supplier: supplier.available ? 'AVAILABLE' : 'SOLD_OUT',
      shopifyPolicy: policy,
      variantsChanged: changed.length,
      dryRun: DRY_RUN,
    });
  } catch (error) {
    failures += 1;

    // FAIL SAFE:
    // A source lookup error, timeout, CAPTCHA, parser change, 404, or ambiguous result
    // must never become a SolarMeister "Ausverkauft" state. Preserve last-known Shopify status.
    report.push({
      product: product.title,
      sourceHandle,
      supplier: 'UNKNOWN',
      shopifyPolicy: 'UNCHANGED',
      variantsChanged: 0,
      error: error.message,
    });
  }
}

console.table(report);
console.log(`Checked ${products.length} active SolarMeister supplier product(s).`);

if (failures) {
  console.error(`${failures} product(s) could not be verified. Their Shopify availability was intentionally left unchanged.`);
  process.exitCode = 1;
} else {
  console.log('Balkonstrom availability sync complete. Supplier availability is reflected in Shopify inventory policy.');
}
