import type { AppSettings, AppSettingsUpdate } from '../api/client';

export type SettingsDraft = AppSettings;

type PersistedField = keyof AppSettings;

const persistedFields = [
  'auto_archive', 'save_thumbnails', 'capture_finish_photo', 'default_filament_cost',
  'currency', 'energy_cost_per_kwh', 'energy_tracking_mode', 'check_updates',
  'check_printer_firmware', 'include_beta_updates', 'local_login_enabled',
  'notification_language', 'bed_cooled_threshold', 'ams_humidity_good',
  'ams_humidity_fair', 'ams_temp_good', 'ams_temp_fair', 'ams_history_retention_days',
  'disable_filament_warnings', 'prefer_lowest_filament', 'queue_drying_enabled',
  'queue_drying_block', 'ambient_drying_enabled', 'print_drying_enabled',
  'drying_presets', 'ams_humidity_thresholds', 'per_printer_mapping_expanded',
  'date_format', 'time_format', 'default_printer_id', 'ftp_retry_enabled',
  'ftp_retry_count', 'ftp_retry_delay', 'ftp_timeout', 'mqtt_enabled', 'mqtt_broker',
  'mqtt_port', 'mqtt_username', 'mqtt_password', 'mqtt_topic_prefix', 'mqtt_use_tls',
  'external_url', 'ha_enabled', 'ha_url', 'ha_token', 'library_archive_mode',
  'library_disk_warning_gb', 'camera_view_mode', 'preferred_slicer', 'open_in_slicer',
  'use_slicer_api', 'orcaslicer_api_url', 'bambu_studio_api_url',
  'prometheus_enabled', 'prometheus_token', 'user_notifications_enabled',
  'default_bed_levelling', 'default_flow_cali', 'default_vibration_cali',
  'default_layer_inspect', 'default_timelapse', 'default_nozzle_offset_cali',
  'stagger_group_size', 'stagger_interval_minutes', 'require_plate_clear',
  'preheat_enabled', 'preheat_filament_targets', 'preheat_max_wait_seconds',
  'preheat_soak_seconds', 'nozzle_temp_presets', 'bed_temp_presets',
  'chamber_temp_presets', 'fan_speed_presets', 'session_max_hours',
] as const satisfies readonly PersistedField[];

const comparisonDefaults = {
  check_printer_firmware: true,
  include_beta_updates: false,
  local_login_enabled: true,
  bed_cooled_threshold: 35,
  queue_drying_enabled: false,
  queue_drying_block: false,
  ambient_drying_enabled: false,
  print_drying_enabled: false,
  drying_presets: '',
  ams_humidity_thresholds: '',
  library_archive_mode: 'ask',
  library_disk_warning_gb: 5,
  camera_view_mode: 'window',
  preferred_slicer: 'bambu_studio',
  open_in_slicer: null,
  use_slicer_api: false,
  orcaslicer_api_url: '',
  bambu_studio_api_url: '',
  user_notifications_enabled: true,
  default_bed_levelling: true,
  default_flow_cali: false,
  default_vibration_cali: true,
  default_layer_inspect: false,
  default_timelapse: false,
  default_nozzle_offset_cali: true,
  stagger_group_size: 2,
  stagger_interval_minutes: 5,
  require_plate_clear: false,
  preheat_enabled: false,
  preheat_filament_targets: '',
  preheat_max_wait_seconds: 900,
  preheat_soak_seconds: 300,
  nozzle_temp_presets: '',
  bed_temp_presets: '',
  chamber_temp_presets: '',
  fan_speed_presets: '',
  session_max_hours: 24,
} satisfies Partial<AppSettings>;

export function normalizeSettingsDraft(settings: AppSettings, origin: string): SettingsDraft {
  return { ...settings, external_url: settings.external_url || origin };
}

export function updateSettingsDraft<K extends keyof AppSettings>(
  draft: SettingsDraft,
  key: K,
  value: AppSettings[K],
): SettingsDraft {
  return { ...draft, [key]: value };
}

function comparableValue(settings: SettingsDraft, key: PersistedField) {
  if (key === 'library_disk_warning_gb') return Number(settings[key] ?? comparisonDefaults[key]);
  return settings[key] ?? comparisonDefaults[key as keyof typeof comparisonDefaults];
}

export function hasSettingsDraftChanges(saved: AppSettings, draft: SettingsDraft): boolean {
  return persistedFields.some((key) => comparableValue(saved, key) !== comparableValue(draft, key));
}

export function settingsDraftPersistence(draft: SettingsDraft): AppSettingsUpdate {
  return Object.fromEntries(persistedFields.map((key) => [key, draft[key]])) as AppSettingsUpdate;
}

export function shouldDebounceSettingsCommit({
  initialLoad,
  canUpdate,
  isSaving,
  saved,
  draft,
}: {
  initialLoad: boolean;
  canUpdate: boolean;
  isSaving: boolean;
  saved: AppSettings | undefined;
  draft: SettingsDraft | null;
}): boolean {
  return !initialLoad && canUpdate && !isSaving && !!saved && !!draft && hasSettingsDraftChanges(saved, draft);
}
