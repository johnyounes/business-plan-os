"""
daily-properties-sync
─────────────────────
Keeps `buildium_data.properties` in step with Buildium.

Why this exists
---------------
There was no properties sync. `properties` was a static reference load whose highest
property_id was 185,164, so every property created after that — the whole TWC portfolio —
was silently absent. That single stale table caused:

  * 60 active properties / 771 units missing from the dashboard's property list
  * ~$532K of August income with no financial rows (the financial sync iterates properties)
  * 583 of 885 missing leases
  * 7 properties carrying stale names, which drops their rows from v_rent_roll and
    v_vacancy entirely because those views match on property_name with no property_id

A one-off backfill fixed the data on 2026-08-24. This function stops it recurring.

Behaviour
---------
Full MERGE on every run: inserts new properties, updates changed ones (including renames),
never deletes. Unit counts come from /rentals/units so `units` stays accurate as units are
added or removed.

Deploy
------
  gcloud functions deploy daily-properties-sync \
    --gen2 --runtime=python311 --region=us-central1 \
    --entry-point=daily_properties_sync --trigger-http --timeout=900s --memory=512M \
    --set-env-vars=GCP_PROJECT_ID=api-data-pull-492404,BQ_DATASET=buildium_data

Supply the two Buildium credentials the same way the other sync functions receive theirs.
Schedule this a few minutes BEFORE daily-financial-sync and daily-rent-roll-sync so those
runs see a current roster.
"""
import os
import logging
from typing import Any, Dict, List

import requests
from google.cloud import bigquery

BUILDIUM_BASE = "https://api.buildium.com/v1"
PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "api-data-pull-492404")
DATASET = os.environ.get("BQ_DATASET", "buildium_data")
TABLE = f"{PROJECT_ID}.{DATASET}.properties"

log = logging.getLogger(__name__)


def _headers() -> Dict[str, str]:
    return {
        "x-buildium-client-id": os.environ["BUILDIUM_CLIENT_ID"],
        "x-buildium-client-secret": os.environ["BUILDIUM_CLIENT_SECRET"],
        "Accept": "application/json",
    }


def _get_all(path: str, limit: int = 200) -> List[Dict[str, Any]]:
    """Page through a Buildium collection endpoint until it stops returning a full page.

    Buildium caps `limit`, so paging is mandatory — reading a single page is exactly how
    a roster silently stops growing.
    """
    out: List[Dict[str, Any]] = []
    offset = 0
    while True:
        r = requests.get(
            f"{BUILDIUM_BASE}{path}",
            headers=_headers(),
            params={"limit": limit, "offset": offset},
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


def _rows() -> List[Dict[str, Any]]:
    props = _get_all("/rentals")
    units = _get_all("/rentals/units")

    unit_counts: Dict[int, int] = {}
    for u in units:
        pid = u.get("PropertyId")
        if pid is not None:
            unit_counts[int(pid)] = unit_counts.get(int(pid), 0) + 1

    rows = []
    for p in props:
        pid = int(p["Id"])
        name = (p.get("Name") or "").strip()
        addr = p.get("Address") or {}
        n_units = unit_counts.get(pid, 0)
        rows.append(
            {
                "property_id": pid,
                # All three name columns are kept in step. Downstream views match on
                # property_name with no id, so a stale name here loses rows silently.
                "property_name": name,
                "api_name": name,
                "t12_name": name,
                "units": n_units,
                "number_units": n_units,
                "is_active": bool(p.get("IsActive")),
                "rental_type": p.get("RentalType"),
                "rental_sub_type": p.get("RentalSubType"),
                "address_line1": addr.get("AddressLine1"),
                "city": addr.get("City"),
                "state": addr.get("State"),
                "postal_code": addr.get("PostalCode"),
                "year_built": p.get("YearBuilt"),
                "structure_description": p.get("StructureDescription"),
            }
        )
    return rows


SCHEMA = [
    bigquery.SchemaField("property_id", "INT64"),
    bigquery.SchemaField("property_name", "STRING"),
    bigquery.SchemaField("api_name", "STRING"),
    bigquery.SchemaField("t12_name", "STRING"),
    bigquery.SchemaField("units", "INT64"),
    bigquery.SchemaField("number_units", "INT64"),
    bigquery.SchemaField("is_active", "BOOL"),
    bigquery.SchemaField("rental_type", "STRING"),
    bigquery.SchemaField("rental_sub_type", "STRING"),
    bigquery.SchemaField("address_line1", "STRING"),
    bigquery.SchemaField("city", "STRING"),
    bigquery.SchemaField("state", "STRING"),
    bigquery.SchemaField("postal_code", "STRING"),
    bigquery.SchemaField("year_built", "INT64"),
    bigquery.SchemaField("structure_description", "STRING"),
]

MERGE_SQL = f"""
MERGE `{TABLE}` T
USING `{{staging}}` S
ON T.property_id = S.property_id
WHEN MATCHED THEN UPDATE SET
  property_name = S.property_name, api_name = S.api_name, t12_name = S.t12_name,
  units = S.units, number_units = S.number_units, is_active = S.is_active,
  rental_type = S.rental_type, rental_sub_type = S.rental_sub_type,
  address_line1 = S.address_line1, city = S.city, state = S.state,
  postal_code = S.postal_code, year_built = S.year_built,
  structure_description = S.structure_description
WHEN NOT MATCHED THEN INSERT (
  property_id, property_name, api_name, t12_name, units, number_units, is_active,
  rental_type, rental_sub_type, address_line1, city, state, postal_code,
  year_built, structure_description
) VALUES (
  S.property_id, S.property_name, S.api_name, S.t12_name, S.units, S.number_units,
  S.is_active, S.rental_type, S.rental_sub_type, S.address_line1, S.city, S.state,
  S.postal_code, S.year_built, S.structure_description
)
"""


def daily_properties_sync(request=None):
    rows = _rows()
    if not rows:
        # Never let an empty or partial API response touch the table.
        raise RuntimeError("Buildium returned no properties — refusing to MERGE")

    client = bigquery.Client(project=PROJECT_ID)
    staging = f"{PROJECT_ID}.{DATASET}._staging_properties"

    load = client.load_table_from_json(
        rows,
        staging,
        job_config=bigquery.LoadJobConfig(
            write_disposition="WRITE_TRUNCATE", schema=SCHEMA
        ),
    )
    load.result()

    client.query(MERGE_SQL.format(staging=staging)).result()
    client.delete_table(staging, not_found_ok=True)

    total = list(client.query(f"SELECT COUNT(*) n FROM `{TABLE}`").result())[0].n
    msg = f"properties sync ok — {len(rows)} from Buildium, {total} in table"
    log.info(msg)
    return (msg, 200)


if __name__ == "__main__":
    print(daily_properties_sync())
