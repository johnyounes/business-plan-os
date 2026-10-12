"""
Cloud Function: Daily Snapshot Sync
====================================
Runs daily at 6am PST via Cloud Scheduler.
Pulls current month financial + rent roll data from Buildium API
and writes directly to BigQuery (no JSONL files, no manual upload).

TRIGGERS:
  - Cloud Scheduler HTTP trigger (daily at 6am PST)
  - Manual HTTP GET/POST for on-demand pulls

BEHAVIOR:
  - Determines current month (based on PST timezone)
  - On 1st of month: locks previous month in snapshot_metadata, then pulls new month
  - Pulls financial data: GL entries for all mapped income/expense accounts
  - Pulls rent roll data: units + leases for current occupancy snapshot
  - Writes directly to BigQuery using streaming inserts
  - Deletes existing current-month data before inserting (idempotent)

ENVIRONMENT VARIABLES (set in Cloud Function config):
  - BUILDIUM_CLIENT_ID
  - BUILDIUM_CLIENT_SECRET
  - GCP_PROJECT_ID (default: api-data-pull-492404)
  - BQ_DATASET (default: buildium_data)

DEPLOYMENT:
  gcloud functions deploy daily-snapshot-sync \
    --runtime python311 \
    --trigger-http \
    --allow-unauthenticated \
    --region us-central1 \
    --timeout 540 \
    --memory 512MB \
    --set-env-vars BUILDIUM_CLIENT_ID=xxx,BUILDIUM_CLIENT_SECRET=xxx

CLOUD SCHEDULER:
  gcloud scheduler jobs create http daily-snapshot-6am \
    --schedule="0 6 * * *" \
    --time-zone="America/Los_Angeles" \
    --uri="https://REGION-PROJECT.cloudfunctions.net/daily-snapshot-sync" \
    --http-method=POST
"""

import json
import os
import logging
from datetime import datetime, date, timedelta
from calendar import monthrange
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# BigQuery client — imported at runtime in Cloud Functions
try:
    from google.cloud import bigquery
    BQ_AVAILABLE = True
except ImportError:
    BQ_AVAILABLE = False
    logging.warning("google-cloud-bigquery not installed. BQ writes disabled.")

# ============================================================
# Configuration
# ============================================================
BUILDIUM_BASE_URL = "https://api.buildium.com/v1"
GCP_PROJECT = os.environ.get('GCP_PROJECT_ID', 'api-data-pull-492404')
BQ_DATASET = os.environ.get('BQ_DATASET', 'buildium_data')
ACCOUNTING_BASIS = 'Cash'
# Buildium caps `limit` at 1000. Requesting 5000 also made _paginate stop after the
# first page, because `len(batch) < limit_val` was true for any real result.
GL_ENTRY_LIMIT = 1000

# These are loaded from BigQuery or environment
BUILDIUM_CLIENT_ID = os.environ.get('BUILDIUM_CLIENT_ID', '')
BUILDIUM_CLIENT_SECRET = os.environ.get('BUILDIUM_CLIENT_SECRET', '')

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('daily_sync')


# ============================================================
# Buildium API Client
# ============================================================
class BuildiumAPI:
    def __init__(self, client_id=None, client_secret=None):
        self.base_url = BUILDIUM_BASE_URL
        self.client_id = client_id or BUILDIUM_CLIENT_ID
        self.client_secret = client_secret or BUILDIUM_CLIENT_SECRET

    def _request(self, endpoint, params=None):
        url = f"{self.base_url}{endpoint}"
        if params:
            query = '&'.join(f"{k}={v}" for k, v in params.items() if v is not None)
            url = f"{url}?{query}"

        req = Request(url)
        req.add_header('x-buildium-client-id', self.client_id)
        req.add_header('x-buildium-client-secret', self.client_secret)
        req.add_header('Accept', 'application/json')

        try:
            resp = urlopen(req)
            return json.loads(resp.read().decode())
        except HTTPError as e:
            error_body = e.read().decode() if e.fp else ''
            raise Exception(f"API error {e.code} on {endpoint}: {error_body}")

    def _paginate(self, endpoint, params=None, limit_val=1000):
        results = []
        offset = 0
        params = params or {}
        while True:
            p = {**params, 'limit': limit_val, 'offset': offset}
            batch = self._request(endpoint, p)
            if not batch:
                break
            results.extend(batch)
            if len(batch) < limit_val:
                break
            offset += limit_val
        return results

    def get_gl_entries(self, gl_account_id, start_date, end_date):
        """GL entries for one account, splitting the window when Buildium refuses it.

        /generalledger rejects a query whose result set is too large with HTTP 422
        ("Your search criteria returned too many results") — regardless of `limit`.
        Rent Income (gl 3) crossed that threshold for a full calendar month in
        2026-08. The caller treated the exception as "no data for this account" and
        skipped it, so ~$3.2M of August rent silently vanished from every P&L. Nothing
        in the code changed; the portfolio simply outgrew a single-request window.

        Halving the range on 422 is the fix, and it scales: as volume keeps growing,
        accounts just split into more pieces.
        """
        return self._get_gl_entries_range(gl_account_id, start_date, end_date, depth=0)

    def _get_gl_entries_range(self, gl_account_id, start_date, end_date, depth=0):
        try:
            return self._paginate('/generalledger', {
                'glaccountids': gl_account_id,
                'startdate': start_date,
                'enddate': end_date,
                'accountingbasis': ACCOUNTING_BASIS,
            }, limit_val=GL_ENTRY_LIMIT)
        except Exception as e:
            too_many = 'too many results' in str(e).lower() or 'API error 422' in str(e)
            start_d = date.fromisoformat(start_date)
            end_d = date.fromisoformat(end_date)
            # A single day that still fails cannot be split further — let it raise so the
            # caller logs a real failure rather than silently reporting zero.
            if not too_many or depth >= 6 or start_d >= end_d:
                raise

            mid = start_d + (end_d - start_d) // 2
            logger.info(
                f"  GL {gl_account_id}: range {start_date}..{end_date} too large, "
                f"splitting at {mid.isoformat()} (depth {depth + 1})"
            )
            left = self._get_gl_entries_range(gl_account_id, start_date, mid.isoformat(), depth + 1)
            right = self._get_gl_entries_range(
                gl_account_id, (mid + timedelta(days=1)).isoformat(), end_date, depth + 1
            )
            return left + right

    def get_rental_units(self):
        return self._paginate('/rentals/units', {}, limit_val=1000)

    def get_leases(self, statuses='Active,Past,Future'):
        # Must include 'Past' to capture ended leases — required for accurate
        # historical rent roll reconstruction.
        return self._paginate('/leases', {'leasestatuses': statuses}, limit_val=1000)

    def get_properties(self):
        return self._paginate('/rentals', {}, limit_val=1000)


# ============================================================
# BigQuery Client
# ============================================================
class BQClient:
    def __init__(self):
        if not BQ_AVAILABLE:
            raise RuntimeError("google-cloud-bigquery not installed")
        self.client = bigquery.Client(project=GCP_PROJECT)
        self.dataset = BQ_DATASET

    def table_ref(self, table_name):
        return f"{GCP_PROJECT}.{self.dataset}.{table_name}"

    def delete_month(self, table_name, month_str):
        """Delete all rows for a given month (idempotent re-pull)."""
        query = f"""
            DELETE FROM `{self.table_ref(table_name)}`
            WHERE snapshot_month = '{month_str}'
        """
        logger.info(f"Deleting {table_name} data for {month_str}")
        job = self.client.query(query)
        job.result()
        logger.info(f"Deleted {job.num_dml_affected_rows} rows from {table_name} for {month_str}")

    def insert_rows(self, table_name, rows):
        """Insert rows directly into BigQuery using streaming insert."""
        if not rows:
            logger.info(f"No rows to insert into {table_name}")
            return

        table = self.client.get_table(self.table_ref(table_name))
        errors = self.client.insert_rows_json(table, rows)
        if errors:
            logger.error(f"BigQuery insert errors on {table_name}: {errors[:5]}")
            raise RuntimeError(f"BQ insert failed: {errors[:5]}")
        logger.info(f"Inserted {len(rows)} rows into {table_name}")

    def lock_month(self, data_type, month_str):
        """Lock a month in snapshot_metadata (prevents accidental overwrite)."""
        query = f"""
            MERGE `{self.table_ref('snapshot_metadata')}` t
            USING (SELECT '{data_type}' AS data_type, '{month_str}' AS snapshot_month) s
            ON t.data_type = s.data_type AND t.snapshot_month = s.snapshot_month
            WHEN MATCHED THEN
              UPDATE SET is_locked = TRUE, last_updated = CURRENT_TIMESTAMP()
            WHEN NOT MATCHED THEN
              INSERT (data_type, snapshot_month, snapshot_date, is_locked, created_at, last_updated, pull_type, notes)
              VALUES (s.data_type, s.snapshot_month, DATE('{month_str}-01'), TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), 'auto_lock', 'Locked by daily sync on month rollover')
        """
        job = self.client.query(query)
        job.result()
        logger.info(f"Locked {data_type} for {month_str}")

    def update_metadata(self, data_type, month_str, record_count, snap_date):
        """Update or insert snapshot metadata for current pull."""
        query = f"""
            MERGE `{self.table_ref('snapshot_metadata')}` t
            USING (SELECT '{data_type}' AS data_type, '{month_str}' AS snapshot_month) s
            ON t.data_type = s.data_type AND t.snapshot_month = s.snapshot_month
            WHEN MATCHED THEN
              UPDATE SET
                record_count = {record_count},
                snapshot_date = '{snap_date}',
                last_updated = CURRENT_TIMESTAMP(),
                pull_type = 'daily',
                is_locked = FALSE
            WHEN NOT MATCHED THEN
              INSERT (data_type, snapshot_month, snapshot_date, is_locked, record_count, created_at, last_updated, pull_type, notes)
              VALUES (s.data_type, s.snapshot_month, '{snap_date}', FALSE, {record_count}, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), 'daily', 'Daily auto-pull')
        """
        job = self.client.query(query)
        job.result()

    def get_gl_classification(self):
        """Load GL account classification (recurring/non-recurring) from BQ."""
        query = f"SELECT gl_id, is_recurring_income FROM `{self.table_ref('gl_account_classification')}`"
        try:
            results = self.client.query(query).result()
            return {row.gl_id: row.is_recurring_income for row in results}
        except Exception:
            logger.warning("gl_account_classification table not found — skipping")
            return {}


# ============================================================
# GL Account Mapping (loaded from local file or BQ)
# ============================================================
def load_gl_accounts():
    """Load the enriched GL account mapping."""
    # In Cloud Function, this file is deployed alongside main.py
    for path in ['gl_accounts_enriched.json', '../gl_accounts_enriched.json']:
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)

    raise FileNotFoundError("gl_accounts_enriched.json not found. Deploy it with the Cloud Function.")


def load_property_matches():
    """Load property mapping."""
    for path in ['property_matches.json', '../property_matches.json']:
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)

    raise FileNotFoundError("property_matches.json not found. Deploy it with the Cloud Function.")


def load_exclude_keywords():
    """Load exclude keywords from config or hardcode."""
    for path in ['config.json', '../config.json']:
        if os.path.exists(path):
            with open(path) as f:
                config = json.load(f)
            return config.get('exclude_property_keywords', [])
    return []


# ============================================================
# Month Utilities
# ============================================================
def get_pst_today():
    """Get today's date in PST (UTC-8, not accounting for DST)."""
    # For production, use pytz: datetime.now(pytz.timezone('America/Los_Angeles'))
    # Simple offset for Cloud Functions:
    from datetime import timezone
    utc_now = datetime.now(timezone.utc)
    pst_offset = timezone(timedelta(hours=-7))  # PDT (Apr-Oct)
    pst_now = utc_now.astimezone(pst_offset)
    return pst_now.date()


def month_end(year, month):
    _, last = monthrange(year, month)
    return date(year, month, last)


def previous_month(year, month):
    if month == 1:
        return year - 1, 12
    return year, month - 1


# ============================================================
# Financial Pull: Current Month
# ============================================================
def pull_financial_current_month(api, bq, current_month, snap_date, gl_accounts, property_map, exclude_keywords):
    """Pull GL entries for current month and write to BigQuery."""
    pass_through_ids = set()  # Loaded from config if needed

    # Filter to mapped Income/Expense accounts only
    gl_to_query = [
        a for a in gl_accounts
        if a.get('type') in ('Income', 'Expense') and a.get('is_mapped', False)
    ]
    logger.info(f"Querying {len(gl_to_query)} GL accounts for {current_month}")

    property_ids = set(property_map.keys())
    y, m = int(current_month[:4]), int(current_month[5:7])
    start = f"{y}-{m:02d}-01"
    # Use full calendar month as end date so future-dated entries within
    # the current month are included. Previously used snap_date (today),
    # which silently dropped entries dated later in the month.
    end = f"{y}-{m:02d}-{monthrange(y, m)[1]:02d}"

    all_snapshots = {}
    failed_accounts = []

    for i, gl_acct in enumerate(gl_to_query):
        if (i + 1) % 50 == 0:
            logger.info(f"  Progress: {i+1}/{len(gl_to_query)} GL accounts...")

        try:
            entries = api.get_gl_entries(gl_acct['id'], start, end)
        except Exception as e:
            # Record the failure instead of letting it pass as "this account had no
            # activity". A skipped account is indistinguishable from a genuinely empty
            # one in the output, which is how the August rent gap went unnoticed for
            # three weeks.
            logger.error(f"  ERROR on GL {gl_acct['id']} ({gl_acct.get('name', '')}): {e}")
            failed_accounts.append((gl_acct['id'], gl_acct.get('name', ''), str(e)))
            continue

        for gl_result in entries:
            for entry in gl_result.get('Entries', []):
                entity = entry.get('AccountingEntity', {})
                prop_id = entity.get('Id')
                prop_name = entity.get('Name', '')

                if not prop_id or prop_id not in property_ids:
                    continue
                if any(kw.lower() in prop_name.lower() for kw in exclude_keywords):
                    continue

                amount = entry.get('Amount', 0)
                key = (current_month, prop_id, gl_acct['id'])

                if key not in all_snapshots:
                    t12_section = gl_acct.get('t12_section')
                    if not t12_section:
                        sub = gl_acct.get('subType', '')
                        if sub == 'NonOperatingExpenses':
                            t12_section = 'non_operating_expense'
                        elif sub == 'NonOperatingIncome':
                            t12_section = 'non_operating_income'
                        else:
                            t12_section = gl_acct.get('type', '').lower()

                    is_pt = gl_acct.get('is_pass_through', gl_acct['id'] in pass_through_ids)

                    all_snapshots[key] = {
                        'snapshot_month': current_month,
                        'snapshot_date': snap_date.isoformat(),
                        'property_id': prop_id,
                        'property_name': property_map.get(prop_id, {}).get('api_name', prop_name),
                        'gl_id': gl_acct['id'],
                        'account_name': gl_acct.get('t12_name', gl_acct.get('name', '')),
                        't12_section': t12_section,
                        'account_type': gl_acct.get('type', ''),
                        'sub_type': gl_acct.get('subType', ''),
                        'is_pass_through': is_pt,
                        'total_amount': 0.0,
                        'transaction_count': 0,
                        'pull_date': datetime.utcnow().isoformat()
                    }

                all_snapshots[key]['total_amount'] += amount
                all_snapshots[key]['transaction_count'] += 1

    rows = list(all_snapshots.values())
    logger.info(f"Financial pull: {len(rows)} property-account rows for {current_month}")

    # The write below deletes the whole month before re-inserting, so publishing a
    # partial pull destroys good data. Fail loudly and leave the existing month intact.
    if failed_accounts:
        detail = '; '.join(f"{gid} ({name}): {err}" for gid, name, err in failed_accounts)
        raise RuntimeError(
            f"{len(failed_accounts)} GL account(s) failed for {current_month}; "
            f"refusing to overwrite the month with an incomplete pull -- {detail}"
        )

    # Delete existing current month data, then insert fresh
    bq.delete_month('financial_snapshots', current_month)
    bq.insert_rows('financial_snapshots', rows)
    bq.update_metadata('financial', current_month, len(rows), snap_date.isoformat())

    return len(rows)


# ============================================================
# Rent Roll Pull: Current Month
# ============================================================
def pull_rent_roll_current_month(api, bq, current_month, snap_date, property_map, exclude_keywords):
    """Pull current rent roll and write to BigQuery."""
    logger.info(f"Pulling rent roll for {current_month}")

    units = api.get_rental_units()
    logger.info(f"  Got {len(units)} units")

    leases = api.get_leases('Active,Past,Future')
    logger.info(f"  Got {len(leases)} leases")

    properties = api.get_properties()
    prop_name_map = {p['Id']: p.get('Name', '') for p in properties}

    # Build lease lookups
    active_by_unit = {}
    future_by_unit = {}

    for lease in leases:
        unit = lease.get('UnitId')
        if not unit:
            continue

        status = lease.get('LeaseStatus', '')
        from_date = lease.get('LeaseFromDate', '')[:10] if lease.get('LeaseFromDate') else None
        to_date = lease.get('LeaseToDate', '')[:10] if lease.get('LeaseToDate') else None

        rent = 0
        acct = lease.get('AccountDetails', {})
        if acct:
            rent = acct.get('Rent', 0) or 0

        tenant_names = []
        for t in lease.get('Tenants', []):
            if t.get('Status') == 'Current':
                fn = t.get('FirstName', '')
                ln = t.get('LastName', '')
                tenant_names.append(f"{fn} {ln}".strip())

        raw_type = lease.get('LeaseType', '')
        lease_type = raw_type
        if raw_type == 'AtWill':
            lease_type = 'Month-to-Month'
        elif raw_type == 'FixedWithRollover':
            lease_type = 'FixedWithRollover'

        lease_data = {
            'lease_id': lease.get('Id'),
            'lease_type': lease_type,
            'rent_amount': rent,
            'lease_from': from_date,
            'lease_to': to_date,
            'tenant_names': ', '.join(tenant_names) if tenant_names else None,
            'property_id': lease.get('PropertyId'),
        }

        if status == 'Active':
            # Stale-lease detection — broadened rule (mirror of snapshot_sync.py).
            # An Active lease in Buildium can still be "actually over" — the tenant
            # has vacated but the lease record hasn't been transitioned to Past.
            # Detect via four signals; any one trips is_stale=True:
            #   R1: lease_to_date in past AND no current tenants  (original)
            #   R2: every tenant on the lease has Status='MovedOut'
            #   R3: any tenant has MoveOutDate <= snap_date  (authoritative)
            #   R4: no tenants AND lease_from_date <= snap_date  (never-moved-in)
            snap_iso = snap_date.isoformat()
            all_tenants = lease.get('Tenants') or []
            move_out_data = lease.get('MoveOutData') or []
            current_tenants_raw = lease.get('CurrentTenants') or []
            from_date_iso = (lease.get('LeaseFromDate') or '')[:10]

            is_stale = False
            if to_date and to_date < snap_iso and not tenant_names:
                is_stale = True
            if all_tenants and all(t.get('Status') == 'MovedOut' for t in all_tenants):
                is_stale = True
            for mo in move_out_data:
                mod = (mo.get('MoveOutDate') or '')[:10]
                if mod and mod <= snap_iso:
                    is_stale = True
                    break
            if not current_tenants_raw and not all_tenants and from_date_iso and from_date_iso <= snap_iso:
                is_stale = True

            if is_stale:
                continue  # Treat unit as vacant for this snapshot
            if unit not in active_by_unit:
                active_by_unit[unit] = lease_data
        elif status == 'Future':
            if unit not in future_by_unit:
                future_by_unit[unit] = lease_data

    rows = []
    for u in units:
        unit_id = u.get('Id')
        prop_id = u.get('PropertyId')
        prop_name = prop_name_map.get(prop_id, '')

        if any(kw.lower() in prop_name.lower() for kw in exclude_keywords):
            continue

        active = active_by_unit.get(unit_id)
        future = future_by_unit.get(unit_id)

        row = {
            'snapshot_month': current_month,
            'snapshot_date': snap_date.isoformat(),
            'property_id': prop_id,
            'property_name': prop_name,
            'unit_id': unit_id,
            'unit_number': u.get('UnitNumber', ''),
            'building_name': u.get('BuildingName', ''),
            'market_rent': u.get('MarketRent', 0) or 0,
            'bedrooms': u.get('Bedrooms', ''),
            'bathrooms': u.get('Bathrooms', ''),
            'unit_size_sqft': u.get('UnitSize', 0) or 0,
            'is_physically_occupied': active is not None,
            'is_preleased': active is None and future is not None,
            'is_truly_vacant': active is None and future is None,
            'active_lease_id': active['lease_id'] if active else None,
            'active_lease_type': active['lease_type'] if active else None,
            'active_rent_amount': active['rent_amount'] if active else None,
            'active_lease_from': active['lease_from'] if active else None,
            'active_lease_to': active['lease_to'] if active else None,
            'active_tenant_names': active['tenant_names'] if active else None,
            'future_lease_id': future['lease_id'] if future else None,
            'future_rent_amount': future['rent_amount'] if future else None,
            'future_lease_from': future['lease_from'] if future else None,
            'future_lease_to': future['lease_to'] if future else None,
            'pull_date': datetime.utcnow().isoformat()
        }
        rows.append(row)

    occupied = sum(1 for r in rows if r['is_physically_occupied'])
    preleased = sum(1 for r in rows if r['is_preleased'])
    vacant = sum(1 for r in rows if r['is_truly_vacant'])
    logger.info(f"Rent roll: {occupied} occupied, {preleased} preleased, {vacant} vacant ({len(rows)} total)")

    # Delete existing current month data, then insert fresh
    bq.delete_month('rent_roll_snapshots', current_month)
    bq.insert_rows('rent_roll_snapshots', rows)
    bq.update_metadata('rent_roll', current_month, len(rows), snap_date.isoformat())

    return len(rows)


# ============================================================
# Month Rollover: Lock previous month on 1st of new month
# ============================================================
def handle_month_rollover(bq, today, data_type=None):
    """
    If today is the 1st, lock previous month.
    data_type: None = lock both financial + rent_roll (legacy behavior for
    daily_snapshot_sync); 'financial' or 'rent_roll' = lock only that type
    (used by the split entry points so each job owns its own data type).
    """
    if today.day == 1:
        prev_y, prev_m = previous_month(today.year, today.month)
        prev_month_str = f"{prev_y}-{prev_m:02d}"
        logger.info(f"Month rollover detected! Locking {prev_month_str} ({data_type or 'both'})")
        if data_type is None or data_type == 'financial':
            bq.lock_month('financial', prev_month_str)
        if data_type is None or data_type == 'rent_roll':
            bq.lock_month('rent_roll', prev_month_str)
        return prev_month_str
    return None


# ============================================================
# Cloud Function Entry Point
# ============================================================
def daily_snapshot_sync(request):
    """
    HTTP Cloud Function entry point.
    Triggered daily by Cloud Scheduler or manually via HTTP.

    Query params (optional):
      ?month=2026-04  — Override target month (default: current PST month)
      ?financial_only=true  — Only pull financials
      ?rent_roll_only=true  — Only pull rent roll
    """
    try:
        # Parse optional query params
        month_override = None
        financial_only = False
        rent_roll_only = False

        if request:
            month_override = request.args.get('month')
            financial_only = request.args.get('financial_only', '').lower() == 'true'
            rent_roll_only = request.args.get('rent_roll_only', '').lower() == 'true'

        # Determine today and current month
        today = get_pst_today()
        current_month = month_override or today.strftime('%Y-%m')
        snap_date = today

        logger.info(f"=== Daily Snapshot Sync: {current_month} (today: {today}) ===")

        # Initialize clients
        api = BuildiumAPI()
        bq = BQClient()

        # Handle month rollover (lock previous month on 1st)
        locked_month = handle_month_rollover(bq, today)
        if locked_month:
            logger.info(f"Locked previous month: {locked_month}")

        # Load mapping data
        gl_accounts = load_gl_accounts()
        property_matches = load_property_matches()
        property_map = {m['api_id']: m for m in property_matches if m.get('api_id')}
        exclude_keywords = load_exclude_keywords()

        results = {
            'date': today.isoformat(),
            'month': current_month,
            'locked_previous_month': locked_month,
            'financial_rows': 0,
            'rent_roll_rows': 0,
        }

        # Pull financial data
        if not rent_roll_only:
            results['financial_rows'] = pull_financial_current_month(
                api, bq, current_month, snap_date, gl_accounts, property_map, exclude_keywords
            )

        # Pull rent roll data
        if not financial_only:
            results['rent_roll_rows'] = pull_rent_roll_current_month(
                api, bq, current_month, snap_date, property_map, exclude_keywords
            )

        logger.info(f"=== Sync complete: {results} ===")

        return json.dumps(results), 200, {'Content-Type': 'application/json'}

    except Exception as e:
        logger.error(f"Sync failed: {e}", exc_info=True)
        return json.dumps({'error': str(e)}), 500, {'Content-Type': 'application/json'}


# ============================================================
# Split Entry Points: Rent Roll and Financial (deployed as
# separate Cloud Functions to reduce timeout risk)
# ============================================================
def daily_rent_roll_sync(request):
    """
    HTTP Cloud Function entry point — rent roll only.
    Deployed as Cloud Function 'daily-rent-roll-sync'.
    Scheduled: 6:00 AM PST daily.

    Query params (optional):
      ?month=2026-04 — Override target month (default: current PST month)
    """
    try:
        month_override = request.args.get('month') if request else None
        today = get_pst_today()
        current_month = month_override or today.strftime('%Y-%m')
        snap_date = today

        logger.info(f"=== Daily Rent Roll Sync: {current_month} (today: {today}) ===")

        api = BuildiumAPI()
        bq = BQClient()

        # Lock previous month's rent roll only (not financial — that's the other job's concern)
        locked_month = handle_month_rollover(bq, today, data_type='rent_roll')
        if locked_month:
            logger.info(f"Locked previous month (rent_roll): {locked_month}")

        property_matches = load_property_matches()
        property_map = {m['api_id']: m for m in property_matches if m.get('api_id')}
        exclude_keywords = load_exclude_keywords()

        rent_roll_rows = pull_rent_roll_current_month(
            api, bq, current_month, snap_date, property_map, exclude_keywords
        )

        results = {
            'job': 'rent_roll',
            'date': today.isoformat(),
            'month': current_month,
            'locked_previous_month': locked_month,
            'rent_roll_rows': rent_roll_rows,
        }
        logger.info(f"=== Rent roll sync complete: {results} ===")
        return json.dumps(results), 200, {'Content-Type': 'application/json'}

    except Exception as e:
        logger.error(f"Rent roll sync failed: {e}", exc_info=True)
        return json.dumps({'job': 'rent_roll', 'error': str(e)}), 500, {'Content-Type': 'application/json'}


def daily_financial_sync(request):
    """
    HTTP Cloud Function entry point — financial only.
    Deployed as Cloud Function 'daily-financial-sync'.
    Scheduled: 6:15 AM PST daily.

    Query params (optional):
      ?month=2026-04 — Override target month (default: current PST month)
    """
    try:
        month_override = request.args.get('month') if request else None
        today = get_pst_today()
        current_month = month_override or today.strftime('%Y-%m')
        snap_date = today

        logger.info(f"=== Daily Financial Sync: {current_month} (today: {today}) ===")

        api = BuildiumAPI()
        bq = BQClient()

        # Lock previous month's financial only (not rent roll — that's the other job's concern)
        locked_month = handle_month_rollover(bq, today, data_type='financial')
        if locked_month:
            logger.info(f"Locked previous month (financial): {locked_month}")

        gl_accounts = load_gl_accounts()
        property_matches = load_property_matches()
        property_map = {m['api_id']: m for m in property_matches if m.get('api_id')}
        exclude_keywords = load_exclude_keywords()

        financial_rows = pull_financial_current_month(
            api, bq, current_month, snap_date, gl_accounts, property_map, exclude_keywords
        )

        results = {
            'job': 'financial',
            'date': today.isoformat(),
            'month': current_month,
            'locked_previous_month': locked_month,
            'financial_rows': financial_rows,
        }
        logger.info(f"=== Financial sync complete: {results} ===")
        return json.dumps(results), 200, {'Content-Type': 'application/json'}

    except Exception as e:
        logger.error(f"Financial sync failed: {e}", exc_info=True)
        return json.dumps({'job': 'financial', 'error': str(e)}), 500, {'Content-Type': 'application/json'}


# Allow local testing
if __name__ == '__main__':
    # For local testing, simulate a request object
    class FakeRequest:
        args = {}
    result, status, _ = daily_snapshot_sync(FakeRequest())
    print(f"Status: {status}")
    print(result)
