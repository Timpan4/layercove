use layercove_rs::moonraker::MoonrakerStatus;
use serde::Deserialize;
use serde_json::{Map, Value};

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
fn ignores_non_object_updates_and_omits_non_text_state_details() {
    use serde_json::json;

    let mut status = MoonrakerStatus::default();
    assert!(status.apply(json!(null)).is_none());

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
    assert_eq!(actual["elapsed_seconds"], Value::Null);
    assert_eq!(actual["current_layer"], 12);
    assert_eq!(actual["total_layers"], Value::Null);
}
