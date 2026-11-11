/**
 * SVT DB — the SingersVoice Tracks database. A track lives in its owner's Google Drive; when the
 * owner publishes it, the Drive folder gets an "anyone with the link" permission and the entry
 * below is registered in the catalog so every signed-in user can find it and pull a copy into
 * their own Drive. Unpublishing removes the entry (and the link permission).
 */
export interface CatalogTrack {
  trackId: string;
  ownerUserId: string;
  ownerName: string;
  title: string;
  artist: string;
  genre: string;
  language: string;
  durationMs: number;
  singerCount: number;
  lineCount: number;
  /** Drive folder with track.json + backing audio, shared anyone-with-link. */
  driveFolderId: string;
  driveFolderLink: string;
  /** Drive file ids so clients can fetch the package directly (public files, API key or own token). */
  trackJsonId: string;
  audioId: string;
  audioMime: string;
  publishedAt: string;
  updatedAt: string;
  /** How many users pulled it into their Drive. */
  pulls: number;
}

export interface CatalogPublishRequest {
  trackId: string;
  title: string;
  artist: string;
  genre: string;
  language: string;
  durationMs: number;
  singerCount: number;
  lineCount: number;
  driveFolderId: string;
  driveFolderLink: string;
  trackJsonId: string;
  audioId: string;
  audioMime: string;
}

export interface CatalogListResponse {
  items: CatalogTrack[];
  nextCursor: string | null;
  total: number;
}
