import express from "express";
import pg from "pg";

const app = express();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
app.use(express.json());

app.get("/api/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, db: "up" }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/songs", async (_req, res) => {
  const { rows } = await pool.query("SELECT id, title, artist FROM songs ORDER BY title");
  res.json(rows);
});

const port = process.env.API_PORT || 4000;
app.listen(port, () => console.log(`SingersVoice API on :${port}`));
