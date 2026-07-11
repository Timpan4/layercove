# Printer backend compatibility audit

Issue #5 adds the provider-neutral backend boundary. This inventory records every
remaining `PrinterManager.get_client()` consumer after the generic status and
common-command paths moved behind that boundary.

`get_client()` is a compatibility alias for the typed `get_bambu_client()` escape
hatch. All current consumers are Bambu-specific; none is obsolete. Migrating the
listed modules mechanically would not make them provider-neutral because they use
MQTT state or commands that do not exist in `PrinterBackend`.

| Consumer | Lines | Classification | Bambu dependency |
| --- | --- | --- | --- |
| `api/routes/firmware.py` | 99, 147 | Bambu-only | MQTT firmware/version state |
| `api/routes/inventory.py` | 111 | Bambu-only | AMS tray state and commands |
| `api/routes/kprofiles.py` | 51, 112, 216, 265 | Bambu-only | extrusion calibration profiles |
| `api/routes/printers.py` | 1956, 2012, 2081, 2307, 2643, 2966, 2992, 3016, 3049, 3079, 3105, 3132, 3156, 3207, 3245, 3284, 3328, 3350, 3381, 3489, 3540, 3582, 3797, 3826, 3884 | Bambu-only | MQTT logs, HMS, AMS/drying, fans, lights, speed, calibration, and device commands |
| `api/routes/spoolman.py` | 905 | Bambu-only | AMS tray state |
| `api/routes/spoolman_inventory.py` | 1478 | Bambu-only | AMS tray assignment command |
| `main.py` | 1735, 2239, 2348, 2568, 3285, 6033 | Bambu-only | calibration selection, Bambu print metadata/state mutation, chamber light, and layer observation |
| `services/firmware_update.py` | 125 | Bambu-only | MQTT firmware update command |
| `services/github_backup.py` | 339 | Bambu-only | Bambu nozzle/profile export |
| `services/print_scheduler.py` | 2131, 3220 | Bambu-only inside scheduler | chamber preheat and MQTT publish/reconnect recovery; generic scheduler transport belongs to #11 |
| `services/printer_diagnostic.py` | 275 | Bambu-only | MQTT connection diagnostics |
| `services/spool_tag_matcher.py` | 508 | Bambu-only | AMS/K-profile commands |
| `services/virtual_printer/manager.py` | 1110 | Bambu-only | target MQTT camera/IP/model data |
| `services/virtual_printer/mqtt_bridge.py` | 331 | Bambu-only | bridges the target MQTT client |

Generic paths migrated in #5 are REST/WebSocket status, connect/disconnect,
pause/resume/cancel, Obico pause, the plate-detection pause, webhook cancel, and
application shutdown. They consume `PrinterSnapshot` or async backend methods.

## Explicit deferrals

- `UploadJob` and provider-neutral upload/start semantics are not introduced here;
  issue #8 owns that contract.
- Scheduler/queue dispatch still uses the synchronous Bambu compatibility facade;
  issue #11 owns its transport migration.
- Removing `get_client()` requires each Bambu-only module above to add a provider
  gate and adopt `get_bambu_client()`. Keeping the alias avoids unrelated churn in
  #5 while making the remaining debt searchable and finite.
