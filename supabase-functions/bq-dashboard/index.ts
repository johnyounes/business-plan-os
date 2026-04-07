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

/* ── BigQuery Query Runner ─────────────────────────────── */
async function runQuery(token: string, sql: string): Promise<any[]> {
  let allRows: any[] = [];
  let pageToken: string | undefined;
  let schema: any;

  // Initial query
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/queries`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        maxResults: 10000,
      }),
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  schema = data.schema;
  const fields = (schema?.fields || []).map((f: any) => f.name);

  const mapRows = (rows: any[]) =>
    rows.map((row: any) =>
      Object.fromEntries(fields.map((f: string, i: number) => [f, row.f[i].v]))
    );

  allRows = mapRows(data.rows || []);
  pageToken = data.pageToken;

  // Paginate if needed
  while (pageToken) {
    const jobId = data.jobReference?.jobId;
    const pageRes = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/queries/${jobId}?pageToken=${pageToken}&maxResults=10000`,
      { headers: { 'Authorization': `Bearer ${token}` } }
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
  bedroom_mix: `
    SELECT
      ru.bedrooms,
      COUNT(*) as total_units,
      COUNTIF(ru.is_occupied) as occupied_units,
      ROUND(AVG(ru.market_rent), 0) as avg_market_rent,
      ROUND(AVG(CASE WHEN l.rent_amount > 0 THEN l.rent_amount END), 0) as avg_actual_rent
    FROM ${T}.rental_units\` ru
    LEFT JOIN ${T}.leases\` l
      ON ru.unit_id = l.unit_id AND l.lease_status = 'Active'
    GROUP BY ru.bedrooms
    ORDER BY total_units DESC
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

  // Income statement: per-account breakdown for drill-down
  income_statement: `
    SELECT
      property_name,
      account_name,
      section,
      is_pass_through,
      month,
      total_amount,
      transaction_count
    FROM ${T}.v_income_statement\`
    ORDER BY property_name, month DESC, section, account_name
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

  // PropUp unit turns with cross-system mapping
  // Note: turn_step_schedules may not have scheduled_start — using step_order instead
  turns: `
    SELECT
      t.turnover_id,
      t.property_id AS propup_property_id,
      pm.buildium_property_id,
      bp.t12_name AS property_name,
      t.unit_number,
      t.status,
      t.board,
      t.finish_level,
      t.estimated_cost,
      t.start_date,
      t.end_date,
      DATE_DIFF(COALESCE(t.end_date, CURRENT_DATE()), t.start_date, DAY) AS days_in_turn
    FROM \`${PROJECT_ID}.propup_data.turnovers\` t
    LEFT JOIN \`${PROJECT_ID}.propup_data.property_mapping\` pm
      ON t.property_id = pm.propup_property_id
    LEFT JOIN ${T}.properties\` bp
      ON pm.buildium_property_id = bp.property_id
    ORDER BY property_name, unit_number
  `,

  // Connection test
  test: `SELECT 1 as ok, CURRENT_TIMESTAMP() as server_time`,
};

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

    const { type } = await req.json();
    const sql = QUERIES[type];
    if (!sql) throw new Error(`Unknown query type: ${type}. Valid types: ${Object.keys(QUERIES).join(', ')}`);

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
