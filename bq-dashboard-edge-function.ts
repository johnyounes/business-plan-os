// Supabase Edge Function: bq-dashboard
// Deploy: supabase functions deploy bq-dashboard
// Secret: GOOGLE_SERVICE_ACCOUNT_DASHBOARD (service account JSON for api-data-pull-492404)
//
// This edge function queries BigQuery views and tables in the
// api-data-pull-492404 project and returns JSON for the BPOS Dashboard.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { JWT } from 'https://deno.land/x/google_jwt@v0.1.1/mod.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PROJECT_ID = 'api-data-pull-492404';
const DATASET_BUILDIUM = 'buildium_data';
const DATASET_PROPUP = 'propup_data';

// ── BigQuery SQL for each query type ──
const QUERIES: Record<string, string> = {

  // Properties list with unit counts
  properties: `
    SELECT property_id, t12_name, api_name, units, is_active
    FROM \`${PROJECT_ID}.${DATASET_BUILDIUM}.properties\`
    WHERE is_active = TRUE
    ORDER BY t12_name
  `,

  // NOI summary by property by month
  noi_summary: `
    SELECT
      property_id,
      property_name,
      snapshot_month AS month,
      SUM(CASE WHEN t12_section = 'income' THEN total_amount ELSE 0 END) AS revenue,
      SUM(CASE WHEN t12_section = 'expense' THEN total_amount ELSE 0 END) AS expenses,
      SUM(CASE WHEN t12_section IN ('income','expense') THEN total_amount ELSE 0 END) AS noi
    FROM \`${PROJECT_ID}.${DATASET_BUILDIUM}.financial_snapshots\`
    GROUP BY property_id, property_name, snapshot_month
    ORDER BY property_name, snapshot_month
  `,

  // Financial detail (all accounts by property by month)
  financial_summary: `
    SELECT
      property_id, property_name, snapshot_month,
      account_name, t12_section, sub_type,
      total_amount, transaction_count
    FROM \`${PROJECT_ID}.${DATASET_BUILDIUM}.financial_snapshots\`
    ORDER BY property_name, snapshot_month, t12_section, account_name
  `,

  // Occupancy summary (latest snapshot)
  occupancy_summary: `
    SELECT * FROM \`${PROJECT_ID}.${DATASET_BUILDIUM}.v_occupancy_summary\`
    ORDER BY property_name
  `,

  // Rent roll (current)
  rent_roll: `
    SELECT * FROM \`${PROJECT_ID}.${DATASET_BUILDIUM}.v_rent_roll\`
    ORDER BY property_name, unit_number
  `,

  // Vacancy
  vacancy: `
    SELECT * FROM \`${PROJECT_ID}.${DATASET_BUILDIUM}.v_vacancy\`
    ORDER BY property_name, unit_number
  `,

  // Lease expirations
  lease_expirations: `
    SELECT * FROM \`${PROJECT_ID}.${DATASET_BUILDIUM}.v_lease_expirations\`
    ORDER BY lease_end ASC
  `,

  // PropUp turns with cross-system mapping
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
      DATE_DIFF(COALESCE(t.end_date, CURRENT_DATE()), t.start_date, DAY) AS days_in_turn,
      ts.step_name AS current_step
    FROM \`${PROJECT_ID}.${DATASET_PROPUP}.turnovers\` t
    LEFT JOIN \`${PROJECT_ID}.${DATASET_PROPUP}.property_mapping\` pm
      ON t.property_id = pm.propup_property_id
    LEFT JOIN \`${PROJECT_ID}.${DATASET_BUILDIUM}.properties\` bp
      ON pm.buildium_property_id = bp.property_id
    LEFT JOIN (
      SELECT turnover_id, step_name
      FROM \`${PROJECT_ID}.${DATASET_PROPUP}.turn_step_schedules\`
      WHERE status != 'Complete'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY turnover_id ORDER BY scheduled_start ASC) = 1
    ) ts ON t.turnover_id = ts.turnover_id
    ORDER BY property_name, unit_number
  `,
};

// ── BigQuery REST API helper ──
async function queryBigQuery(sql: string, serviceAccountJson: string) {
  const sa = JSON.parse(serviceAccountJson);

  // Create JWT for BigQuery API
  const jwt = new JWT({
    key: sa.private_key,
    email: sa.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
  });

  const token = await jwt.getToken();

  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/queries`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      maxResults: 50000,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`BigQuery error ${res.status}: ${err}`);
  }

  const result = await res.json();

  // Transform BigQuery response to simple JSON array
  if (!result.rows) return [];

  const fields = result.schema.fields.map((f: any) => ({
    name: f.name,
    type: f.type,
  }));

  return result.rows.map((row: any) =>
    Object.fromEntries(
      row.f.map((cell: any, i: number) => {
        let val = cell.v;
        // Type coercion
        if (val !== null && val !== undefined) {
          if (fields[i].type === 'INTEGER' || fields[i].type === 'INT64') val = parseInt(val);
          else if (fields[i].type === 'FLOAT' || fields[i].type === 'FLOAT64') val = parseFloat(val);
          else if (fields[i].type === 'BOOLEAN' || fields[i].type === 'BOOL') val = val === 'true';
        }
        return [fields[i].name, val];
      })
    )
  );
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    const { query } = await req.json();

    if (!query || !QUERIES[query]) {
      return new Response(
        JSON.stringify({ error: `Unknown query: ${query}. Available: ${Object.keys(QUERIES).join(', ')}` }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const serviceAccountJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_DASHBOARD');
    if (!serviceAccountJson) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_DASHBOARD secret not set');
    }

    const sql = QUERIES[query];
    const data = await queryBigQuery(sql, serviceAccountJson);

    return new Response(
      JSON.stringify({ data, count: data.length, query }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('bq-dashboard error:', err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
