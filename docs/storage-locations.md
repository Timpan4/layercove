# Storage locations

Storage locations are a catalog of physical places where spools live, such as shelves, drawers, and dry boxes.

## Terms

| UI label | Meaning |
|---|---|
| **Location** (inventory table column) | AMS slot or printer assignment, for example `H2D-1 B4` |
| **Storage Location** | Shelf, drawer, or box where the spool is kept when it is not loaded |
| **Storage Locations** dialog | The catalog, with a spool count per location |

## Use

1. On the Inventory page, click **Locations**.
2. Click **Add Location** and enter a name, for example `Shelf A`.
3. In the spool form, pick the location from the **Storage Location** dropdown.
4. Click a location row in the dialog to filter the inventory by that location.

![Storage Locations dialog](screenshots/storage-locations/locations-page.png)

![Storage Location field in the spool form](screenshots/storage-locations/spool-form-storage-location.png)

![Inventory filtered by storage location](screenshots/storage-locations/inventory-location-filter.png)

## Spoolman mode

LayerCove keeps its own location catalog. With Spoolman enabled:

- Assigning a location writes the location name to the Spoolman spool's `location` field.
- Loading the Spoolman spool list, or changing the Spoolman settings, adds location names already used in Spoolman to the catalog.
- Renaming a location renames it on every Spoolman spool through `PATCH /location/{name}`, falling back to updating spools one by one.

## Data model

- The `locations` table holds each location's `name` and a case-insensitive `name_key`.
- `spool.location_id` is the source of truth for a spool's location.
- `spool.storage_location` is a derived display string and the value sent to Spoolman. `location_service.resolve_spool_location_fields()` sets it whenever a write changes the spool's location.
- The frontend spool form sends only `location_id`.

Tests: `backend/tests/integration/test_locations_api.py` and `backend/tests/unit/test_location_service.py`.
