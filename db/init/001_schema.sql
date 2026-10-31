CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE songs (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT,
  backing_track_url TEXT,
  lyrics_lrc TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE performances (
  id SERIAL PRIMARY KEY,
  song_id INT REFERENCES songs(id),
  user_id INT REFERENCES users(id),
  parent_id INT REFERENCES performances(id), -- set when joining a duet
  kind TEXT CHECK (kind IN ('solo','duet','group')) DEFAULT 'solo',
  audio_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
