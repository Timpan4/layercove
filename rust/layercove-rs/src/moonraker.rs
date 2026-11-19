//! Normalizes Moonraker object queries and partial subscription updates.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

const JOB_FIELDS: &[&str] = &["filename", "message", "print_duration", "info"];
const SDCARD_FIELDS: &[&str] = &["file_path", "progress"];

/// The snapshot fields populated by Moonraker while connected. Python supplies
/// the defaults for other fields in its provider-independent snapshot.
#[derive(Debug, Serialize)]
pub struct StatusSnapshot {
    provider: &'static str,
    connected: bool,
    pub state: PrinterState,
    pub message: Option<String>,
    pub filename: Option<String>,
    pub progress: Option<f64>,
    pub elapsed_seconds: Option<u64>,
    pub current_layer: Option<u64>,
    pub total_layers: Option<u64>,
    pub temperatures: Temperatures,
    pub nozzles: Vec<NozzleSnapshot>,
    provider_detail: ProviderDetail,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrinterState {
    Idle,
    Printing,
    Paused,
    Completed,
    Cancelled,
    Error,
    Unknown,
}

impl PrinterState {
    fn from_print_state(value: Option<&Value>, text: Option<&str>) -> Self {
        match text {
            None if value.is_none() => Self::Idle,
            Some("standby" | "ready") => Self::Idle,
            Some("printing") => Self::Printing,
            Some("paused") => Self::Paused,
            Some("complete" | "completed") => Self::Completed,
            Some("cancelled" | "canceled") => Self::Cancelled,
            Some("error") => Self::Error,
            _ => Self::Unknown,
        }
    }

    fn has_job_telemetry(self) -> bool {
        matches!(
            self,
            Self::Printing | Self::Paused | Self::Completed | Self::Cancelled | Self::Error
        )
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Temperatures {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nozzle: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bed: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NozzleSnapshot {
    pub tool_index: u64,
    pub diameter: Option<f64>,
    pub status: NozzleStatus,
    pub max_temperature: Option<f64>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NozzleStatus {
    Confirmed,
    Unknown,
}

#[derive(Debug, Serialize)]
struct ProviderDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    print_state: Option<String>,
}

/// The cached status for one printer. Each update replaces only the fields
/// present in that update, including explicit nulls.
#[derive(Default)]
pub struct MoonrakerStatus {
    print_stats: Map<String, Value>,
    virtual_sdcard: Map<String, Value>,
    display_progress: Option<f64>,
    temperatures: Temperatures,
    nozzles: Vec<NozzleSnapshot>,
    last_state: Option<PrinterState>,
}

impl MoonrakerStatus {
    /// Applies a Moonraker status object and returns the current snapshot.
    /// A non-object status has no effect and yields no snapshot.
    pub fn apply(&mut self, status: Value) -> Option<StatusSnapshot> {
        let Value::Object(mut status) = status else {
            return None;
        };
        if let Some(Value::Object(mut stats)) = status.remove("print_stats") {
            merge_fields(&mut self.print_stats, &mut stats, JOB_FIELDS);
            merge_fields(&mut self.print_stats, &mut stats, &["state", "status"]);
        }
        if let Some(Value::Object(mut sdcard)) = status.remove("virtual_sdcard") {
            merge_fields(&mut self.virtual_sdcard, &mut sdcard, SDCARD_FIELDS);
        }
        if let Some(value) = status.get("display_status").and_then(|v| v.get("progress")) {
            self.display_progress = finite_number(value);
        }
        if let Some(value) = status.get("extruder").and_then(|v| v.get("temperature")) {
            self.temperatures.nozzle = finite_number(value);
        }
        if let Some(value) = status.get("heater_bed").and_then(|v| v.get("temperature")) {
            self.temperatures.bed = finite_number(value);
        }
        if let Some(settings) = status.get("configfile").and_then(|v| v.get("settings")) {
            self.nozzles = configured_nozzles(settings);
        }

        let raw_state = self
            .print_stats
            .get("state")
            .filter(|v| truthy(v))
            .or_else(|| self.print_stats.get("status"))
            .filter(|v| !v.is_null());
        let print_state = raw_state.and_then(Value::as_str).map(str::to_lowercase);
        let state = PrinterState::from_print_state(raw_state, print_state.as_deref());

        if state == PrinterState::Idle
            && self.last_state.is_some_and(PrinterState::has_job_telemetry)
        {
            for field in JOB_FIELDS {
                self.print_stats.remove(*field);
            }
            self.virtual_sdcard.clear();
            self.display_progress = None;
        }
        self.last_state = Some(state);

        let progress = self
            .display_progress
            .or_else(|| self.virtual_sdcard.get("progress").and_then(finite_number))
            .map(|fraction| (fraction * 100.0).clamp(0.0, 100.0));
        let filename = self
            .print_stats
            .get("filename")
            .filter(|v| truthy(v))
            .or_else(|| self.virtual_sdcard.get("file_path"))
            .and_then(nonempty_text);
        let info = self.print_stats.get("info").and_then(Value::as_object);

        Some(StatusSnapshot {
            provider: "moonraker",
            connected: true,
            state,
            message: self.print_stats.get("message").and_then(nonempty_text),
            filename,
            progress,
            elapsed_seconds: self
                .print_stats
                .get("print_duration")
                .and_then(nonnegative_count),
            current_layer: info
                .and_then(|v| v.get("current_layer"))
                .and_then(nonnegative_count),
            total_layers: info
                .and_then(|v| v.get("total_layer"))
                .and_then(nonnegative_count),
            temperatures: self.temperatures,
            nozzles: self.nozzles.clone(),
            provider_detail: ProviderDetail { print_state },
        })
    }
}

fn merge_fields(target: &mut Map<String, Value>, update: &mut Map<String, Value>, fields: &[&str]) {
    for &field in fields {
        if let Some((key, value)) = update.remove_entry(field) {
            target.insert(key, value);
        }
    }
}

// Match the Python backend's fallback rules before interpreting the selected value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
    }
}

fn nonempty_text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn finite_number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|number| number.is_finite())
}

fn nonnegative_count(value: &Value) -> Option<u64> {
    let number = finite_number(value)?.max(0.0);
    // The cast threshold is 2^64 because u64::MAX rounds up as f64.
    if number < u64::MAX as f64 {
        Some(number as u64)
    } else {
        None
    }
}

fn configured_nozzles(settings: &Value) -> Vec<NozzleSnapshot> {
    let Some(settings) = settings.as_object() else {
        return Vec::new();
    };
    let mut nozzles = BTreeMap::new();
    for (name, config) in settings {
        let tool_index = if name == "extruder" {
            0
        } else {
            let Some(index) = name
                .strip_prefix("extruder")
                .filter(|suffix| suffix.bytes().all(|byte| byte.is_ascii_digit()))
                .and_then(|suffix| suffix.parse().ok())
            else {
                continue;
            };
            index
        };
        let diameter = config
            .get("nozzle_diameter")
            .and_then(finite_number)
            .filter(|number| *number > 0.0);
        let max_temperature = diameter
            .and_then(|_| config.get("max_temp"))
            .and_then(finite_number)
            .filter(|number| *number > 0.0);
        let nozzle = NozzleSnapshot {
            tool_index,
            diameter,
            status: if diameter.is_some() {
                NozzleStatus::Confirmed
            } else {
                NozzleStatus::Unknown
            },
            max_temperature,
        };
        if name == "extruder" {
            nozzles.insert(tool_index, nozzle);
        } else {
            nozzles.entry(tool_index).or_insert(nozzle);
        }
    }
    nozzles.into_values().collect()
}
