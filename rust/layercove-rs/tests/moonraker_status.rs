use layercove_rs::moonraker::MoonrakerStatus;
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Deserialize)]
struct StatusStep {
    name: String,
    status: Value,
    snapshot: Map<String, Value>,
}

#[test]
fn shares_the_python_moonraker_snapshot_contract() {
    let steps: Vec<StatusStep> =
        serde_json::from_str(include_str!("fixtures/moonraker_status.json")).unwrap();
    assert!(!steps.is_empty());
    let mut status = MoonrakerStatus::default();
    for step in steps {
        let snapshot = status.apply(step.status).unwrap();
        let actual = serde_json::to_value(snapshot).unwrap();
        for (field, expected) in step.snapshot {
            assert_eq!(
                actual.get(&field),
                Some(&expected),
                "{}: field {field}",
                step.name
            );
        }
    }
}

#[test]
fn non_object_updates_preserve_cached_status() {
    let mut status = MoonrakerStatus::default();
    let printing = status
        .apply(json!({
            "print_stats": {"state": "printing", "filename": "cube.gcode"},
            "display_status": {"progress": 0.25}
        }))
        .unwrap();

    assert!(status.apply(json!(null)).is_none());
    let after = status.apply(json!({})).unwrap();
    assert_eq!(
        serde_json::to_value(after).unwrap(),
        serde_json::to_value(printing).unwrap()
    );
}

#[test]
fn omits_non_text_state_details_and_serializes_rejected_counters_as_null() {
    let mut status = MoonrakerStatus::default();
    let snapshot = status
        .apply(json!({
            "print_stats": {
                "state": {"unexpected": "raw provider data"},
                "print_duration": "1e100",
                "info": {"current_layer": 12, "total_layer": 1e100}
            }
        }))
        .unwrap();
    let actual = serde_json::to_value(snapshot).unwrap();
    assert_eq!(actual["state"], "unknown");
    assert_eq!(actual["provider_detail"], json!({}));
    assert_eq!(actual.get("elapsed_seconds"), Some(&Value::Null));
    assert_eq!(actual["current_layer"], 12);
    assert_eq!(actual.get("total_layers"), Some(&Value::Null));
}
