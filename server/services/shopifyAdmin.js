import { getAdminClient } from "../utils/shopifyAdmin.js";
import { normalizePhoneE164 } from "./phone.js";

/**
 * Shopify Admin helpers used by attemptActions (tagging orders).
 * Routed through the normalized client in utils/shopifyAdmin.js so `admin.query(...)` always exists.
 */

export async function fetchOrderTags(admin, orderGid) {
  const query = `#graphql
    query($id: ID!) {
      order(id: $id) { id tags }
    }
  `;

  const res = await admin.query({ data: query, variables: { id: orderGid } });
  return res.body?.data?.order?.tags ?? [];
}

export async function appendOrderTag(admin, orderGid, tag) {
  return appendOrderTags(admin, orderGid, [tag]);
}

export async function appendOrderTags(admin, orderGid, newTags = []) {
  const incoming = Array.isArray(newTags) ? newTags : [newTags];
  const clean = incoming.map((t) => String(t || "").trim()).filter(Boolean);
  if (!clean.length) return;

  const mutation = `#graphql
    mutation AddOrderTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `;

  const res = await admin.query({
    data: mutation,
    variables: { id: orderGid, tags: Array.from(new Set(clean)) },
  });

  const errs = res.body?.data?.tagsAdd?.userErrors;
  if (errs?.length) throw new Error(errs.map((e) => e.message).join(", "));
}

export async function removeOrderTags(admin, orderGid, tagsToRemove = []) {
  const incoming = Array.isArray(tagsToRemove) ? tagsToRemove : [tagsToRemove];
  const removeSet = new Set(
    incoming.map((tag) => String(tag || "").trim()).filter(Boolean),
  );
  if (!removeSet.size) return;

  const mutation = `#graphql
    mutation RemoveOrderTags($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `;

  const res = await admin.query({
    data: mutation,
    variables: { id: orderGid, tags: Array.from(removeSet) },
  });

  const errs = res.body?.data?.tagsRemove?.userErrors;
  if (errs?.length) throw new Error(errs.map((e) => e.message).join(", "));
}

function normalizeSearchValue(value) {
  return String(value || "").trim();
}

function cleanFreeTextSearch(value) {
  const text = normalizeSearchValue(value);
  return text
    .replace(/[()"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildShopifyOrderSearchQuery(rawQuery) {
  const search = normalizeSearchValue(rawQuery);
  if (!search) return "status:any";

  const cleanSearch = cleanFreeTextSearch(search);
  if (!cleanSearch) return "status:any";

  const hasStructuredField = /\b[a-z_]+:/i.test(search);
  if (hasStructuredField) {
    return /\bstatus:/i.test(cleanSearch)
      ? cleanSearch
      : `status:any ${cleanSearch}`;
  }

  const orderNumberMatch = search.match(/^#?(\d+)$/);
  if (orderNumberMatch) {
    return `status:any name:#${orderNumberMatch[1]}`;
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(search)) {
    return `status:any email:${cleanSearch}`;
  }

  const digits = search.replace(/[^\d+]/g, "");
  if (/^\+?\d{7,15}$/.test(digits)) {
    const normalized = digits.startsWith("+")
      ? digits
      : `+${digits.replace(/^\+/, "")}`;
    return `status:any phone:${normalized}`;
  }

  return `status:any ${cleanSearch}`;
}

function summarizeOrderLineItems(node) {
  const edges = Array.isArray(node?.lineItems?.edges)
    ? node.lineItems.edges
    : [];
  return edges
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((line) => {
      const title = String(line?.title || "").trim();
      const variant = String(line?.variantTitle || "").trim();
      const quantity = Number(line?.quantity || 0);
      if (!title || !Number.isFinite(quantity) || quantity <= 0) return "";
      return `${title}${variant && variant !== "Default Title" ? ` (${variant})` : ""} x${Math.trunc(quantity)}`;
    })
    .filter(Boolean)
    .slice(0, 3);
}

function summarizeAbandonedCheckoutLineItems(node) {
  const edges = Array.isArray(node?.lineItems?.edges)
    ? node.lineItems.edges
    : [];
  return edges
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((line) => {
      const title = String(line?.title || "").trim();
      const variant = String(line?.variantTitle || "").trim();
      const quantity = Number(line?.quantity || 0);
      if (!title || !Number.isFinite(quantity) || quantity <= 0) return "";
      return `${title}${variant && variant !== "Default Title" ? ` (${variant})` : ""} x${Math.trunc(quantity)}`;
    })
    .filter(Boolean)
    .slice(0, 10);
}

function firstOrderLineImageUrl(node) {
  const edges = Array.isArray(node?.lineItems?.edges)
    ? node.lineItems.edges
    : [];
  for (const edge of edges) {
    const line = edge?.node || {};
    const productImageEdge =
      line?.product?.images?.edges?.[0]?.node?.url ||
      line?.product?.images?.nodes?.[0]?.url ||
      "";
    const variantProductImageEdge =
      line?.variant?.product?.images?.edges?.[0]?.node?.url ||
      line?.variant?.product?.images?.nodes?.[0]?.url ||
      "";
    const candidates = [
      line?.image?.url,
      line?.variant?.image?.url,
      line?.variant?.product?.featuredImage?.url,
      line?.variant?.product?.featuredMedia?.preview?.image?.url,
      variantProductImageEdge,
      line?.product?.featuredImage?.url,
      line?.product?.featuredMedia?.preview?.image?.url,
      productImageEdge,
    ];
    const match = candidates
      .map((value) => String(value || "").trim())
      .find((value) => /^https:\/\//i.test(value));
    if (match) return match;
  }
  return "";
}

function firstOrderLineProductUrl(node, shopUrl = "") {
  const edges = Array.isArray(node?.lineItems?.edges)
    ? node.lineItems.edges
    : [];
  const normalizedShopUrl = String(shopUrl || "").replace(/\/+$/, "");
  for (const edge of edges) {
    const line = edge?.node || {};
    const candidates = [
      line?.product?.onlineStoreUrl,
      line?.variant?.product?.onlineStoreUrl,
    ];
    const direct = candidates
      .map((value) => String(value || "").trim())
      .find((value) => /^https?:\/\//i.test(value));
    if (direct) return direct;

    const handle = String(
      line?.product?.handle || line?.variant?.product?.handle || "",
    ).trim();
    if (handle && /^https?:\/\//i.test(normalizedShopUrl)) {
      return `${normalizedShopUrl}/products/${encodeURIComponent(handle)}`;
    }
  }
  return "";
}

function isCodEligibleOrder(node) {
  const gateways = Array.isArray(node?.paymentGatewayNames)
    ? node.paymentGatewayNames
    : [];
  return gateways.some((gateway) => {
    const v = String(gateway || "").toLowerCase();
    return v.includes("cash") || v.includes("cod");
  });
}

function hasSchedulablePhone(node) {
  const rawPhone =
    String(node?.shippingAddress?.phone || "").trim() ||
    String(node?.billingAddress?.phone || "").trim() ||
    String(node?.customer?.phone || "").trim();
  const countryCode =
    String(node?.shippingAddress?.countryCode || "").trim() ||
    String(node?.billingAddress?.countryCode || "").trim() ||
    null;
  return Boolean(normalizePhoneE164(rawPhone, countryCode));
}

function hasAnyOrderPhone(node) {
  return Boolean(
    String(node?.shippingAddress?.phone || "").trim() ||
    String(node?.billingAddress?.phone || "").trim() ||
    String(node?.customer?.phone || "").trim(),
  );
}

function getGraphqlErrors(res) {
  const errors = Array.isArray(res?.body?.errors) ? res.body.errors : [];
  return errors
    .map((error) => {
      if (typeof error === "string") return error;
      return String(error?.message || "").trim();
    })
    .filter(Boolean);
}

export async function listShopifyOrders(admin, options = {}) {
  const first = Math.min(Math.max(Number(options?.first || 10), 1), 50);
  const after = String(options?.after || "").trim() || null;
  const query = buildShopifyOrderSearchQuery(options?.query);

  const gql = `#graphql
    query OrdersForBulkSchedule($first: Int!, $after: String, $query: String) {
      orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            paymentGatewayNames
            customer {
              displayName
              firstName
              lastName
              email
              phone
            }
            shippingAddress {
              phone
              countryCode
              name
            }
            billingAddress {
              phone
              countryCode
              name
            }
            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 3) {
              edges {
                node {
                  title
                  quantity
                  variantTitle
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }
  `;

  const res = await admin.query({
    data: gql,
    variables: { first, after, query },
  });

  const graphqlErrors = getGraphqlErrors(res);
  if (graphqlErrors.length) {
    throw new Error(graphqlErrors.join(", "));
  }

  const connection = res.body?.data?.orders || {};
  const items = Array.isArray(connection?.edges)
    ? connection.edges.map((edge) => {
        const node = edge?.node || {};
        const customer = node?.customer || {};
        const shippingAddress = node?.shippingAddress || {};
        const billingAddress = node?.billingAddress || {};
        const money = node?.currentTotalPriceSet?.shopMoney || {};
        const customerName =
          String(customer?.displayName || "").trim() ||
          [customer?.firstName, customer?.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          String(shippingAddress?.name || "").trim() ||
          String(billingAddress?.name || "").trim() ||
          "—";

        return {
          orderGid: String(node?.id || "").trim(),
          orderName: String(node?.name || "").trim(),
          createdAt: node?.createdAt || null,
          displayFinancialStatus: String(
            node?.displayFinancialStatus || "",
          ).trim(),
          displayFulfillmentStatus: String(
            node?.displayFulfillmentStatus || "",
          ).trim(),
          paymentGatewayNames: Array.isArray(node?.paymentGatewayNames)
            ? node.paymentGatewayNames
            : [],
          customerName,
          customerEmail: String(customer?.email || "").trim() || null,
          customerPhone: String(customer?.phone || "").trim() || null,
          shippingPhone: String(shippingAddress?.phone || "").trim() || null,
          billingPhone: String(billingAddress?.phone || "").trim() || null,
          countryCode:
            String(
              shippingAddress?.countryCode || billingAddress?.countryCode || "",
            ).trim() || null,
          amount: Number(money?.amount || 0) || null,
          currencyCode: String(money?.currencyCode || "").trim() || null,
          lineSummary: summarizeOrderLineItems(node),
          isCodOrder: isCodEligibleOrder(node),
          hasPhone: hasAnyOrderPhone(node),
          eligibleForOrderX: hasSchedulablePhone(node),
        };
      })
    : [];

  return {
    items,
    pageInfo: {
      hasNextPage: !!connection?.pageInfo?.hasNextPage,
      hasPreviousPage: !!connection?.pageInfo?.hasPreviousPage,
      startCursor: connection?.pageInfo?.startCursor || null,
      endCursor: connection?.pageInfo?.endCursor || null,
    },
    query,
  };
}

export async function listAbandonedCheckouts(admin, options = {}) {
  const first = Math.min(Math.max(Number(options?.first || 25), 1), 50);
  const after = String(options?.after || "").trim() || null;
  const query = String(options?.query || "").trim() || null;

  const gql = `#graphql
    query AbandonedCheckoutsForRecovery($first: Int!, $after: String, $query: String) {
      shop { name }
      abandonedCheckouts(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          cursor
          node {
            id
            name
            abandonedCheckoutUrl
            completedAt
            createdAt
            updatedAt
            customer {
              id
              firstName
              lastName
              email
              phone
            }
            billingAddress {
              name
              phone
              address1
              city
              zip
              countryCodeV2
            }
            shippingAddress {
              name
              phone
              address1
              city
              zip
              countryCodeV2
            }
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 10) {
              edges {
                node {
                  title
                  quantity
                  variantTitle
                  image {
                    url
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const res = await admin.query({
    data: gql,
    variables: { first, after, query },
  });

  const graphqlErrors = getGraphqlErrors(res);
  if (graphqlErrors.length) {
    throw new Error(graphqlErrors.join(", "));
  }

  const connection = res.body?.data?.abandonedCheckouts || {};
  const items = Array.isArray(connection?.edges)
    ? connection.edges.map((edge) => {
        const node = edge?.node || {};
        const customer = node?.customer || {};
        const shippingAddress = node?.shippingAddress || {};
        const billingAddress = node?.billingAddress || {};
        const money = node?.totalPriceSet?.shopMoney || {};
        const imageEdges = Array.isArray(node?.lineItems?.edges)
          ? node.lineItems.edges
          : [];
        const firstImageUrl = imageEdges
          .map((lineEdge) => String(lineEdge?.node?.image?.url || "").trim())
          .find(Boolean);
        const customerName =
          [customer?.firstName, customer?.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          String(shippingAddress?.name || "").trim() ||
          String(billingAddress?.name || "").trim() ||
          "Customer";
        return {
          id: String(node?.id || "").trim(),
          cursor: edge?.cursor || null,
          name: String(node?.name || "").trim() || null,
          shopName: String(res.body?.data?.shop?.name || "").trim() || null,
          checkoutUrl: String(node?.abandonedCheckoutUrl || "").trim() || null,
          completedAt: node?.completedAt || null,
          createdAt: node?.createdAt || null,
          updatedAt: node?.updatedAt || null,
          customerName,
          customerEmail: String(customer?.email || "").trim() || null,
          customerPhone: String(customer?.phone || "").trim() || null,
          shippingPhone: String(shippingAddress?.phone || "").trim() || null,
          billingPhone: String(billingAddress?.phone || "").trim() || null,
          countryCode:
            String(
              shippingAddress?.countryCodeV2 ||
                billingAddress?.countryCodeV2 ||
                "",
            ).trim() || null,
          amount: Number(money?.amount || 0) || null,
          currencyCode: String(money?.currencyCode || "").trim() || null,
          lineSummary: summarizeAbandonedCheckoutLineItems(node),
          productImageUrl: firstImageUrl || null,
          shippingAddress: {
            address1: String(shippingAddress?.address1 || "").trim() || null,
            city: String(shippingAddress?.city || "").trim() || null,
            zip: String(shippingAddress?.zip || "").trim() || null,
          },
        };
      })
    : [];

  return {
    items,
    pageInfo: {
      hasNextPage: !!connection?.pageInfo?.hasNextPage,
      endCursor: connection?.pageInfo?.endCursor || null,
    },
    query,
  };
}

export async function listOrdersForReviewRequests(admin, options = {}) {
  const first = Math.min(Math.max(Number(options?.first || 25), 1), 50);
  const after = String(options?.after || "").trim() || null;
  const query = String(options?.query || "").trim() || null;

  const gql = `#graphql
    query OrdersForReviewRequestPoll($first: Int!, $after: String, $query: String) {
      shop { name primaryDomain { url } myshopifyDomain }
      orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            updatedAt
            displayFinancialStatus
            displayFulfillmentStatus
            statusPageUrl
            customer {
              displayName
              firstName
              lastName
              email
              phone
            }
            shippingAddress {
              name
              phone
              address1
              city
              zip
              countryCode
            }
            billingAddress {
              name
              phone
              address1
              city
              zip
              countryCode
            }
            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 10) {
              edges {
                node {
                  title
                  quantity
                  variantTitle
                  image { url }
                  product { handle onlineStoreUrl featuredImage { url } }
                  variant {
                    image { url }
                    product { handle onlineStoreUrl featuredImage { url } }
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const res = await admin.query({
    data: gql,
    variables: { first, after, query },
  });

  const graphqlErrors = getGraphqlErrors(res);
  if (graphqlErrors.length) {
    throw new Error(graphqlErrors.join(", "));
  }

  const connection = res.body?.data?.orders || {};
  const shopUrl =
    String(res.body?.data?.shop?.primaryDomain?.url || "").trim() ||
    (res.body?.data?.shop?.myshopifyDomain
      ? `https://${String(res.body.data.shop.myshopifyDomain).trim()}`
      : "");
  const items = Array.isArray(connection?.edges)
    ? connection.edges.map((edge) => {
        const node = edge?.node || {};
        const customer = node?.customer || {};
        const shippingAddress = node?.shippingAddress || {};
        const billingAddress = node?.billingAddress || {};
        const money = node?.currentTotalPriceSet?.shopMoney || {};
        const customerName =
          String(customer?.displayName || "").trim() ||
          [customer?.firstName, customer?.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          String(shippingAddress?.name || "").trim() ||
          String(billingAddress?.name || "").trim() ||
          "Customer";

        return {
          id: String(node?.id || "").trim(),
          cursor: edge?.cursor || null,
          name: String(node?.name || "").trim() || null,
          shopName: String(res.body?.data?.shop?.name || "").trim() || null,
          createdAt: node?.createdAt || null,
          updatedAt: node?.updatedAt || null,
          displayFinancialStatus:
            String(node?.displayFinancialStatus || "").trim() || null,
          displayFulfillmentStatus:
            String(node?.displayFulfillmentStatus || "").trim() || null,
          customerName,
          customerEmail: String(customer?.email || "").trim() || null,
          customerPhone: String(customer?.phone || "").trim() || null,
          shippingPhone: String(shippingAddress?.phone || "").trim() || null,
          billingPhone: String(billingAddress?.phone || "").trim() || null,
          countryCode:
            String(
              shippingAddress?.countryCode || billingAddress?.countryCode || "",
            ).trim() || null,
          amount: Number(money?.amount || 0) || null,
          currencyCode: String(money?.currencyCode || "").trim() || null,
          lineSummary: summarizeOrderLineItems(node),
          productImageUrl: firstOrderLineImageUrl(node) || null,
          productUrl: firstOrderLineProductUrl(node, shopUrl) || null,
          statusPageUrl: String(node?.statusPageUrl || "").trim() || null,
          shippingAddress: {
            address1: String(shippingAddress?.address1 || "").trim() || null,
            city: String(shippingAddress?.city || "").trim() || null,
            zip: String(shippingAddress?.zip || "").trim() || null,
          },
        };
      })
    : [];

  return {
    items,
    pageInfo: {
      hasNextPage: !!connection?.pageInfo?.hasNextPage,
      endCursor: connection?.pageInfo?.endCursor || null,
    },
    query,
  };
}

export async function fetchOrderForCodConfirmTemplate(admin, orderGid) {
  const queryV2 = `#graphql
    query($id: ID!) {
      shop { name }
      order(id: $id) {
        id
        name
        createdAt
        tags
        displayFinancialStatus
        displayFulfillmentStatus
        paymentGatewayNames
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        currentSubtotalPriceSet { shopMoney { amount currencyCode } }
        totalShippingPriceSet { shopMoney { amount currencyCode } }
        customer {
          id
          displayName
          firstName
          lastName
          email
          phone
          tags
          createdAt
          numberOfOrders
          amountSpent { amount currencyCode }
        }
        shippingAddress {
          name
          firstName
          lastName
          company
          address1
          address2
          city
          province
          zip
          country
          countryCode
          phone
        }
        billingAddress {
          name
          countryCode
          phone
        }
        fulfillments {
          id
          trackingInfo {
            company
            number
            url
          }
        }
        lineItems(first: 50) {
          edges {
            node {
              id
              title
              quantity
              variantTitle
              image { url }
              product {
                handle
                onlineStoreUrl
                featuredImage { url }
                featuredMedia { preview { image { url } } }
                images(first: 1) { edges { node { url } } }
              }
              variant {
                image { url }
                product {
                  handle
                  onlineStoreUrl
                  featuredImage { url }
                  featuredMedia { preview { image { url } } }
                  images(first: 1) { edges { node { url } } }
                }
              }
              originalUnitPriceSet { shopMoney { amount currencyCode } }
              originalTotalSet { shopMoney { amount currencyCode } }
            }
          }
        }
      }
    }
  `;

  const queryLineImagesOnly = `#graphql
    query($id: ID!) {
      shop { name primaryDomain { url } myshopifyDomain }
      order(id: $id) {
        id
        name
        createdAt
        tags
        displayFinancialStatus
        displayFulfillmentStatus
        paymentGatewayNames
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        currentSubtotalPriceSet { shopMoney { amount currencyCode } }
        totalShippingPriceSet { shopMoney { amount currencyCode } }
        customer {
          displayName
          firstName
          lastName
          email
          phone
        }
        shippingAddress {
          name
          firstName
          lastName
          company
          address1
          address2
          city
          province
          zip
          country
          countryCode
          phone
        }
        billingAddress {
          name
          countryCode
          phone
        }
        fulfillments {
          id
          trackingInfo {
            company
            number
            url
          }
        }
        lineItems(first: 50) {
          edges {
            node {
              id
              title
              quantity
              variantTitle
              image { url }
              variant { image { url } }
              originalUnitPriceSet { shopMoney { amount currencyCode } }
              originalTotalSet { shopMoney { amount currencyCode } }
            }
          }
        }
      }
    }
  `;

  const queryV1 = `#graphql
    query($id: ID!) {
      shop { name primaryDomain { url } myshopifyDomain }
      order(id: $id) {
        id
        name
        createdAt
        tags
        displayFinancialStatus
        displayFulfillmentStatus
        paymentGatewayNames
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer {
          displayName
          firstName
          lastName
          email
          phone
        }
        shippingAddress {
          name
          firstName
          lastName
          company
          address1
          address2
          city
          province
          zip
          country
          countryCode
          phone
        }
        billingAddress {
          name
          countryCode
          phone
        }
        fulfillments {
          id
          trackingInfo {
            company
            number
            url
          }
        }
        lineItems(first: 50) {
          edges {
            node {
              id
              title
              quantity
              variantTitle
            }
          }
        }
      }
    }
  `;

  let res;
  try {
    res = await admin.query({ data: queryV2, variables: { id: orderGid } });
    const errors = getGraphqlErrors(res);
    if (errors.length) {
      res = await admin.query({
        data: queryLineImagesOnly,
        variables: { id: orderGid },
      });
      const fallbackErrors = getGraphqlErrors(res);
      if (fallbackErrors.length) {
        res = await admin.query({ data: queryV1, variables: { id: orderGid } });
      }
    }
  } catch {
    try {
      res = await admin.query({
        data: queryLineImagesOnly,
        variables: { id: orderGid },
      });
      const fallbackErrors = getGraphqlErrors(res);
      if (fallbackErrors.length) {
        res = await admin.query({ data: queryV1, variables: { id: orderGid } });
      }
    } catch {
      // Backward-compatible fallback if fields are unavailable on the API version in use.
      res = await admin.query({ data: queryV1, variables: { id: orderGid } });
    }
  }
  return {
    shopName: res.body?.data?.shop?.name ?? null,
    shopUrl:
      String(res.body?.data?.shop?.primaryDomain?.url || "").trim() ||
      (res.body?.data?.shop?.myshopifyDomain
        ? `https://${String(res.body.data.shop.myshopifyDomain).trim()}`
        : ""),
    order: res.body?.data?.order ?? null,
  };
}

export async function cancelOrderAsExpired(admin, orderGid) {
  const mutation = `#graphql
    mutation CancelExpiredOrder(
      $orderId: ID!
      $refundMethod: OrderCancelRefundMethodInput!
      $restock: Boolean!
      $reason: OrderCancelReason!
      $notifyCustomer: Boolean
      $staffNote: String
    ) {
      orderCancel(
        orderId: $orderId
        refundMethod: $refundMethod
        restock: $restock
        reason: $reason
        notifyCustomer: $notifyCustomer
        staffNote: $staffNote
      ) {
        job { id done }
        orderCancelUserErrors { field message code }
        userErrors { field message }
      }
    }
  `;

  const res = await admin.query({
    data: mutation,
    variables: {
      orderId: orderGid,
      refundMethod: { originalPaymentMethodsRefund: false },
      restock: true,
      reason: "OTHER",
      notifyCustomer: false,
      staffNote:
        "Cancelled by OrderX after no customer response within 48 hours.",
    },
  });

  const payload = res.body?.data?.orderCancel || {};
  const errs = [
    ...(Array.isArray(payload?.orderCancelUserErrors)
      ? payload.orderCancelUserErrors
      : []),
    ...(Array.isArray(payload?.userErrors) ? payload.userErrors : []),
  ];
  if (errs.length) {
    const message = errs
      .map((e) => e?.message)
      .filter(Boolean)
      .join(", ");
    const err = new Error(message || "Shopify orderCancel failed");
    err.meta = { errors: errs, payload };
    throw err;
  }

  return {
    ok: true,
    jobId: payload?.job?.id || null,
    jobDone: payload?.job?.done ?? null,
  };
}

function parseRequestedName(fullName) {
  const normalized = String(fullName || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return { firstName: null, lastName: null };
  const parts = normalized.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function normalizeAddressLine(text, maxLen = 240) {
  const normalized = String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.slice(0, maxLen);
}

function getOrderLineItems(order) {
  const edges = Array.isArray(order?.lineItems?.edges)
    ? order.lineItems.edges
    : [];
  return edges.map((e) => e?.node).filter(Boolean);
}

function normalizeRequestedQtyOverrides(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const byIndex = new Map();
  for (const row of rows) {
    const lineIndex = Number(row?.lineIndex);
    const quantity = Number(row?.quantity);
    if (
      !Number.isFinite(lineIndex) ||
      lineIndex < 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      continue;
    }
    byIndex.set(Math.trunc(lineIndex), {
      lineIndex: Math.trunc(lineIndex),
      quantity: Math.trunc(quantity),
    });
  }
  return Array.from(byIndex.values()).sort((a, b) => a.lineIndex - b.lineIndex);
}

function toCalculatedLineItemGid(lineItemGid) {
  const raw = String(lineItemGid || "").trim();
  if (!raw) return null;
  if (raw.includes("/CalculatedLineItem/")) return raw;
  if (raw.includes("/LineItem/")) {
    return raw.replace("/LineItem/", "/CalculatedLineItem/");
  }
  return null;
}

async function orderUpdateShippingAddress(
  admin,
  orderGid,
  shippingAddressInput,
) {
  const mutation = `#graphql
    mutation($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id }
        userErrors { field message }
      }
    }
  `;
  const res = await admin.query({
    data: mutation,
    variables: {
      input: { id: orderGid, shippingAddress: shippingAddressInput },
    },
  });
  const errs = res.body?.data?.orderUpdate?.userErrors;
  if (errs?.length) {
    throw new Error(errs.map((e) => e.message).join(", "));
  }
}

async function orderEditSetLineItemQuantity(
  admin,
  orderGid,
  lineItemId,
  quantity,
  { targetLineIndex = null } = {},
) {
  const beginMutation = `#graphql
    mutation($id: ID!) {
      orderEditBegin(id: $id) {
        calculatedOrder {
          id
          lineItems(first: 250) {
            edges {
              node { id }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;
  const beginRes = await admin.query({
    data: beginMutation,
    variables: { id: orderGid },
  });
  const beginPayload = beginRes.body?.data?.orderEditBegin;
  const beginErrs = beginPayload?.userErrors;
  if (beginErrs?.length) {
    throw new Error(beginErrs.map((e) => e.message).join(", "));
  }
  const calculatedOrderId = beginPayload?.calculatedOrder?.id;
  if (!calculatedOrderId) {
    throw new Error("Could not start order edit");
  }

  const calcEdges = Array.isArray(
    beginPayload?.calculatedOrder?.lineItems?.edges,
  )
    ? beginPayload.calculatedOrder.lineItems.edges
    : [];
  const idx = Number(targetLineIndex);
  let calculatedLineItemId =
    Number.isFinite(idx) && idx >= 0
      ? calcEdges[Math.trunc(idx)]?.node?.id || null
      : null;

  // Fallback: Shopify calculated line item IDs commonly map from LineItem IDs by type.
  if (!calculatedLineItemId) {
    calculatedLineItemId = toCalculatedLineItemGid(lineItemId);
  }
  if (!calculatedLineItemId) {
    throw new Error("Could not resolve calculated line item id");
  }

  const setQtyMutation = `#graphql
    mutation($id: ID!, $lineItemId: ID!, $quantity: Int!) {
      orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
        calculatedOrder { id }
        userErrors { field message }
      }
    }
  `;
  const setQtyRes = await admin.query({
    data: setQtyMutation,
    variables: {
      id: calculatedOrderId,
      lineItemId: calculatedLineItemId,
      quantity: Math.trunc(Number(quantity)),
    },
  });
  const setQtyErrs = setQtyRes.body?.data?.orderEditSetQuantity?.userErrors;
  if (setQtyErrs?.length) {
    throw new Error(setQtyErrs.map((e) => e.message).join(", "));
  }

  const commitMutation = `#graphql
    mutation($id: ID!) {
      orderEditCommit(id: $id) {
        order { id }
        userErrors { field message }
      }
    }
  `;
  const commitRes = await admin.query({
    data: commitMutation,
    variables: { id: calculatedOrderId },
  });
  const commitErrs = commitRes.body?.data?.orderEditCommit?.userErrors;
  if (commitErrs?.length) {
    throw new Error(commitErrs.map((e) => e.message).join(", "));
  }
}

/**
 * Best-effort order mutation for request-changes. Name/address are applied via orderUpdate
 * and quantity via Order Edit. Address is stored as a single free-text line in address1
 * because customer replies are unstructured.
 */
export async function applyRequestedChangesToOrder(
  admin,
  orderGid,
  requested = {},
) {
  const fetched = await fetchOrderForCodConfirmTemplate(admin, orderGid);
  const order = fetched?.order || null;
  if (!order) throw new Error("Order not found");

  const result = {
    ok: true,
    appliedFields: [],
    warnings: [],
  };

  const requestedName = String(requested?.name || "").trim();
  const requestedAddress = String(requested?.address || "").trim();
  const requestedQtyRaw = Number(requested?.quantity);
  const requestedQtyOverrides = normalizeRequestedQtyOverrides(
    requested?.quantityOverrides,
  );

  if (requestedName || requestedAddress) {
    const current = order?.shippingAddress || {};
    const shippingInput = {};

    // Preserve existing structured fields to minimize accidental data loss.
    for (const key of [
      "firstName",
      "lastName",
      "company",
      "address1",
      "address2",
      "city",
      "province",
      "zip",
      "country",
      "phone",
    ]) {
      const value = current?.[key];
      if (typeof value === "string" && value.trim()) {
        shippingInput[key] = value.trim();
      }
    }

    if (requestedName) {
      const parsed = parseRequestedName(requestedName);
      if (parsed.firstName) shippingInput.firstName = parsed.firstName;
      const parsedLastName = String(parsed.lastName ?? "").trim();
      if (parsedLastName) {
        shippingInput.lastName = parsedLastName;
      } else {
        const existingLast = String(shippingInput.lastName || "").trim();
        if (existingLast) {
          // Preserve existing last name if customer provided a single-word name.
          shippingInput.lastName = existingLast;
          result.warnings.push("name_last_name_preserved");
        } else if (parsed.firstName) {
          // Shopify may require a non-empty lastName on shippingAddress.
          shippingInput.lastName = parsed.firstName;
          result.warnings.push("name_last_name_duplicated_for_validation");
        }
      }
      result.appliedFields.push("name");
    }

    if (requestedAddress) {
      const normalizedAddress = normalizeAddressLine(requestedAddress);
      if (!normalizedAddress) {
        result.warnings.push("address_empty");
      } else {
        // We cannot safely parse free text into full structured address fields,
        // so store it on address1 and preserve existing city/province/country fields.
        shippingInput.address1 = normalizedAddress;
        result.appliedFields.push("address");
      }
    }

    if (
      result.appliedFields.includes("name") ||
      result.appliedFields.includes("address")
    ) {
      await orderUpdateShippingAddress(admin, orderGid, shippingInput);
    }
  }

  const qtyChanges =
    requestedQtyOverrides.length > 0
      ? requestedQtyOverrides
      : Number.isFinite(requestedQtyRaw) && requestedQtyRaw > 0
        ? [
            {
              lineIndex: requested?.quantityLineIndex,
              quantity: requestedQtyRaw,
            },
          ]
        : [];

  for (const qtyChange of qtyChanges) {
    const items = getOrderLineItems(order);
    let targetLineIndex = Number(qtyChange?.lineIndex);
    if (!Number.isFinite(targetLineIndex)) {
      targetLineIndex = items.length === 1 ? 0 : NaN;
    }
    targetLineIndex = Math.trunc(targetLineIndex);

    if (!(targetLineIndex >= 0 && targetLineIndex < items.length)) {
      result.warnings.push("qty_target_missing");
    } else {
      const targetLine = items[targetLineIndex];
      const lineItemId = String(targetLine?.id || "").trim();
      if (!lineItemId) {
        result.warnings.push("qty_line_item_id_missing");
      } else {
        const currentQty = Number(targetLine?.quantity);
        const nextQty = Math.trunc(Number(qtyChange?.quantity));
        if (Number.isFinite(currentQty) && currentQty === nextQty) {
          result.warnings.push("qty_unchanged");
        } else {
          await orderEditSetLineItemQuantity(
            admin,
            orderGid,
            lineItemId,
            nextQty,
            {
              targetLineIndex,
            },
          );
          if (!result.appliedFields.includes("quantity")) {
            result.appliedFields.push("quantity");
          }
        }
      }
    }
  }

  return result;
}

// Re-export normalized admin client for any legacy imports
export { getAdminClient };
