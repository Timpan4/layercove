import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../api/client';
import {
  hasSettingsDraftChanges,
  normalizeSettingsDraft,
  settingsDraftPersistence,
  shouldDebounceSettingsCommit,
  updateSettingsDraft,
} from '../../domain/settingsDraft';

const settings = {
  auto_archive: true,
  save_thumbnails: true,
  capture_finish_photo: false,
  default_filament_cost: 25,
  currency: 'USD',
  energy_cost_per_kwh: 0.12,
  energy_tracking_mode: 'print',
  check_updates: true,
  notification_language: 'en',
  ams_humidity_good: 40,
  ams_humidity_fair: 60,
  ams_temp_good: 30,
  ams_temp_fair: 35,
  ams_history_retention_days: 30,
  disable_filament_warnings: false,
  prefer_lowest_filament: false,
  per_printer_mapping_expanded: false,
  date_format: 'system',
  time_format: 'system',
  default_printer_id: null,
  ftp_retry_enabled: true,
  ftp_retry_count: 3,
  ftp_retry_delay: 5,
  ftp_timeout: 30,
  mqtt_enabled: true,
  mqtt_broker: 'mqtt.local',
  mqtt_port: 8883,
  mqtt_username: 'user',
  mqtt_password: 'password',
  mqtt_topic_prefix: 'layercove',
  mqtt_use_tls: true,
  external_url: '',
  ha_enabled: false,
  ha_url: '',
  ha_token: '',
  prometheus_enabled: false,
  prometheus_token: '',
  gcode_snippets: '{"X1":{"start_gcode":"M117 ready","end_gcode":""}}',
} as AppSettings;

describe('settingsDraft', () => {
  it('round-trips every SettingsPage-managed persisted field', () => {
    const draft = normalizeSettingsDraft(settings, 'https://layercove.local');
    const persisted = settingsDraftPersistence(draft);

    expect(draft.external_url).toBe('https://layercove.local');
    expect(persisted).toMatchObject({
      mqtt_broker: 'mqtt.local',
      mqtt_port: 8883,
      mqtt_password: 'password',
      default_printer_id: null,
      open_in_slicer: undefined,
      drying_presets: undefined,
    });
    expect(persisted).not.toHaveProperty('gcode_snippets');
  });

  it('uses legacy defaults for dirty comparison and commits only permitted changes', () => {
    const draft = normalizeSettingsDraft(settings, 'https://layercove.local');

    expect(hasSettingsDraftChanges(settings, draft)).toBe(true);
    expect(hasSettingsDraftChanges(settings, { ...draft, external_url: '' })).toBe(false);

    const changed = updateSettingsDraft(draft, 'mqtt_broker', 'new-mqtt.local');
    expect(hasSettingsDraftChanges(settings, changed)).toBe(true);
    expect(shouldDebounceSettingsCommit({
      initialLoad: false,
      canUpdate: true,
      isSaving: false,
      saved: settings,
      draft: changed,
    })).toBe(true);
    expect(shouldDebounceSettingsCommit({
      initialLoad: false,
      canUpdate: false,
      isSaving: false,
      saved: settings,
      draft: changed,
    })).toBe(false);
  });
});
