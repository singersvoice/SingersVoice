/**
 * Google Drive layout. Everything the app creates lives under one root folder in the
 * singer's own Drive (scope `drive.file`), one sub-folder per task.
 */
export const DRIVE_ROOT = 'SingersVoice';

export const DRIVE_TREE = {
  root: DRIVE_ROOT,
  tracks: 'Tracks',
  /** Under Tracks: the YouTube song tracks, one folder per song (its video, its sound, its track.json). */
  yt: 'YT',
  /** One level: every performance is one file here ("Song · Meet [id] · date.mp4"). */
  performances: 'Performances',
  temp: 'Temp',
  config: 'Config',
  backgrounds: 'Backgrounds',
  exports: 'Exports',
} as const;

export type DriveFolderKey = 'root' | 'tracks' | 'yt' | 'performances' | 'temp' | 'config' | 'backgrounds' | 'exports';

/** Folder paths relative to the root, in creation order. */
export const DRIVE_FOLDER_PATHS: Record<DriveFolderKey, string[]> = {
  root: [],
  tracks: [DRIVE_TREE.tracks],
  yt: [DRIVE_TREE.tracks, DRIVE_TREE.yt],
  performances: [DRIVE_TREE.performances],
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
  | 'trackVideo'
  | 'performanceFolder'
  | 'performance'
  | 'performanceAudio'
  | 'performanceVideo'
  /** The singer's alpha-packed cut-out video beside a show (join.ts). */
  | 'performanceCutout'
  | 'config'
  | 'background'
  | 'export';

export const CONFIG_FILES = {
  audioPlugin: 'audio_plugin_settings.json',
  app: 'app_settings.json',
} as const;

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email', 'profile'];
