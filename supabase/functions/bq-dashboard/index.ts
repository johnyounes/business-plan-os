// Supabase Edge Function: bq-dashboard
// Connects to BigQuery project api-data-pull-492404 (buildium_data dataset)
// Deploy: supabase functions deploy bq-dashboard
// Secret: supabase secrets set GOOGLE_SERVICE_ACCOUNT_DASHBOARD="$(cat service_account.json)"

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const PROJECT_ID = 'api-data-pull-492404';
const DATASET = 'buildium_data';

/* ── Base64url helpers ─────────────────────────────────── */
function b64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str: string): string {
  return b64url(new TextEncoder().encode(str));
}
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ── Google OAuth2 via Service Account JWT ─────────────── */
async function getAccessToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlStr(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claims}`)
  );

  const jwt = `${header}.${claims}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('Auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

/* ── Type coercion ─────────────────────────────────────
   The BigQuery REST API returns EVERY scalar as a string:
     INT64  -> "1"        FLOAT64/NUMERIC -> "1234.56"
     BOOL   -> "true"/"false"   (note: the string "false" is TRUTHY in JS)
     TIMESTAMP -> epoch seconds in scientific notation, e.g. "1.787581951107356E9"
                  (new Date("1.78e9") === Invalid Date)
   Historically each of these was patched one field at a time in the dashboard,
   which is why the same class of bug kept coming back. We now coerce centrally,
   driven by the schema BigQuery returns with the result, so every consumer gets
   real numbers, real booleans and ISO date strings. Add a column to a view and
   it is typed correctly with no client change.
   ────────────────────────────────────────────────────── */
function makeCoercer(fields: any[]): (name: string, raw: any) => any {
  const kind: Record<string, string> = {};
  for (const f of fields || []) {
    const t = String(f.type || f.Type || '').toUpperCase();
    if (f.mode === 'REPEATED' || t === 'RECORD' || t === 'STRUCT') { kind[f.name] = 'RAW'; continue; }
    if (t === 'INTEGER' || t === 'INT64') kind[f.name] = 'INT';
    else if (t === 'FLOAT' || t === 'FLOAT64' || t === 'NUMERIC' || t === 'BIGNUMERIC' || t === 'DECIMAL') kind[f.name] = 'NUM';
    else if (t === 'BOOLEAN' || t === 'BOOL') kind[f.name] = 'BOOL';
    else if (t === 'TIMESTAMP') kind[f.name] = 'TS';
    else kind[f.name] = 'STR';   // STRING, DATE, DATETIME, TIME, BYTES — pass through
  }
  return (name: string, raw: any) => {
    if (raw === null || raw === undefined) return null;
    switch (kind[name]) {
      case 'INT': {
        const n = Number(raw);
        // Values beyond 2^53 lose precision as JS numbers — keep those as strings
        // rather than silently corrupting an id.
        return Number.isSafeInteger(n) ? n : raw;
      }
      case 'NUM': {
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      }
      case 'BOOL':
        return raw === true || raw === 'true' || raw === 'TRUE' || raw === '1';
      case 'TS': {
        // epoch seconds (often scientific notation) -> ISO 8601
        const secs = Number(raw);
        if (!Number.isFinite(secs)) return raw;
        const d = new Date(secs * 1000);
        return isNaN(d.getTime()) ? raw : d.toISOString();
      }
      case 'RAW':
        return raw;
      default:
        return raw;
    }
  };
}

/* ── BigQuery Query Runner ─────────────────────────────── */
async function runQuery(token: string, sql: string): Promise<any[]> {
  let allRows: any[] = [];

  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}`;
  const authHeaders = { 'Authorization': `Bearer ${token}` };

  // Initial query. timeoutMs is the time BigQuery waits before returning a
  // not-yet-complete response; the default is only 10s, and when it elapses the
  // response carries jobComplete:false with NO rows and NO pageToken. The previous
  // implementation treated that as a legitimately empty result, so any query that
  // ran long silently rendered as zeros in the dashboard. We now ask for a longer
  // wait and, if it is still incomplete, poll getQueryResults until it finishes.
  const res = await fetch(`${base}/queries`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      maxResults: 10000,
      timeoutMs: 45000,
    }),
  });

  let data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const jobId = data.jobReference?.jobId;
  const location = data.jobReference?.location;
  const locParam = location ? `&location=${encodeURIComponent(location)}` : '';

  // Poll until the job reports complete.
  let waited = 0;
  while (data.jobComplete === false) {
    if (!jobId) throw new Error('BigQuery job did not complete and returned no jobReference');
    if (waited > 240000) throw new Error(`BigQuery query timed out after ${Math.round(waited / 1000)}s`);
    await new Promise((r) => setTimeout(r, 2000));
    waited += 2000;
    const pollRes = await fetch(
      `${base}/queries/${jobId}?maxResults=10000&timeoutMs=45000${locParam}`,
      { headers: authHeaders }
    );
    data = await pollRes.json();
    if (data.error) throw new Error(data.error.message);
  }

  const fields = data.schema?.fields || [];
  const names: string[] = fields.map((f: any) => f.name);
  const coerce = makeCoercer(fields);

  const mapRows = (rows: any[]) =>
    rows.map((row: any) =>
      Object.fromEntries(
        names.map((n, i) => [n, coerce(n, row.f?.[i]?.v ?? null)])
      )
    );

  allRows = mapRows(data.rows || []);
  let pageToken: string | undefined = data.pageToken;

  // Paginate if needed
  while (pageToken) {
    const pageRes = await fetch(
      `${base}/queries/${jobId}?pageToken=${encodeURIComponent(pageToken)}&maxResults=10000${locParam}`,
      { headers: authHeaders }
    );
    const pageData = await pageRes.json();
    if (pageData.error) throw new Error(pageData.error.message);
    allRows = allRows.concat(mapRows(pageData.rows || []));
    pageToken = pageData.pageToken;
  }

  return allRows;
}

/* ── Query Definitions ─────────────────────────────────── */
const T = `\`${PROJECT_ID}.${DATASET}`;

const QUERIES: Record<string, string> = {
  // Portfolio-level occupancy (one row per property)
  occupancy_summary: `SELECT * FROM ${T}.v_occupancy_summary\` ORDER BY property_name`,

  // Full rent roll (one row per occupied unit)
  rent_roll: `SELECT * FROM ${T}.v_rent_roll\` ORDER BY property_name, unit_number`,

  // Vacant units
  vacancy: `SELECT * FROM ${T}.v_vacancy\` ORDER BY property_name, days_vacant DESC`,

  // Lease expirations with urgency buckets
  lease_expirations: `SELECT * FROM ${T}.v_lease_expirations\` ORDER BY days_until_expiry ASC`,

  // Stale leases (data quality)
  stale_leases: `SELECT * FROM ${T}.v_stale_leases\` ORDER BY days_since_expired DESC`,

  // Bedroom mix with average rents
  // CRITICAL: Never use rental_units.is_occupied (Rule #1) — derive from Active non-stale lease joins
  bedroom_mix: `
    SELECT
      ru.bedrooms,
      COUNT(*) as total_units,
      COUNTIF(l.lease_id IS NOT NULL AND l.is_stale = FALSE) as occupied_units,
      ROUND(AVG(ru.market_rent), 0) as avg_market_rent,
      ROUND(AVG(CASE WHEN l.rent_amount > 0 THEN l.rent_amount END), 0) as avg_actual_rent
    FROM ${T}.rental_units\` ru
    LEFT JOIN ${T}.leases\` l
      ON ru.unit_id = l.unit_id AND l.lease_status = 'Active' AND l.is_stale = FALSE
    GROUP BY ru.bedrooms
    ORDER BY total_units DESC
  `,

  // Monthly occupancy trends (15 months of snapshots).
  // Source of truth for historical physical + preleased occupancy and unit counts.
  // Economic occupancy is NOT on this view — it lives on v_economic_occupancy
  // (see the `economic_occupancy` query below).
  // Uses SELECT * so the query can't be broken by column renames/removals in the view —
  // previously we explicitly listed `vacant_units` which had been dropped, causing the
  // whole query to error and the dashboard to fall back to live-only occupancy.
  occupancy_snapshot_summary: `
    SELECT *
    FROM ${T}.v_occupancy_snapshot_summary\`
    ORDER BY property_name, snapshot_month
  `,

  // NOI summary: income, expenses, NOI, non-operating per property per month
  // Note: v_noi_summary uses property_name, not property_id
  noi_summary: `
    SELECT
      property_name,
      units,
      month,
      total_income,
      total_expenses,
      noi,
      non_operating,
      ROUND(noi + non_operating, 2) as net_income,
      ROUND(CASE WHEN total_income > 0 THEN total_expenses / total_income ELSE NULL END, 4) as expense_ratio
    FROM ${T}.v_noi_summary\`
    ORDER BY property_name, month DESC
  `,

  // NOTE: the `income_statement` type was removed on 2026-08-24.
  // It selected from `buildium_data.v_income_statement`, a view that does not exist
  // ("Not found: Table ... was not found in location US"), so every call returned
  // HTTP 400. Nothing in the app referenced it. Use `income_statement_snapshot`
  // (below) for per-property income/expense/NOI, or re-add this type once the
  // v_income_statement view is actually created.

  // Income statement snapshot — SOURCE OF TRUTH for operating Income / Expenses / NOI / Expense Ratio
  // Post-2026-04-13 fix: total_income and total_expenses are OPERATING-ONLY.
  // Non-operating items (mortgage, capital improvements, AMF, parent-co expenses) are
  // broken out into their own columns so the dashboard can show them separately.
  // Expense Ratio = total_expenses / total_income (both operating-only).
  // Uses SELECT * to stay resilient to column additions/renames in the view. We additionally
  // alias snapshot_month → month so dashboard code works regardless of which name it expects.
  income_statement_snapshot: `
    SELECT v.*, v.snapshot_month AS month
    FROM ${T}.v_income_statement_snapshot\` v
    ORDER BY v.property_name, v.snapshot_month
  `,

  // Properties list with unit counts
  properties: `
    SELECT property_id, t12_name, api_name, units, is_active
    FROM ${T}.properties\`
    WHERE is_active = TRUE
    ORDER BY t12_name
  `,

  // Financial detail (all accounts by property by month) for P&L table
  financial_summary: `
    SELECT
      property_id, property_name, snapshot_month,
      account_name, t12_section, sub_type,
      total_amount, transaction_count
    FROM ${T}.financial_snapshots\`
    ORDER BY property_name, snapshot_month, t12_section, account_name
  `,

  // PropUp unit turns with cross-system mapping + step schedule dates.
  // Aliases match what bpos-dashboard.html expects:
  //   board_name → board, unit_name → unit_number, date_move_out → move_out_date,
  //   turnover_start_date → start_date, date_available → end_date
  // Initial Walk / Final Walk dates come from turn_step_schedules (one LEFT JOIN each).
  turns: `
    SELECT
      t.turnover_id,
      t.board_name                  AS board,
      t.unit_name                   AS unit_number,
      t.property_name               AS propup_property_name,
      t.unit_type,
      t.square_footage,
      t.finish_level,
      t.active_workflow_step,
      t.assignee_name,
      t.vacancy_loss,
      t.last_rent_cost,
      t.unit_rent,
      t.is_unit_down,
      t.is_unit_on_hold,
      t.date_move_out               AS move_out_date,
      t.pms_move_out_date,
      t.turnover_start_date         AS start_date,
      t.date_showable,
      t.date_available              AS end_date,
      t.date_created,
      t.date_updated,
      t.is_completed,
      t.is_canceled,
      iw.due_date                   AS initial_walk_date,
      iw.status                     AS initial_walk_status,
      fw.due_date                   AS final_walk_date,
      fw.status                     AS final_walk_status,
      pm.buildium_property_id,
      bp.t12_name                   AS property_name
    FROM \`${PROJECT_ID}.propup_data.turnovers\` t
    LEFT JOIN \`${PROJECT_ID}.propup_data.turn_step_schedules\` iw
      ON t.turnover_id = iw.turnover_id AND LOWER(iw.step_name) = 'initial walk'
    LEFT JOIN \`${PROJECT_ID}.propup_data.turn_step_schedules\` fw
      ON t.turnover_id = fw.turnover_id AND LOWER(fw.step_name) = 'final walk'
    LEFT JOIN \`${PROJECT_ID}.propup_data.property_mapping\` pm
      ON t.property_id = pm.propup_property_id
    LEFT JOIN ${T}.properties\` bp
      ON pm.buildium_property_id = bp.property_id
    WHERE t.is_canceled = FALSE
    ORDER BY t.is_completed DESC, bp.t12_name, t.unit_name
  `,

  // Economic occupancy per property per month — authoritative source.
  // View: v_economic_occupancy (cash-basis pivot as of 2026-04-13).
  //   Grain: one row per property_id × snapshot_month. snapshot_month is STRING 'YYYY-MM'.
  //   economic_occupancy_pct is the per-property percentage (already ×100, rounded 1dp).
  //
  // CASH-BASIS PIVOT (2026-04-13): The numerator was rebuilt on actual cash collected per
  // unit per month, sourced from lease_historical_payments (Buildium Payment, ElectronicPayment,
  // Applied Prepayment). The old accrual-GL columns were renamed:
  //   total_income            → total_collected
  //   recurring_income        → recurring_collected
  //   non_recurring_income    → non_recurring_collected
  // New columns added: pass_through_collected (utility reimb + pass-throughs),
  // prepayment_received (GL 18 prepayments parked awaiting application).
  //
  // IMPORTANT: DO NOT average economic_occupancy_pct to get a portfolio number. The
  // authoritative portfolio rollup is dollar-weighted:
  //   SUM(recurring_collected) / SUM(estimated_charge_potential) × 100
  // We pull the numerator/denominator columns here so the dashboard can aggregate correctly.
  //
  // COVERAGE FILTER: The view now filters the denominator to "managed property-months" —
  // properties that had any lease activity (charges or payments) in that month. This
  // excludes units backfilled into rent_roll_snapshots for months before they were onboarded.
  // If a month has fewer properties than the prior month, check whether Buildium payments
  // have been ingested for that snapshot_month yet.
  economic_occupancy: `
    SELECT
      property_id,
      property_name,
      snapshot_month,
      total_units,
      occupied_units,
      preleased_units,
      vacant_units,
      physical_occupancy_pct,
      economic_occupancy_pct,
      economic_vs_physical_variance,
      total_collected,
      recurring_collected,
      non_recurring_collected,
      pass_through_collected,
      prepayment_received,
      estimated_charge_potential
    FROM ${T}.v_economic_occupancy\`
    ORDER BY property_name, snapshot_month
  `,

  // Property groups — maps group_name to property_id/property_name
  property_groups: `
    SELECT
      group_id,
      group_name,
      property_id,
      property_name
    FROM ${T}.property_groups\`
    ORDER BY group_name, property_name
  `,

  // Utility summary — utility income vs utility expense per property per month
  // Utility expense accounts: names containing 'Utility', 'Utilities', 'Electric', 'Gas', 'Water', 'Sewer', 'Trash'
  // Utility income accounts: names containing 'Utility Reimbursement', 'RUBS', 'Utility Income'
  utility_summary: `
    SELECT
      property_id,
      property_name,
      snapshot_month,
      SUM(CASE
        WHEN LOWER(t12_section) = 'income'
          AND (LOWER(account_name) LIKE '%utility%' OR LOWER(account_name) LIKE '%rubs%')
        THEN total_amount ELSE 0 END) AS utility_income,
      SUM(CASE
        WHEN LOWER(t12_section) IN ('expense', 'operating_expense')
          AND (LOWER(account_name) LIKE '%utilit%' OR LOWER(account_name) LIKE '%electric%'
               OR LOWER(account_name) LIKE '%gas %' OR LOWER(account_name) LIKE '%water%'
               OR LOWER(account_name) LIKE '%sewer%' OR LOWER(account_name) LIKE '%trash%')
        THEN total_amount ELSE 0 END) AS utility_expense
    FROM ${T}.financial_snapshots\`
    GROUP BY property_id, property_name, snapshot_month
    HAVING utility_income > 0 OR utility_expense > 0
    ORDER BY property_name, snapshot_month
  `,

  // Utility Reimbursement — SOURCE OF TRUTH as of 2026-04-13.
  // Previously the dashboard LIKE-matched account names in financial_snapshots.
  // The canonical view v_utility_reimbursement enumerates 23 utility income GLs and
  // 11 utility expense GLs and exposes utility_reimbursement_pct directly.
  // Typical multifamily range: 40–80%.
  utility_reimbursement: `
    SELECT *
    FROM ${T}.v_utility_reimbursement\`
    ORDER BY property_name, snapshot_month
  `,

  // Group rollup — single view with all KPIs pre-aggregated by Buildium property group × month.
  // Use this when filtering by group_name rather than rolling up property rows client-side.
  group_summary: `
    SELECT *
    FROM ${T}.v_group_summary\`
    ORDER BY group_name, snapshot_month
  `,

  // Rent roll snapshots — per-unit rent data by month (backfilled Jan 2025+, live daily from Apr 2026).
  // Source: buildium_data.rent_roll_snapshots (raw table, includes bedrooms/bathrooms strings).
  // The view v_rent_roll_snapshot omits bedrooms/bathrooms so we query the raw table directly.
  // Key columns: active_rent_amount, future_rent_amount, market_rent, bedrooms, bathrooms, snapshot_month.
  // Bedrooms/bathrooms are Buildium strings: "TwoBed", "OneBath", "OnePointFiveBath", etc.
  // Used for: average rent by unit layout, historical rent trend analysis, period comparisons.
  rent_roll_snapshot: `
    SELECT *
    FROM ${T}.rent_roll_snapshots\`
    ORDER BY property_name, snapshot_month, unit_number
  `,

  // Snapshot metadata — for detecting current month / live data
  // Uses SELECT * so the query doesn't break if columns are added/removed
  snapshot_metadata: `SELECT * FROM ${T}.snapshot_metadata\` ORDER BY last_updated DESC`,

  // ── DELINQUENCY ────────────────────────────────────────
  // Returns list of available weekly snapshot dates + row counts.
  // Client uses this to populate the date picker.
  delinquency_snapshot_dates: `
    SELECT
      snapshot_date,
      COUNT(*) AS row_count,
      COUNT(DISTINCT property_id) AS property_count,
      COUNT(DISTINCT lease_id) AS lease_count
    FROM ${T}.delinquency_snapshots\`
    GROUP BY snapshot_date
    ORDER BY snapshot_date DESC
  `,

  // Property-level delinquency rollup across ALL available snapshots.
  // Grain: one row per (snapshot_date × property_id).
  // Columns are designed to match John's weekly workbook:
  //   total_delinquency     = SUM of lease total_balance > 0 (positive side only)
  //   prepaid_balance       = SUM of lease total_balance < 0 (negative side, kept as-is)
  //   net_balance           = SUM of all lease total_balance (delinq - prepaid); exposed for reconciliation
  //   balance_0_30          = SUM of balance_0_to_30_days  (current month's delinq)
  //   eviction_carry_over   = total_delinquency - balance_0_30  (= 31/60/90+ buckets)
  //   expected_rent         = pulled from v_rent_collection (most recent month); represents
  //                           monthly recurring rent the property SHOULD collect.
  //   property_name, units  = from the canonical properties table.
  //
  // The workbook's "Income" column = expected_rent. Joining v_rent_collection today means
  // all snapshot rows share the same expected_rent (current state). Once we backfill
  // historical expected_rent per week this can shift to a per-snapshot join.
  //
  // WoW comparison is computed CLIENT-SIDE by pairing the selected snapshot with the
  // snapshot exactly 7 days prior (falling back to "most recent earlier snapshot" if
  // the exact-7-day target doesn't exist yet).
  delinquency_property_rollup: `
    WITH agg AS (
      SELECT
        snapshot_date,
        property_id,
        SUM(CASE WHEN total_balance > 0 THEN total_balance ELSE 0 END) AS total_delinquency,
        SUM(CASE WHEN total_balance < 0 THEN total_balance ELSE 0 END) AS prepaid_balance,
        SUM(total_balance) AS net_balance,
        SUM(balance_0_to_30_days)  AS balance_0_30,
        SUM(balance_31_to_60_days) AS balance_31_60,
        SUM(balance_61_to_90_days) AS balance_61_90,
        SUM(balance_over_90_days)  AS balance_over_90,
        COUNT(DISTINCT lease_id) AS lease_count,
        COUNTIF(total_balance > 0) AS delinquent_lease_count,
        COUNTIF(eviction_pending_date IS NOT NULL) AS eviction_pending_count,
        COUNTIF(is_notice_given = TRUE) AS notice_given_count
      FROM ${T}.delinquency_snapshots\`
      GROUP BY snapshot_date, property_id
    ),
    snapshot_dates AS (
      SELECT DISTINCT snapshot_date FROM ${T}.delinquency_snapshots\`
    ),
    props AS (
      -- Include any property with delinquency history, even if currently inactive.
      -- Pre-2026-04-25 this CTE filtered on is_active = TRUE, which silently dropped
      -- properties that were live in early 2025 but have since been deactivated --
      -- making historical totals look low against the source-of-truth workbook.
      SELECT property_id, t12_name AS property_name, units
      FROM ${T}.properties\`
      WHERE is_active = TRUE
         OR property_id IN (SELECT DISTINCT property_id FROM ${T}.delinquency_snapshots\`)
    ),
    rent AS (
      -- Use v_property_recurring_income (all GLs) — matches John's workbook definition
      -- of "total recurring income a property should collect a month" (~$3.16M across 7 markets).
      -- Previous source v_rent_collection.expected_rent was only ~$2.75M (rent-only, no add-ons).
      -- Note: this still anchors to the LATEST month, so % of Income on backfilled (pre-Apr-2026)
      -- snapshots is comparing today's expected rent to historical delinquency. Total $ figures
      -- are unaffected. Per-snapshot rent backfill is a future task.
      SELECT property_id, total_recurring_income AS expected_rent
      FROM ${T}.v_property_recurring_income\`
      WHERE snapshot_month = (SELECT MAX(snapshot_month) FROM ${T}.v_property_recurring_income\`)
    )
    -- CROSS JOIN ensures every property with delinq history (active or inactive) appears
    -- for every snapshot_date, even if the property had zero delinquency rows in that
    -- snapshot (keeps Income KPI accurate — no silent property drops).
    SELECT
      sd.snapshot_date,
      p.property_id,
      p.property_name,
      p.units,
      COALESCE(a.total_delinquency, 0) AS total_delinquency,
      COALESCE(a.prepaid_balance, 0) AS prepaid_balance,
      COALESCE(a.net_balance, 0) AS net_balance,
      COALESCE(a.balance_0_30, 0) AS balance_0_30,
      COALESCE(a.balance_31_60, 0) AS balance_31_60,
      COALESCE(a.balance_61_90, 0) AS balance_61_90,
      COALESCE(a.balance_over_90, 0) AS balance_over_90,
      (COALESCE(a.total_delinquency, 0) - COALESCE(a.balance_0_30, 0)) AS eviction_carry_over,
      COALESCE(a.lease_count, 0) AS lease_count,
      COALESCE(a.delinquent_lease_count, 0) AS delinquent_lease_count,
      COALESCE(a.eviction_pending_count, 0) AS eviction_pending_count,
      COALESCE(a.notice_given_count, 0) AS notice_given_count,
      r.expected_rent
    FROM snapshot_dates sd
    CROSS JOIN props p
    LEFT JOIN agg a ON a.snapshot_date = sd.snapshot_date AND a.property_id = p.property_id
    LEFT JOIN rent r ON r.property_id = p.property_id
    ORDER BY sd.snapshot_date DESC, p.property_name
  `,

  // ──────────────────────────────────────────────────────────────
  //  UNIT TURN BOARD — v_unit_turn_costs family (added 2026-04-24)
  //  Source: buildium_data.gl_transactions (journal-line grain, cash basis)
  //  History: Jan 2025 → current month. Daily refresh planned.
  //  Always filter WHERE unit_id IS NOT NULL for turn analytics —
  //  55% of CAPEX is unit-tagged; the remaining 45% is building-wide.
  // ──────────────────────────────────────────────────────────────

  // Per-unit per-month CAPEX rollup. turn_cost_excl_hvac_cash covers the
  // 13 turn categories (labor, materials, flooring, paint, etc.). HVAC
  // is separated so dashboards can show with/without HVAC. non_turn =
  // building-wide work excluded from turn cost by default.
  // Uses SELECT * to stay resilient to column name changes. Extra columns
  // are harmless; the dashboard only reads the ones it knows about.
  unit_turn_costs: `
    SELECT *
    FROM ${T}.v_unit_turn_costs\`
    WHERE unit_id IS NOT NULL
    ORDER BY property_name, unit_number, snapshot_month
  `,

  // Same grain with the 13 turn categories pivoted as columns. SELECT * keeps
  // us resilient to category rename/add in the upstream view.
  unit_turn_costs_by_category: `
    SELECT *
    FROM ${T}.v_unit_turn_costs_by_category\`
    WHERE unit_id IS NOT NULL
    ORDER BY property_name, unit_number, snapshot_month
  `,

  // CAPEX transaction lines (cash basis) — on-demand drill-in only.
  // Call with { type: 'capex_transactions_cash', unit_id: 474474 } to scope
  // to a single unit. Matches Buildium UI to the penny. See unit_id handling
  // in the single-type branch of the request handler below.
  capex_transactions_cash: `
    SELECT *
    FROM ${T}.v_capex_transactions_cash\`
    WHERE unit_id IS NOT NULL
    ORDER BY property_name, unit_number, transaction_date
  `,

  // ══════════════════════════════════════════════════════════════
  //  DATA VALIDATION (read-only diagnostics, added 2026-08-24)
  //  These do not feed the UI. They run the accuracy checks INSIDE BigQuery so the
  //  API's output can be reconciled against the warehouse rather than trusted.
  //  Only objects already proven to exist (every other query type here returns 200)
  //  are referenced, so a single missing view cannot fail the whole UNION.
  // ══════════════════════════════════════════════════════════════

  // Authoritative row count per object. Compare against the `count` the API returns for
  // the corresponding query type — any shortfall means rows were lost in transit
  // (pagination truncation, an incomplete job treated as empty, etc.).
  validate_row_counts: `
    SELECT 'v_occupancy_summary' AS object, COUNT(*) AS bq_rows FROM ${T}.v_occupancy_summary\`
    UNION ALL SELECT 'v_rent_roll',              COUNT(*) FROM ${T}.v_rent_roll\`
    UNION ALL SELECT 'v_vacancy',                COUNT(*) FROM ${T}.v_vacancy\`
    UNION ALL SELECT 'v_lease_expirations',      COUNT(*) FROM ${T}.v_lease_expirations\`
    UNION ALL SELECT 'v_stale_leases',           COUNT(*) FROM ${T}.v_stale_leases\`
    UNION ALL SELECT 'v_occupancy_snapshot_summary', COUNT(*) FROM ${T}.v_occupancy_snapshot_summary\`
    UNION ALL SELECT 'v_noi_summary',            COUNT(*) FROM ${T}.v_noi_summary\`
    UNION ALL SELECT 'v_income_statement_snapshot', COUNT(*) FROM ${T}.v_income_statement_snapshot\`
    UNION ALL SELECT 'v_economic_occupancy',     COUNT(*) FROM ${T}.v_economic_occupancy\`
    UNION ALL SELECT 'v_utility_reimbursement',  COUNT(*) FROM ${T}.v_utility_reimbursement\`
    UNION ALL SELECT 'v_group_summary',          COUNT(*) FROM ${T}.v_group_summary\`
    UNION ALL SELECT 'financial_snapshots',      COUNT(*) FROM ${T}.financial_snapshots\`
    UNION ALL SELECT 'rent_roll_snapshots',      COUNT(*) FROM ${T}.rent_roll_snapshots\`
    UNION ALL SELECT 'properties_active',        COUNT(*) FROM ${T}.properties\` WHERE is_active = TRUE
    UNION ALL SELECT 'properties_all',           COUNT(*) FROM ${T}.properties\`
    UNION ALL SELECT 'property_groups',          COUNT(*) FROM ${T}.property_groups\`
    UNION ALL SELECT 'delinquency_snapshots',    COUNT(*) FROM ${T}.delinquency_snapshots\`
    UNION ALL SELECT 'propup_turnovers_active',  COUNT(*) FROM \`${PROJECT_ID}.propup_data.turnovers\` WHERE is_canceled = FALSE
    UNION ALL SELECT 'propup_property_mapping',  COUNT(*) FROM \`${PROJECT_ID}.propup_data.property_mapping\`
    ORDER BY object
  `,

  // Duplicate detection at each view's documented grain. Any non-zero dup_keys means the
  // view fans out — every downstream SUM would be inflated without anything looking wrong.
  validate_grain: `
    WITH occ AS (
      SELECT property_id AS k, COUNT(*) c FROM ${T}.v_occupancy_summary\` GROUP BY 1 HAVING c > 1
    ), econ AS (
      SELECT CONCAT(CAST(property_id AS STRING), '|', CAST(snapshot_month AS STRING)) k, COUNT(*) c
      FROM ${T}.v_economic_occupancy\` GROUP BY 1 HAVING c > 1
    ), noi AS (
      SELECT CONCAT(property_name, '|', CAST(month AS STRING)) k, COUNT(*) c
      FROM ${T}.v_noi_summary\` GROUP BY 1 HAVING c > 1
    ), rr AS (
      SELECT CAST(unit_id AS STRING) k, COUNT(*) c FROM ${T}.v_rent_roll\` GROUP BY 1 HAVING c > 1
    ), vac AS (
      SELECT CAST(unit_id AS STRING) k, COUNT(*) c FROM ${T}.v_vacancy\` GROUP BY 1 HAVING c > 1
    ), snap AS (
      SELECT CONCAT(CAST(property_id AS STRING), '|', CAST(snapshot_month AS STRING)) k, COUNT(*) c
      FROM ${T}.v_occupancy_snapshot_summary\` GROUP BY 1 HAVING c > 1
    )
    SELECT 'v_occupancy_summary / property_id' AS grain, COUNT(*) AS dup_keys, IFNULL(SUM(c - 1), 0) AS extra_rows FROM occ
    UNION ALL SELECT 'v_economic_occupancy / property_id+month', COUNT(*), IFNULL(SUM(c - 1), 0) FROM econ
    UNION ALL SELECT 'v_noi_summary / property_name+month',      COUNT(*), IFNULL(SUM(c - 1), 0) FROM noi
    UNION ALL SELECT 'v_rent_roll / unit_id',                    COUNT(*), IFNULL(SUM(c - 1), 0) FROM rr
    UNION ALL SELECT 'v_vacancy / unit_id',                      COUNT(*), IFNULL(SUM(c - 1), 0) FROM vac
    UNION ALL SELECT 'v_occupancy_snapshot_summary / prop+month',COUNT(*), IFNULL(SUM(c - 1), 0) FROM snap
    ORDER BY grain
  `,

  // Cross-source reconciliation, computed in BigQuery. Each row is metric_a vs metric_b
  // with the difference; a non-zero diff on a pair that must agree is a real data fault.
  validate_reconciliation: `
    WITH
    occ AS (
      SELECT SUM(total_units) tu, SUM(occupied_units) ou, SUM(vacant_units) vu, COUNT(*) props
      FROM ${T}.v_occupancy_summary\`
    ),
    rr  AS (SELECT COUNT(*) n FROM ${T}.v_rent_roll\`),
    vac AS (SELECT COUNT(*) n FROM ${T}.v_vacancy\`),
    fin AS (
      SELECT
        ROUND(SUM(CASE WHEN LOWER(t12_section) = 'income'  THEN total_amount ELSE 0 END), 2) inc,
        ROUND(SUM(CASE WHEN LOWER(t12_section) = 'expense' THEN total_amount ELSE 0 END), 2) exp
      FROM ${T}.financial_snapshots\`
    ),
    noi AS (
      SELECT ROUND(SUM(total_income), 2) inc, ROUND(SUM(total_expenses), 2) exp
      FROM ${T}.v_noi_summary\`
    ),
    orphan_turns AS (
      SELECT COUNT(*) n FROM \`${PROJECT_ID}.propup_data.turnovers\` t
      LEFT JOIN \`${PROJECT_ID}.propup_data.property_mapping\` pm
        ON t.property_id = pm.propup_property_id
      WHERE t.is_canceled = FALSE AND pm.propup_property_id IS NULL
    ),
    occ_not_in_props AS (
      SELECT COUNT(*) n, IFNULL(SUM(o.total_units), 0) u
      FROM ${T}.v_occupancy_summary\` o
      LEFT JOIN ${T}.properties\` p ON o.property_id = p.property_id AND p.is_active = TRUE
      WHERE p.property_id IS NULL
    ),
    props_not_in_occ AS (
      SELECT COUNT(*) n, IFNULL(SUM(p.units), 0) u
      FROM ${T}.properties\` p
      LEFT JOIN ${T}.v_occupancy_summary\` o ON o.property_id = p.property_id
      WHERE p.is_active = TRUE AND o.property_id IS NULL
    )
    SELECT 'occupancy total_units = occupied + vacant' AS check_name,
           CAST(occ.tu AS STRING) AS value_a, CAST(occ.ou + occ.vu AS STRING) AS value_b,
           CAST(occ.tu - (occ.ou + occ.vu) AS STRING) AS diff FROM occ
    UNION ALL SELECT 'occupied_units = v_rent_roll rows',
           CAST(occ.ou AS STRING), CAST(rr.n AS STRING), CAST(occ.ou - rr.n AS STRING) FROM occ, rr
    UNION ALL SELECT 'vacant_units = v_vacancy rows',
           CAST(occ.vu AS STRING), CAST(vac.n AS STRING), CAST(occ.vu - vac.n AS STRING) FROM occ, vac
    UNION ALL SELECT 'v_noi_summary income = financial_snapshots income',
           CAST(noi.inc AS STRING), CAST(fin.inc AS STRING), CAST(ROUND(noi.inc - fin.inc, 2) AS STRING) FROM noi, fin
    UNION ALL SELECT 'v_noi_summary expenses = financial_snapshots expenses',
           CAST(noi.exp AS STRING), CAST(fin.exp AS STRING), CAST(ROUND(noi.exp - fin.exp, 2) AS STRING) FROM noi, fin
    UNION ALL SELECT 'turns with no propup property_mapping row',
           CAST(orphan_turns.n AS STRING), '0', CAST(orphan_turns.n AS STRING) FROM orphan_turns
    UNION ALL SELECT 'occupancy properties missing from properties(is_active)',
           CAST(occ_not_in_props.n AS STRING), '0', CAST(occ_not_in_props.u AS STRING) FROM occ_not_in_props
    UNION ALL SELECT 'active properties with no occupancy row',
           CAST(props_not_in_occ.n AS STRING), '0', CAST(props_not_in_occ.u AS STRING) FROM props_not_in_occ
  `,

  // Freshness: newest data point per source. A source that has silently stopped loading
  // shows up here as a stale max date while the dashboard keeps rendering old numbers.
  validate_freshness: `
    SELECT 'financial_snapshots' AS source, CAST(MAX(snapshot_month) AS STRING) AS latest, COUNT(DISTINCT snapshot_month) AS periods FROM ${T}.financial_snapshots\`
    UNION ALL SELECT 'rent_roll_snapshots',  CAST(MAX(snapshot_month) AS STRING), COUNT(DISTINCT snapshot_month) FROM ${T}.rent_roll_snapshots\`
    UNION ALL SELECT 'v_economic_occupancy', CAST(MAX(snapshot_month) AS STRING), COUNT(DISTINCT snapshot_month) FROM ${T}.v_economic_occupancy\`
    UNION ALL SELECT 'v_occupancy_snapshot_summary', CAST(MAX(snapshot_month) AS STRING), COUNT(DISTINCT snapshot_month) FROM ${T}.v_occupancy_snapshot_summary\`
    UNION ALL SELECT 'v_noi_summary',        CAST(MAX(month) AS STRING), COUNT(DISTINCT month) FROM ${T}.v_noi_summary\`
    UNION ALL SELECT 'delinquency_snapshots',CAST(MAX(snapshot_date) AS STRING), COUNT(DISTINCT snapshot_date) FROM ${T}.delinquency_snapshots\`
    UNION ALL SELECT 'propup_turnovers',     CAST(MAX(date_updated) AS STRING), COUNT(*) FROM \`${PROJECT_ID}.propup_data.turnovers\`
    ORDER BY source
  `,

  // Connection test
  test: `SELECT 1 as ok, CURRENT_TIMESTAMP() as server_time`,
};

/* ══════════════════════════════════════════════════════════════
   HISTORICAL CACHE CONFIG
   ──────────────────────────────────────────────────────────────
   Months older than the prior month are served from Supabase
   (dashboard_historical_cache). Current + prior month remain
   live from BigQuery. Manually refreshed by superadmin via the
   "Refresh Historic Data" modal in the dashboard top bar.
   ══════════════════════════════════════════════════════════════ */

// Which query types are cacheable, and what column identifies the month in each.
const MONTH_COLUMN: Record<string, string> = {
  financial_summary:          'snapshot_month',
  noi_summary:                'month',
  occupancy_snapshot_summary: 'snapshot_month',
  economic_occupancy:         'snapshot_month',
  utility_summary:            'snapshot_month',
  utility_reimbursement:      'snapshot_month',
  income_statement_snapshot:  'snapshot_month',
  group_summary:              'snapshot_month',
  rent_roll_snapshot:         'snapshot_month',
  // Unit Turn Board — monthly grain. Filtering supported but NOT cached
  // because capex data refreshes daily and the cache is keyed by month.
  unit_turn_costs:             'snapshot_month',
  unit_turn_costs_by_category: 'snapshot_month',
  capex_transactions_cash:     'snapshot_month',
};

const CACHEABLE_TYPES = Object.keys(MONTH_COLUMN);

// Live window: current + prior month (returns YYYY-MM strings)
function computeLiveWindow(now: Date = new Date()): { currentMonth: string; priorMonth: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const currentMonth = `${y}-${String(m).padStart(2, '0')}`;
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const priorMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  return { currentMonth, priorMonth };
}

// ── Supabase REST helpers (service-role) ─────────────────────
const SB_URL         = Deno.env.get('SUPABASE_URL') || '';
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SB_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY') || '';

async function sbFetch(path: string, init: RequestInit = {}, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${SB_URL}${path}`, {
    ...init,
    headers: {
      'apikey': SB_SERVICE_KEY,
      'Authorization': `Bearer ${SB_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> || {}),
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase REST ${res.status}: ${txt}`);
  }
  return res;
}

async function sbUpsertCache(entries: Array<{
  query_type: string; snapshot_month: string; payload: any; row_count: number; cached_by: string | null;
}>) {
  if (!entries.length) return;
  await sbFetch('/rest/v1/dashboard_historical_cache', {
    method: 'POST',
    body: JSON.stringify(entries),
  }, { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
}

async function sbDeleteCacheForType(queryType: string, olderThan?: string) {
  let path = `/rest/v1/dashboard_historical_cache?query_type=eq.${encodeURIComponent(queryType)}`;
  if (olderThan) path += `&snapshot_month=lt.${encodeURIComponent(olderThan)}`;
  await sbFetch(path, { method: 'DELETE' }, { 'Prefer': 'return=minimal' });
}

// ── Superadmin verification (JWT from caller → profiles.role) ──
async function verifySuperadmin(authHeader: string | null): Promise<{ ok: boolean; userId?: string; error?: string }> {
  if (!authHeader?.startsWith('Bearer ')) return { ok: false, error: 'Missing Authorization header' };
  const token = authHeader.replace('Bearer ', '');
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': SB_ANON_KEY },
  });
  if (!userRes.ok) return { ok: false, error: `Invalid auth token (${userRes.status})` };
  const user = await userRes.json();
  if (!user?.id) return { ok: false, error: 'No user in token' };
  const profRes = await sbFetch(`/rest/v1/profiles?id=eq.${user.id}&select=role`);
  const profiles = await profRes.json();
  const role = profiles?.[0]?.role;
  if (role !== 'superadmin') return { ok: false, error: `Role '${role || 'unknown'}' not authorized (superadmin required)` };
  return { ok: true, userId: user.id };
}

/* ── Month filtering ───────────────────────────────────
   Shared by the single-type and batch paths so both stay consistent.

     months_from: 'YYYY-MM'   -> everything >= that month  (PREFERRED)
     months: ['YYYY-MM', ...] -> exactly those months      (legacy)

   months_from exists because an explicit list silently drops data whenever the cache
   is stale: the client used to compute the list from today's date while the cache only
   held through some older month, so every month in between belonged to neither half and
   vanished. An open-ended lower bound derived from what is actually cached cannot leave
   a hole. Both forms are ignored for types with no month column.
   ────────────────────────────────────────────────────── */
function applyMonthFilter(sql: string, type: string, opts: { months_from?: any; months?: any }): string {
  const col = MONTH_COLUMN[type];
  if (!col) return sql;
  const isMonth = (m: string) => /^\d{4}-\d{2}$/.test(m);

  const from = opts.months_from ? String(opts.months_from).slice(0, 7) : null;
  if (from && isMonth(from)) {
    return `SELECT * FROM (${sql}) WHERE SUBSTR(CAST(${col} AS STRING), 1, 7) >= '${from}'`;
  }
  if (Array.isArray(opts.months) && opts.months.length) {
    const safe = opts.months.map((m: any) => String(m).slice(0, 7)).filter(isMonth);
    if (safe.length) {
      const list = safe.map((m: string) => `'${m}'`).join(', ');
      return `SELECT * FROM (${sql}) WHERE SUBSTR(CAST(${col} AS STRING), 1, 7) IN (${list})`;
    }
  }
  return sql;
}

/* ── Edge Function Handler ─────────────────────────────── */
serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_DASHBOARD');
    if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_DASHBOARD secret not set');

    const sa = JSON.parse(saJson);
    if (!sa.client_email) throw new Error('Invalid service account JSON');

    const body = await req.json();

    // ── Action: cache_status ──
    // Returns { status: [...], cacheable_types: [...], live_window: {...} }
    if (body.action === 'cache_status') {
      const r = await sbFetch('/rest/v1/v_dashboard_cache_status?select=*');
      const status = await r.json();
      const liveWindow = computeLiveWindow();
      return new Response(JSON.stringify({ status, cacheable_types: CACHEABLE_TYPES, live_window: liveWindow }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Action: cache_type ──
    // Superadmin only — rebuilds historical cache for one query type.
    // Returns { type, monthsCached, rowsCached, totalRowsFromBQ, cutoff }
    // — shape the client's runHistoricRefresh expects.
    //
    // Two strategies:
    //   1) Single-shot (default): one BQ query → group by month → upsert.
    //      Fast, but memory-bounded by full result set.
    //   2) Per-month (HEAVY_CACHE_TYPES): list distinct months → one BQ query
    //      per eligible month → upsert that month → release memory → repeat.
    //      Slower but bounded by single-month row count. Required for
    //      rent_roll_snapshot which has ~3,890 wide rows × 15 months ≈ 58K
    //      rows of full Buildium columns; single-shot OOMs the worker (546).
    if (body.action === 'cache_type') {
      const authCheck = await verifySuperadmin(req.headers.get('Authorization'));
      if (!authCheck.ok) {
        return new Response(JSON.stringify({ error: authCheck.error }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const cacheType = body.type;
      if (!cacheType || !MONTH_COLUMN[cacheType]) {
        throw new Error(`Type '${cacheType}' is not cacheable. Cacheable types: ${CACHEABLE_TYPES.join(', ')}`);
      }
      if (!QUERIES[cacheType]) {
        throw new Error(`Type '${cacheType}' has no SQL definition in QUERIES.`);
      }

      const HEAVY_CACHE_TYPES = new Set(['rent_roll_snapshot']);
      const token = await getAccessToken(sa);
      const { priorMonth } = computeLiveWindow();
      const col = MONTH_COLUMN[cacheType];
      const baseSql = QUERIES[cacheType];

      // Always wipe the cached window first so we don't leave stale months around.
      await sbDeleteCacheForType(cacheType, priorMonth);

      let monthsCached = 0;
      let rowsCached = 0;
      let totalRowsFromBQ = 0;

      if (HEAVY_CACHE_TYPES.has(cacheType)) {
        // ── Per-month path ──
        // 1) List eligible months (< priorMonth).
        const monthsListSql =
          `SELECT DISTINCT SUBSTR(CAST(${col} AS STRING), 1, 7) AS m ` +
          `FROM (${baseSql}) ` +
          `WHERE SUBSTR(CAST(${col} AS STRING), 1, 7) < '${priorMonth}' ` +
          `ORDER BY m`;
        const monthsList = await runQuery(token, monthsListSql);
        const eligibleMonths = monthsList.map((r: any) => r.m).filter(Boolean);

        // 2) For each eligible month, fetch + upsert + release.
        for (const m of eligibleMonths) {
          const monthSql =
            `SELECT * FROM (${baseSql}) ` +
            `WHERE SUBSTR(CAST(${col} AS STRING), 1, 7) = '${m}'`;
          const monthRows = await runQuery(token, monthSql);
          totalRowsFromBQ += monthRows.length;
          if (!monthRows.length) continue;
          await sbUpsertCache([{
            query_type:     cacheType,
            snapshot_month: m,
            payload:        monthRows,
            row_count:      monthRows.length,
            cached_by:      authCheck.userId || null,
          }]);
          monthsCached  += 1;
          rowsCached    += monthRows.length;
        }
      } else {
        // ── Single-shot path (default — used for 8 of 9 types) ──
        const rows = await runQuery(token, baseSql);
        totalRowsFromBQ = rows.length;

        // Group rows by month, excluding live window (>= priorMonth stays live in BQ)
        const byMonth: Record<string, any[]> = {};
        for (const r of rows) {
          const raw = r[col];
          if (!raw) continue;
          const m = String(raw).slice(0, 7);
          if (m >= priorMonth) continue;
          if (!byMonth[m]) byMonth[m] = [];
          byMonth[m].push(r);
        }

        const entries = Object.entries(byMonth).map(([month, monthRows]) => ({
          query_type:     cacheType,
          snapshot_month: month,
          payload:        monthRows,
          row_count:      monthRows.length,
          cached_by:      authCheck.userId || null,
        }));
        for (let i = 0; i < entries.length; i += 50) {
          await sbUpsertCache(entries.slice(i, i + 50));
        }
        monthsCached = Object.keys(byMonth).length;
        rowsCached   = entries.reduce((s, e) => s + e.row_count, 0);
      }

      return new Response(JSON.stringify({
        type:            cacheType,
        monthsCached,
        rowsCached,
        totalRowsFromBQ,
        cutoff:          priorMonth,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── BATCH MODE ──
    // Accepts { batch: [{ type: "financial_summary" }, { type: "noi_summary" }, ...] }
    // Shares ONE OAuth token across all queries (saves ~500ms × N) and runs the
    // queries in parallel server-side so the client only pays one HTTP round-trip
    // for the whole Overview page load.
    //
    // Returns: { results: { type1: { rows, count }, type2: { error: "..." }, ... } }
    // Individual query failures don't fail the whole batch — each type is wrapped.
    if (Array.isArray(body.batch)) {
      if (body.batch.length === 0) {
        return new Response(JSON.stringify({ results: {} }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (body.batch.length > 32) {
        throw new Error(`Batch size ${body.batch.length} exceeds limit of 32`);
      }

      const token = await getAccessToken(sa);

      const entries = await Promise.all(
        body.batch.map(async (item: any) => {
          const type = item?.type;
          if (!type || typeof type !== 'string') {
            return [String(type), { error: 'Missing or invalid type' }];
          }
          const baseSql = QUERIES[type];
          if (!baseSql) {
            return [type, { error: `Unknown query type: ${type}` }];
          }
          try {
            // Per-item month filtering. Without this the batch shipped every month of
            // every cacheable view on each Overview load (rent_roll_snapshot alone is
            // ~50MB / 71K rows) only for the client to throw most of it away.
            const sql = applyMonthFilter(baseSql, type, item || {});
            const rows = await runQuery(token, sql);
            return [type, { rows, count: rows.length }];
          } catch (err: any) {
            return [type, { error: err?.message || String(err) }];
          }
        })
      );

      const results: Record<string, any> = {};
      for (const [k, v] of entries) results[k as string] = v;

      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── SINGLE-TYPE MODE (backward compatible) ──
    // Also accepts an optional `unit_id` parameter, currently honored only for the
    // Unit Turn Board's `capex_transactions_cash` drill-in. If set, wraps the base
    // query in a `WHERE unit_id = X` filter so we don't ship all ~10K line items
    // to the browser just to show one unit's transactions.
    const { type, unit_id, months } = body;
    let sql = QUERIES[type];
    if (!sql) throw new Error(`Unknown query type: ${type}. Valid types: ${Object.keys(QUERIES).join(', ')}`);
    if (unit_id != null && type === 'capex_transactions_cash') {
      const uid = parseInt(String(unit_id));
      if (Number.isFinite(uid)) sql = `SELECT * FROM (${sql}) WHERE unit_id = ${uid}`;
    }

    sql = applyMonthFilter(sql, type, { months_from: body.months_from, months });

    const token = await getAccessToken(sa);
    const rows = await runQuery(token, sql);

    return new Response(JSON.stringify({ rows, count: rows.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
