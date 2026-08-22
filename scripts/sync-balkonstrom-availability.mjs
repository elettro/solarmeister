const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'f3yf3y-qu.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const DRY_RUN = process.env.DRY_RUN === '1';

if (!SHOPIFY_ADMIN_TOKEN) {
  console.error('Missing SHOPIFY_ADMIN_TOKEN. No Shopify changes were made.');
  process.exit(2);
}

// Availability is supplier-authoritative for SolarMeister dropship products.
// IMPORTANT: A fetch/parsing failure must NEVER be interpreted as sold out.
// Add additional mapped Balkonstrom products here as the synchronized catalog expands.
const PRODUCTS = [
  { solarHandle: 'anker-solix-solarbank-3-e2700-pro', sourceHandle: 'anker-solix-solarbank-3-e2700-pro' },
  { solarHandle: 'anker-solix-solarbank-4-e5000-pro', sourceHandle: 'anker-solix-solarbank-4-e5000-pro' },
  { solarHandle: 'anker-solix-solarbank-max-ac', sourceHandle: 'anker-solix-solarbank-max-ac' },
  { solarHandle: 'ecoflow-delta-pro-3-powerstation', sourceHandle: 'ecoflow-delta-pro-3' },
  { solarHandle: 'ecoflow-stream-ultra', sourceHandle: 'ecoflow-stream-ultra' },
  { solarHandle: 'ecoflow-stream-ultra-x', sourceHandle: 'ecoflow-stream-ultra-x' },
  { solarHandle: 'hoymiles-hibattery-4020-ac', sourceHandle: 'hoymiles-hibattery-4020-ac' },
  { solarHandle: 'hoymiles-hibattery-4020-x', sourceHandle: 'hoymiles-hibattery-4020-x' },
];

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'SolarMeister-Balkonstrom-Sync/1.0',
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

const FIND_PRODUCT = `
  query FindProduct($identifier: ProductIdentifierInput!) {
    productByIdentifier(identifier: $identifier) {
      id
      title
      handle
      variants(first: 250) {
        nodes { id title inventoryPolicy availableForSale inventoryQuantity }
      }
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

const report = [];
let failures = 0;

for (const mapping of PRODUCTS) {
  try {
    const supplier = await supplierAvailability(mapping.sourceHandle);
    const policy = supplier.available ? 'CONTINUE' : 'DENY';

    const data = await shopifyGraphQL(FIND_PRODUCT, { identifier: { handle: mapping.solarHandle } });
    const product = data.productByIdentifier;
    if (!product) throw new Error(`SolarMeister product not found: ${mapping.solarHandle}`);

    const variants = product.variants.nodes;
    const changed = variants.filter((variant) => variant.inventoryPolicy !== policy);

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
      supplier: supplier.available ? 'AVAILABLE' : 'SOLD_OUT',
      shopifyPolicy: policy,
      variantsChanged: changed.length,
      dryRun: DRY_RUN,
    });
  } catch (error) {
    failures += 1;
    // Fail safe: unknown supplier status preserves Shopify's last-known status.
    // Never convert an error into DENY / sold out.
    report.push({
      product: mapping.solarHandle,
      supplier: 'UNKNOWN',
      shopifyPolicy: 'UNCHANGED',
      variantsChanged: 0,
      error: error.message,
    });
  }
}

console.table(report);

if (failures) {
  console.error(`${failures} product(s) could not be verified. Their Shopify availability was intentionally left unchanged.`);
  process.exitCode = 1;
} else {
  console.log('Balkonstrom availability sync complete. Supplier availability is reflected in Shopify inventory policy.');
}
