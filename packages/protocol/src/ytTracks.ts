/**
 * YouTube song tracks — a karaoke video found on YouTube, fetched by the relay (yt-dlp + ffmpeg) into
 * the singer's own Drive (`SingersVoice/Tracks/YT/<title>/`), where it becomes a track like any other:
 * its sound is the backing layer the singers sing to, the video (the words are in the picture) is
 * shown on stage in place of the lyrics. The browser never touches YouTube: it asks sv-control, which
 * asks the relay; the relay downloads, takes the sound out, uploads both files with the singer's own
 * Drive sign-in and shares the video anyone-with-the-link, and reports the job as it goes.
 */

export interface YtSearchItem {
  /** The 11-character video id. */
  id: string;
  title: string;
  channel: string;
  durationMs: number;
  thumbnail: string;
  views: number | null;
  url: string;
}

export interface YtSearchResponse {
  items: YtSearchItem[];
}

/** What the browser asks for: the video, and where in its Drive the files go (the track's own folder, made by the browser). */
export interface YtFetchRequest {
  videoId: string;
  trackId: string;
  /** The Drive folder (`SingersVoice/Tracks/YT/<title>`) the video and its sound are uploaded into. */
  folderId: string;
  /** The file name (without extension) — the song's title as the singer wants it. */
  name: string;
}

export type YtJobState = 'queued' | 'downloading' | 'converting' | 'uploading' | 'done' | 'error';

export interface YtJobResult {
  videoFileId: string;
  videoMime: string;
  audioFileId: string;
  audioMime: string;
  durationMs: number;
  width: number;
  height: number;
  title: string;
  channel: string;
  bytes: number;
  youtubeId: string;
  sourceUrl: string;
}

export interface YtJob {
  jobId: string;
  state: YtJobState;
  /** 0..1 through the whole job. */
  fraction: number;
  /** One line on where it is ("downloading · 42 %", "uploading the video · 12 MB"). */
  note: string;
  videoId: string;
  trackId: string;
  startedAt: string;
  result?: YtJobResult;
  error?: string;
}

/** Whether the service can fetch YouTube song tracks at all (the relay, with yt-dlp on it). */
export interface YtStatus {
  available: boolean;
  /** yt-dlp's version on the relay, when known. */
  ytdlp: string | null;
  note: string;
}

export const YT_SEARCH_LIMIT = 12;
/** Longest video a song track may be (a karaoke song, not a concert). */
export const YT_MAX_DURATION_MS = 20 * 60 * 1000;
/** The job keeps the picture at most this tall (a karaoke video's words read fine; the file stays a few dozen MB). */
export const YT_MAX_HEIGHT = 720;

export const ytWatchUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;
