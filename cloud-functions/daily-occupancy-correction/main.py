"""
daily-occupancy-correction
──────────────────────────
Rewrites `rent_roll_snapshots.is_physically_occupied` for the current month using
Buildium's own occupancy signals.

Why this exists
---------------
`daily-rent-roll-sync` derives occupancy from lease STATUS alone. Buildium leaves leases
flagged `Active` long after they end, so units with nobody in them are counted occupied.
Worked example: Park Place unit 1416-11 carries lease 658173 —

    LeaseStatus:              Active
    LeaseToDate:              2023-10-31      <- ended nearly three years ago
    CurrentTenants:           []
    CurrentNumberOfOccupants: 0

Every signal needed to know that unit is vacant was already in the API response. Using
status alone reported portfolio occupancy of 86.64% against a true 82.40% — a 4.2 point
overstatement, and 166 units counted occupied with nobody in them.

The rule
--------
    occupied = unit.IsUnitOccupied AND the unit's lease has CurrentTenants

Validated 2026-08-25 against the Buildium Rent Roll export of 2026-08-24: agreement on
4,779 of 4,784 units (99.90%), giving 82.30% against the report's 82.40%. The five
residual units are same-day timing (report as-of 8/24, API pull 8/25).

Neither signal alone is sufficient: lease status gives 86.64%, `IsUnitOccupied` on its own
gives 98.54% agreement, and excluding expired leases outright gives 68.51% — that last one
is wrong because `FixedWithRollover` leases legitimately roll to month-to-month with the
tenant still in place.

Deployment note
---------------
This is a corrector, not a replacement. It runs AFTER daily-rent-roll-sync and overwrites
the flag it produced. The cleaner long-term fix is to apply this same rule inside
daily-rent-roll-sync and retire this function — that needs read access to its source.

  gcloud functions deploy daily-occupancy-correction \
    --gen2 --runtime=python311 --region=us-central1 \
    --entry-point=daily_occupancy_correction --trigger-http --timeout=900s --memory=512M \
    --set-env-vars=GCP_PROJECT_ID=api-data-pull-492404,BQ_DATASET=buildium_data

Schedule it ~15 minutes after daily-rent-roll-sync.
"""
import os
import logging
from typing import Any, Dict, List

import requests
from google.cloud import bigquery

BUILDIUM_BASE = "https://api.buildium.com/v1"
PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "api-data-pull-492404")
DATASET = os.environ.get("BQ_DATASET", "buildium_data")
TABLE = f"{PROJECT_ID}.{DATASET}.rent_roll_snapshots"

log = logging.getLogger(__name__)


def _headers() -> Dict[str, str]:
    return {
        "x-buildium-client-id": os.environ["BUILDIUM_CLIENT_ID"],
        "x-buildium-client-secret": os.environ["BUILDIUM_CLIENT_SECRET"],
        "Accept": "application/json",
    }


def _get_all(path: str, limit: int = 200, **params: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    offset = 0
    while True:
        r = requests.get(
            f"{BUILDIUM_BASE}{path}",
            headers=_headers(),
            params={"limit": limit, "offset": offset, **params},
            timeout=90,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        out.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return out


def compute_occupancy() -> List[Dict[str, Any]]:
    """One row per unit: {unit_id, occupied} under the validated rule."""
    units = _get_all("/rentals/units")
    leases = _get_all("/leases", limit=500, leasestatuses="Active")

    # A unit is only occupied if some lease on it still has current tenants. Buildium
    # empties CurrentTenants on move-out even while LeaseStatus stays 'Active'.
    tenants: Dict[int, int] = {}
    for l in leases:
        uid = l.get("UnitId")
        if uid is None:
            continue
        tenants[int(uid)] = tenants.get(int(uid), 0) + len(l.get("CurrentTenants") or [])

    return [
        {
            "unit_id": int(u["Id"]),
            "occupied": bool(u.get("IsUnitOccupied")) and tenants.get(int(u["Id"]), 0) > 0,
        }
        for u in units
    ]


MERGE_SQL = f"""
MERGE `{TABLE}` T
USING `{{staging}}` S
ON T.unit_id = S.unit_id
   AND T.snapshot_month = FORMAT_DATE('%Y-%m', CURRENT_DATE())
WHEN MATCHED AND T.is_physically_occupied != S.occupied THEN
  UPDATE SET is_physically_occupied = S.occupied
"""


def daily_occupancy_correction(request=None):
    rows = compute_occupancy()
    if not rows:
        raise RuntimeError("Buildium returned no units — refusing to update occupancy")

    # A wildly different occupied count means something upstream changed shape; better to
    # fail loudly than to silently rewrite the portfolio's occupancy.
    occupied = sum(1 for r in rows if r["occupied"])
    if occupied < len(rows) * 0.3:
        raise RuntimeError(
            f"occupancy sanity check failed: {occupied} of {len(rows)} units occupied"
        )

    client = bigquery.Client(project=PROJECT_ID)
    staging = f"{PROJECT_ID}.{DATASET}._staging_occupancy"

    client.load_table_from_json(
        rows,
        staging,
        job_config=bigquery.LoadJobConfig(
            write_disposition="WRITE_TRUNCATE",
            schema=[
                bigquery.SchemaField("unit_id", "INT64"),
                bigquery.SchemaField("occupied", "BOOL"),
            ],
        ),
    ).result()

    job = client.query(MERGE_SQL.format(staging=staging))
    job.result()
    changed = job.num_dml_affected_rows
    client.delete_table(staging, not_found_ok=True)

    msg = (
        f"occupancy corrected — {len(rows)} units from Buildium, "
        f"{occupied} occupied, {changed} rows changed"
    )
    log.info(msg)
    return (msg, 200)


if __name__ == "__main__":
    print(daily_occupancy_correction())
