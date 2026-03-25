/**
 * bpos-db.js — PGM BPOS Supabase Client
 * Include this in every module that needs database access:
 *   <script src="bpos-db.js"></script>
 *
 * NEVER put the service_role key here. Anon key only.
 */

const SUPABASE_URL  = 'https://hpsvhffjebeuqutwpkaa.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhwc3ZoZmZqZWJldXF1dHdwa2FhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NTI3NTQsImV4cCI6MjA5MDAyODc1NH0.xAjHM7s6IphX_oOA_Qma4sspmlLywX209EssAursr0w';

// ── Low-level fetch wrapper ──────────────────────────────────
async function sbFetch(path, opts = {}) {
  const url = SUPABASE_URL + '/rest/v1/' + path;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'apikey':        SUPABASE_ANON,
      'Authorization': 'Bearer ' + SUPABASE_ANON,
      'Content-Type':  'application/json',
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase error ' + res.status + ': ' + err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── PROPERTIES ──────────────────────────────────────────────
const DB = {

  // ── Properties ──
  async getProperties() {
    return sbFetch('properties?select=*&order=name.asc');
  },

  async upsertProperty(prop) {
    // prop: {id?, name, address, units, pm, market, type}
    const body = {
      name:    prop.name,
      address: prop.address || '—',
      units:   prop.units   || 0,
      pm:      prop.pm      || 'AppFolio',
      market:  prop.market  || '',
      type:    prop.type    || 'existing',
    };
    if (prop.id && !prop.id.toString().includes('.')) body.id = prop.id; // uuid only
    return sbFetch('properties', {
      method:  body.id ? 'PATCH' : 'POST',
      prefer:  'return=representation',
      body:    JSON.stringify(body),
      headers: body.id ? {'Content-Type':'application/json'} : {},
    }).then(rows => rows?.[0] || rows);
  },

  async saveProperty(prop) {
    if (prop.supabaseId) {
      // Update existing
      return sbFetch('properties?id=eq.' + prop.supabaseId, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify({
          name: prop.name, address: prop.address,
          units: prop.units, pm: prop.pm,
          market: prop.market, type: prop.type,
        }),
      }).then(rows => rows?.[0]);
    } else {
      // Insert new
      return sbFetch('properties', {
        method: 'POST',
        prefer: 'return=representation',
        body: JSON.stringify({
          name: prop.name, address: prop.address || '—',
          units: prop.units || 0, pm: prop.pm || 'AppFolio',
          market: prop.market || '', type: prop.type || 'existing',
        }),
      }).then(rows => rows?.[0]);
    }
  },

  // ── Budgets ──
  async getBudgetsForProperty(supabaseId) {
    return sbFetch('budgets?property_id=eq.' + supabaseId + '&order=year.desc');
  },

  async saveBudget(supabaseId, year, budget) {
    // budget: {income_lines, expense_lines, nonop_lines, capex_budget}
    const body = {
      property_id:   supabaseId,
      year:          year,
      income_lines:  budget.income  || budget.income_lines  || [],
      expense_lines: budget.expenses || budget.expense_lines || [],
      nonop_lines:   budget.nonop   || budget.nonop_lines   || [],
      capex_budget:  budget.capexBudget || budget.capex_budget || 0,
    };
    // Upsert: if row exists for this property+year, update it
    return sbFetch('budgets', {
      method:  'POST',
      prefer:  'resolution=merge-duplicates,return=representation',
      headers: {'Prefer': 'resolution=merge-duplicates,return=representation'},
      body:    JSON.stringify(body),
    }).then(rows => rows?.[0]);
  },

  // ── Actuals ──
  async getActualsForProperty(supabaseId, year) {
    let path = 'actuals?property_id=eq.' + supabaseId + '&order=month.asc';
    if (year) path += '&year=eq.' + year;
    return sbFetch(path);
  },

  async saveActuals(supabaseId, year, month, actualsData) {
    const body = {
      property_id:    supabaseId,
      year:           year,
      month:          month,
      income_values:  actualsData.income   || [],
      expense_values: actualsData.expenses || [],
      capex_spent:    actualsData.capexSpent    || 0,
      occupancy:      actualsData.occupancy     || 0,
      collections:    actualsData.collections   || 0,
      unit_rents:     actualsData.unitRents     || [],
      source:         actualsData.source        || 'upload',
    };
    return sbFetch('actuals', {
      method:  'POST',
      prefer:  'resolution=merge-duplicates,return=representation',
      headers: {'Prefer': 'resolution=merge-duplicates,return=representation'},
      body:    JSON.stringify(body),
    }).then(rows => rows?.[0]);
  },

  // ── Alert Log ──
  async getAlertLog(limit = 50) {
    return sbFetch('alert_log?order=created_at.desc&limit=' + limit +
      '&dismissed=eq.false');
  },

  async logAlert(propertyId, alert) {
    return sbFetch('alert_log', {
      method: 'POST',
      body: JSON.stringify({
        property_id:   propertyId,
        severity:      alert.sev,
        category:      alert.category || 'general',
        message:       alert.text || alert.msg || '',
        threshold_key: alert.key || null,
        variance_pct:  alert.variancePct || null,
        budget_val:    alert.budgetVal   || null,
        actual_val:    alert.actualVal   || null,
      }),
    }).then(rows => rows?.[0]);
  },

  async dismissAlert(alertId) {
    return sbFetch('alert_log?id=eq.' + alertId, {
      method: 'PATCH',
      body:   JSON.stringify({ dismissed: true }),
    });
  },

  async resolveAlert(alertId) {
    return sbFetch('alert_log?id=eq.' + alertId, {
      method: 'PATCH',
      body:   JSON.stringify({ resolved: true }),
    });
  },

  async clearAllAlerts() {
    return sbFetch('alert_log?dismissed=eq.false', {
      method: 'PATCH',
      body:   JSON.stringify({ dismissed: true }),
    });
  },

  // ── Alert Thresholds ──
  async getThresholds() {
    const rows = await sbFetch('alert_thresholds?select=*&limit=1');
    return rows?.[0] || null;
  },

  async saveThresholds(t) {
    const rows = await sbFetch('alert_thresholds?select=id&limit=1');
    const id   = rows?.[0]?.id;
    if (!id) return;
    return sbFetch('alert_thresholds?id=eq.' + id, {
      method: 'PATCH',
      body: JSON.stringify({
        noi_miss_pct:          t.noiMissPct?.value        ?? 5,
        noi_enabled:           t.noiMissPct?.enabled      ?? true,
        occupancy_min:         t.occupancyMin?.value      ?? 88,
        occupancy_enabled:     t.occupancyMin?.enabled    ?? true,
        expense_pace_pct:      t.expensePacePct?.value    ?? 80,
        expense_pace_enabled:  t.expensePacePct?.enabled  ?? true,
        capex_hit_pct:         t.capexHit?.value          ?? 100,
        capex_enabled:         t.capexHit?.enabled        ?? true,
        unit_rent_below_pct:   t.unitRentBelowPct?.value  ?? 5,
        unit_rent_enabled:     t.unitRentBelowPct?.enabled ?? true,
        collections_min:       t.collectionsMin?.value    ?? 95,
        collections_enabled:   t.collectionsMin?.enabled  ?? true,
        cf_negative_enabled:   t.cfNegative?.enabled      ?? true,
      }),
    });
  },

  // ── NOI History ──
  async saveNOIHistory(supabaseId, year, month, noi) {
    return sbFetch('noi_history', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      headers: {'Prefer': 'resolution=merge-duplicates,return=representation'},
      body: JSON.stringify({ property_id: supabaseId, year, month, noi }),
    });
  },

  async getNOIHistory(supabaseId, year) {
    return sbFetch('noi_history?property_id=eq.' + supabaseId +
      '&year=eq.' + year + '&order=month.asc');
  },
};

// ── Connection test (called on page load) ───────────────────
async function testSupabaseConnection() {
  try {
    await sbFetch('properties?select=id&limit=1');
    console.log('[BPOS] Supabase connected ✓');
    return true;
  } catch (e) {
    console.warn('[BPOS] Supabase connection failed:', e.message);
    return false;
  }
}
