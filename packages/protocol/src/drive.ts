/**
 * Google Drive layout. Everything the app creates lives under one root folder in the
 * singer's own Drive (scope `drive.file`), one sub-folder per task.
 */
export const DRIVE_ROOT = 'SingersVoice';

export const DRIVE_TREE = {
  root: DRIVE_ROOT,
  tracks: 'Tracks',
  performances: 'Performances',
  performancesLive: 'Live',
  performancesOffline: 'Offline',
  temp: 'Temp',
  config: 'Config',
  backgrounds: 'Backgrounds',
  exports: 'Exports',
} as const;

export type DriveFolderKey =
  | 'root'
  | 'tracks'
  | 'performances'
  | 'performancesLive'
  | 'performancesOffline'
  | 'temp'
  | 'config'
  | 'backgrounds'
  | 'exports';

/** Folder paths relative to the root, in creation order. */
export const DRIVE_FOLDER_PATHS: Record<DriveFolderKey, string[]> = {
  root: [],
  tracks: [DRIVE_TREE.tracks],
  performances: [DRIVE_TREE.performances],
  performancesLive: [DRIVE_TREE.performances, DRIVE_TREE.performancesLive],
  performancesOffline: [DRIVE_TREE.performances, DRIVE_TREE.performancesOffline],
  temp: [DRIVE_TREE.temp],
  config: [DRIVE_TREE.config],
  backgrounds: [DRIVE_TREE.backgrounds],
  exports: [DRIVE_TREE.exports],
};

/** `appProperties` keys stamped on every file/folder the app creates. */
export const APP_PROPS = {
  type: 'svType',
  id: 'svId',
  trackId: 'svTrackId',
  meetId: 'svMeetId',
  schema: 'svSchema',
  state: 'svState',
} as const;

export type SvFileType =
  | 'root'
  | 'folder'
  | 'trackFolder'
  | 'track'
  | 'trackAudio'
  | 'performanceFolder'
  | 'performance'
  | 'performanceAudio'
  | 'performanceVideo'
  | 'config'
  | 'background'
  | 'export';

export const CONFIG_FILES = {
  audioPlugin: 'audio_plugin_settings.json',
  app: 'app_settings.json',
} as const;

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email', 'profile'];
