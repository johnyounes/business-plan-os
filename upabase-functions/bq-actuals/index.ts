// ════════════════════════════════════════════════════════════════════
// Supabase Edge Function: bq-actuals
// Supplies live "actuals" data for the BPOS tracker (bpos-tracking.html).
//
// Data source: BigQuery project `api-data-pull-492404`, dataset `buildium_data`
//              — same source as bq-dashboard. (Previously this function pointed
//              at the PointGuard `versatile-hull-395101` project; that source
//              is no longer used.)
//
// Secret:      GOOGLE_SERVICE_ACCOUNT_DASHBOARD  (reused from bq-dashboard —
//              already has BigQuery Data Viewer + Job User on api-data-pull-492404)
//
// Deploy:      supabase functions deploy bq-actuals --no-verify-jwt
//
// Supported request types — these are the ONLY three the tracker frontend calls:
//   1. { type: 'portfolio_summary',   year, month }   → per-property P&L for that month
//   2. { type: 'portfolio_occupancy' }                → current per-property occupancy
//   3. { type: 'property_units',      property }      → unit list for one property
//
// Response envelope is always { rows: [...], count: N } on success,
// or { error: "..." } with status 400 on failure.
//
// Output column names below are aliased to match EXACTLY what bpos-tracking.html
// reads (e.g., applyBQActuals, refreshAllActuals, renderUnitTrackerSection).
// Do not rename these without updating the tracker in lock-step.
// ════════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const PROJECT_ID = "api-data-pull-492404";
const DATASET    = "buildium_data";
const T          = `\`${PROJECT_ID}.${DATASET}`;

/* ── Base64url helpers ─────────────────────────────────── */
function b64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str: string): string {
  return b64url(new TextEncoder().encode(str));
}
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ── Google OAuth2 via Service Account JWT ─────────────── */
async function getAccessToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlStr(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/bigquery.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );

  const jwt = `${header}.${claims}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json();
  if (!data.access_token) throw new Error("Auth failed: " + JSON.stringify(data));
  return data.access_token;
}

/* ── BigQuery Query Runner ─────────────────────────────── */
async function runQuery(token: string, sql: string): Promise<any[]> {
  let allRows: any[] = [];
  let pageToken: string | undefined;

  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/queries`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        maxResults: 10000,
      }),
    },
  );

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const schema = data.schema;
  const fields = (schema?.fields || []).map((f: any) => f.name);

  const mapRows = (rows: any[]) =>
    rows.map((row: any) =>
      Object.fromEntries(fields.map((f: string, i: number) => [f, row.f[i].v])),
    );

  allRows = mapRows(data.rows || []);
  pageToken = data.pageToken;

  while (pageToken) {
    const jobId = data.jobReference?.jobId;
    const pageRes = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/queries/${jobId}?pageToken=${pageToken}&maxResults=10000`,
      { headers: { "Authorization": `Bearer ${token}` } },
    );
    const pageData = await pageRes.json();
    if (pageData.error) throw new Error(pageData.error.message);
    allRows = allRows.concat(mapRows(pageData.rows || []));
    pageToken = pageData.pageToken;
  }

  return allRows;
}

/* ── SQL builders ──────────────────────────────────────── */

// 1. portfolio_summary — per-property P&L for a given year/month.
//    Source view: v_income_statement_snapshot (same view bq-dashboard reads
//    for its P&L Detail tab — guaranteed to exist).
//
//    Column aliases match what applyBQActuals() in bpos-tracking.html reads:
//      PropertyName, Date, TotalIncome, TotalExpense, NetIncome,
//      RentIncome (aliased to total_income — Buildium doesn't split rent vs fee
//      income at the snapshot level; applyBQActuals only stores this for display),
//      CAPEX (= capital_improvements),
//      TotalNonOperating (= capital_improvements + mortgage_payment — Buildium's
//      two primary non-op buckets that are reliably exposed by this view).
function sqlPortfolioSummary(year: number, month: number): string {
  return `
    SELECT
      property_name                                                        AS PropertyName,
      CAST(snapshot_month AS STRING)                                       AS Date,
      total_income                                                         AS TotalIncome,
      total_expenses                                                       AS TotalExpense,
      net_income                                                           AS NetIncome,
      total_income                                                         AS RentIncome,
      capital_improvements                                                 AS CAPEX,
      (COALESCE(capital_improvements, 0) + COALESCE(mortgage_payment, 0))  AS TotalNonOperating
    FROM ${T}.v_income_statement_snapshot\`
    WHERE EXTRACT(YEAR  FROM snapshot_month) = ${year}
      AND EXTRACT(MONTH FROM snapshot_month) = ${month}
    ORDER BY property_name
  `;
}

// 2. portfolio_occupancy — current per-property occupancy snapshot.
//    Source view: v_occupancy_snapshot_summary (taking the latest snapshot_month),
//    joined to v_lease_expirations for the 30/60-day counters.
//
//    Column aliases match what refreshAllActuals() in bpos-tracking.html reads:
//      PropertyName, TotalUnits, Occupied, Vacant, MakeReady, Available,
//      Preleased, OccupancyPct, LeasesExpiring30d, LeasesExpiring60d
//
//    Notes:
//      - MakeReady is not tracked in Buildium's snapshot view, returned as 0.
//      - Available is aliased to vacant_units (Buildium treats non-preleased
//        vacant units as "available"). If you later need a distinction, swap
//        to vacant_units - preleased_units or add a dedicated column.
function sqlPortfolioOccupancy(): string {
  return `
    WITH latest AS (
      SELECT MAX(snapshot_month) AS m
      FROM ${T}.v_occupancy_snapshot_summary\`
    ),
    exp_counts AS (
      SELECT
        property_name,
        COUNTIF(days_until_expiry BETWEEN 0 AND 30) AS exp_30d,
        COUNTIF(days_until_expiry BETWEEN 0 AND 60) AS exp_60d
      FROM ${T}.v_lease_expirations\`
      GROUP BY property_name
    )
    SELECT
      s.property_name                                  AS PropertyName,
      s.total_units                                    AS TotalUnits,
      s.occupied_units                                 AS Occupied,
      s.vacant_units                                   AS Vacant,
      0                                                AS MakeReady,
      s.vacant_units                                   AS Available,
      COALESCE(s.preleased_units, 0)                   AS Preleased,
      ROUND(COALESCE(s.physical_occupancy_pct, 0), 2)  AS OccupancyPct,
      COALESCE(ec.exp_30d, 0)                          AS LeasesExpiring30d,
      COALESCE(ec.exp_60d, 0)                          AS LeasesExpiring60d
    FROM ${T}.v_occupancy_snapshot_summary\` s
    CROSS JOIN latest l
    LEFT JOIN exp_counts ec
      ON ec.property_name = s.property_name
    WHERE s.snapshot_month = l.m
    ORDER BY s.property_name
  `;
}

// 3. property_units — per-unit list for a single property.
//    Source views:
//      v_rent_roll  → occupied units (lease_rent, lease_to_date, market_rent, bedrooms)
//      v_vacancy    → vacant / preleased units (days_vacant, is_preleased)
//    The two are UNIONed so the tracker's renderUnitTrackerSection sees a flat list.
//
//    Column aliases match what renderUnitTrackerSection() in bpos-tracking.html reads:
//      PropertyName, UnitNumber, FloorPlan, Status, DaysVacant, TurnStatus,
//      MarketRent, AgroMeterRent, LeaseEndDate, SignedRent
//
//    Notes:
//      - FloorPlan is derived from bedrooms (e.g., "2BR") since Buildium doesn't
//        expose a named floor plan. If you later import floor plan labels from
//        PropUp, swap this out.
//      - TurnStatus is returned as NULL — lives in propup_data.turnovers, out of
//        scope for this swap. The tracker renders a blank column when missing.
//      - AgroMeterRent is returned as NULL — that field lives in your manual
//        Google Sheet, not BigQuery. The frontend handles NULL gracefully.
//      - Property match is a case-insensitive substring LIKE on property_name,
//        so "Cordes" will find "504-604 Cordes - KC" etc.
function sqlPropertyUnits(propertySearch: string): string {
  // Escape single quotes for BigQuery SQL literal. Restrict length as a guardrail.
  const escaped = propertySearch.replace(/'/g, "''").slice(0, 200);
  return `
    (
      SELECT
        property_name                                                AS PropertyName,
        CAST(unit_number AS STRING)                                  AS UnitNumber,
        CONCAT(CAST(COALESCE(bedrooms, 0) AS STRING), 'BR')          AS FloorPlan,
        'Occupied'                                                   AS Status,
        0                                                            AS DaysVacant,
        CAST(NULL AS STRING)                                         AS TurnStatus,
        market_rent                                                  AS MarketRent,
        CAST(NULL AS FLOAT64)                                        AS AgroMeterRent,
        CAST(lease_to_date AS STRING)                                AS LeaseEndDate,
        lease_rent                                                   AS SignedRent
      FROM ${T}.v_rent_roll\`
      WHERE LOWER(property_name) LIKE LOWER('%${escaped}%')
    )
    UNION ALL
    (
      SELECT
        property_name                                                AS PropertyName,
        CAST(unit_number AS STRING)                                  AS UnitNumber,
        CONCAT(CAST(COALESCE(bedrooms, 0) AS STRING), 'BR')          AS FloorPlan,
        CASE WHEN is_preleased THEN 'Preleased' ELSE 'Vacant' END    AS Status,
        COALESCE(days_vacant, 0)                                     AS DaysVacant,
        CAST(NULL AS STRING)                                         AS TurnStatus,
        market_rent                                                  AS MarketRent,
        CAST(NULL AS FLOAT64)                                        AS AgroMeterRent,
        CAST(NULL AS STRING)                                         AS LeaseEndDate,
        CAST(NULL AS FLOAT64)                                        AS SignedRent
      FROM ${T}.v_vacancy\`
      WHERE LOWER(property_name) LIKE LOWER('%${escaped}%')
    )
    ORDER BY Status, UnitNumber
  `;
}

/* ── Edge Function Handler ─────────────────────────────── */
serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Reuse the dashboard's service account — it already has BigQuery access
    // to api-data-pull-492404. No new secret required.
    const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_DASHBOARD");
    if (!saJson) {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_DASHBOARD secret not set. " +
        "Set it to the same JSON key the bq-dashboard function uses.",
      );
    }

    const sa = JSON.parse(saJson);
    if (!sa.client_email) throw new Error("Invalid service account JSON");

    const body = await req.json().catch(() => ({}));
    const type = String(body?.type || "");

    let sql: string;

    if (type === "portfolio_summary") {
      const year  = parseInt(body.year, 10);
      const month = parseInt(body.month, 10);
      if (!Number.isInteger(year)  || year  < 2000 || year  > 2100) {
        throw new Error("Invalid or missing 'year' (expected integer 2000-2100)");
      }
      if (!Number.isInteger(month) || month < 1    || month > 12) {
        throw new Error("Invalid or missing 'month' (expected integer 1-12)");
      }
      sql = sqlPortfolioSummary(year, month);
    } else if (type === "portfolio_occupancy") {
      sql = sqlPortfolioOccupancy();
    } else if (type === "property_units") {
      const property = String(body.property || "").trim();
      if (!property) throw new Error("Missing 'property' param");
      sql = sqlPropertyUnits(property);
    } else {
      throw new Error(
        `Unknown query type: '${type}'. ` +
        `Valid types: portfolio_summary, portfolio_occupancy, property_units`,
      );
    }

    const token = await getAccessToken(sa);
    const rows  = await runQuery(token, sql);

    return new Response(JSON.stringify({ rows, count: rows.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
