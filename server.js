/**
 * Questionable Sphere — complete backend (single file)
 *
 * Architecture:
 *   Frontend  →  this Express server  →  Supabase PostgreSQL
 *
 * Deploy (Railway / any Node host):
 *   1. Put server.js + package.json in a repo
 *   2. Set environment variables (see below)
 *   3. Start command: npm start
 *   4. Listen port: process.env.PORT (Railway sets this)
 *
 * Required environment variables:
 *   SUPABASE_URL              — e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service_role key (server only, never frontend)
 *   FRONTEND_URL              — optional, e.g. https://your-site.com (CORS)
 *   PORT                      — optional locally; Railway supplies it
 *   QUESTION_LIFETIME_HOURS   — optional, default 27
 *   SPHERE_BATCH_SIZE         — optional, default 48
 *
 * Database (one-time):
 *   Open Supabase → SQL Editor → run the SQL printed at startup
 *   (or the block in initializeDatabase comments). Tables are then
 *   checked/seeded automatically on every boot.
 */

'use strict';

try { require('dotenv').config(); } catch (_) { /* optional locally */ }

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Node has no built-in WebSocket. Newer supabase-js needs one for Realtime init
// even if we only use REST. Without this, Railway crashes on createClient().
let WebSocketImpl = null;
try {
  WebSocketImpl = require('ws');
} catch (_) {
  console.warn('[qs] optional package "ws" not installed — realtime disabled');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const QUESTION_LIFETIME_HOURS = Number(process.env.QUESTION_LIFETIME_HOURS) || 27;
const SPHERE_BATCH_SIZE = Math.min(
  Math.max(Number(process.env.SPHERE_BATCH_SIZE) || 48, 1),
  48
);
const BODY_LIMIT = process.env.BODY_LIMIT || '2mb';

const DEFAULT_TOPICS = [
  { name: 'Life', slug: 'life' },
  { name: 'Love', slug: 'love' },
  { name: 'Relationships', slug: 'relationships' },
  { name: 'Friendship', slug: 'friendship' },
  { name: 'Loneliness', slug: 'loneliness' },
  { name: 'Work', slug: 'work' },
  { name: 'Money', slug: 'money' },
  { name: 'Creativity', slug: 'creativity' },
  { name: 'Technology', slug: 'technology' },
  { name: 'Future', slug: 'future' },
  { name: 'Memories', slug: 'memories' },
  { name: 'Philosophy', slug: 'philosophy' },
  { name: 'Random', slug: 'random' },
  { name: 'Other', slug: 'other' },
];

const SCHEMA_SQL = `
-- Run once in Supabase SQL Editor if tables are missing
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  z DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'hidden', 'reported', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_questions_active_expires
  ON questions (expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_questions_topic_active
  ON questions (topic_id, expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions (status);

CREATE TABLE IF NOT EXISTS replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_replies_question
  ON replies (question_id, created_at);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
  reply_id UUID REFERENCES replies(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (question_id IS NOT NULL OR reply_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`.trim();

// ---------------------------------------------------------------------------
// Supabase client (server-side only)
// ---------------------------------------------------------------------------
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  try {
    const clientOpts = {
      auth: { autoRefreshToken: false, persistSession: false },
    };
    // Provide WebSocket so @supabase/realtime-js does not throw in Node
    if (WebSocketImpl) {
      clientOpts.realtime = { transport: WebSocketImpl };
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, clientOpts);
    console.log('[qs] Supabase client created');
  } catch (err) {
    console.error('[qs] Supabase client failed:', err && err.message ? err.message : err);
    supabase = null;
  }
} else {
  console.warn(
    '[qs] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — API will return errors until set.'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isUuid(v) {
  return (
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v
    )
  );
}

/** Uniform random point on a sphere (radius 2 matches typical frontend). */
function randomSpherePoint(radius = 2) {
  const u = Math.random();
  const v = Math.random();
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  return {
    x: radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta),
  };
}

function mapQuestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    topic_id: row.topic_id || null,
    topic_slug: (row.topics && row.topics.slug) || row.topic_slug || null,
    topic_name: (row.topics && row.topics.name) || row.topic_name || null,
    x: row.x,
    y: row.y,
    z: row.z,
    created_at: row.created_at,
    expires_at: row.expires_at,
    status: row.status,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function expiresAtIso() {
  const d = new Date();
  d.setHours(d.getHours() + QUESTION_LIFETIME_HOURS);
  return d.toISOString();
}

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function fail(res, status, message, code) {
  return res.status(status).json({
    success: false,
    error: message,
    ...(code ? { code } : {}),
  });
}

// ---------------------------------------------------------------------------
// Database init / health of schema
// ---------------------------------------------------------------------------
let dbReady = false;
let dbInitMessage = 'not checked';

async function tableExists(name) {
  if (!supabase) return false;
  const { error } = await supabase.from(name).select('*').limit(1);
  if (!error) return true;
  // PostgREST: relation does not exist → code often PGRST205 or similar message
  const msg = (error.message || '').toLowerCase();
  if (msg.includes('does not exist') || msg.includes('schema cache') || error.code === 'PGRST205') {
    return false;
  }
  // Other errors (network, auth) → treat as unknown; still "exists" for messaging
  return true;
}

async function seedTopicsIfEmpty() {
  const { data, error } = await supabase.from('topics').select('id').limit(1);
  if (error) return;
  if (data && data.length > 0) return;
  const { error: insErr } = await supabase.from('topics').insert(DEFAULT_TOPICS);
  if (insErr) {
    console.warn('[qs] topic seed:', insErr.message);
  } else {
    console.log('[qs] seeded default topics');
  }
}

/**
 * Checks required tables. Cannot CREATE TABLE via supabase-js REST API.
 * Prints the SQL once so you can paste it in Supabase SQL Editor.
 * Seeds topics when the table is empty.
 */
async function initializeDatabase() {
  if (!supabase) {
    dbReady = false;
    dbInitMessage = 'Supabase credentials not configured';
    console.error('[qs]', dbInitMessage);
    return;
  }

  try {
    const needed = ['topics', 'questions', 'replies', 'reports', 'contact_messages'];
    const missing = [];
    for (const t of needed) {
      const exists = await tableExists(t);
      if (!exists) missing.push(t);
    }

    if (missing.length) {
      dbReady = false;
      dbInitMessage = `Missing tables: ${missing.join(', ')}. Run the SQL below in Supabase SQL Editor once.`;
      console.error('[qs]', dbInitMessage);
      console.error('\n========== PASTE THIS IN SUPABASE SQL EDITOR ==========\n');
      console.error(SCHEMA_SQL);
      console.error('\n=======================================================\n');
      return;
    }

    await seedTopicsIfEmpty();
    dbReady = true;
    dbInitMessage = 'connected';
    console.log('[qs] database ready');
  } catch (err) {
    dbReady = false;
    dbInitMessage = err.message || 'init failed';
    console.error('[qs] initializeDatabase:', dbInitMessage);
  }
}

async function cleanupExpiredData() {
  if (!supabase || !dbReady) return;
  try {
    const { data, error } = await supabase
      .from('questions')
      .delete()
      .lt('expires_at', nowIso())
      .select('id');
    if (error) {
      console.warn('[qs] cleanup:', error.message);
      return;
    }
    const n = Array.isArray(data) ? data.length : 0;
    if (n > 0) console.log(`[qs] cleanup removed ${n} expired question(s)`);
  } catch (err) {
    console.warn('[qs] cleanup error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Core data functions
// ---------------------------------------------------------------------------
async function getQuestions(opts = {}) {
  const limit = Math.min(
    Math.max(Number(opts.limit) || SPHERE_BATCH_SIZE, 1),
    48
  );
  let topicId = opts.topic_id || null;
  const topicSlug = opts.topic || opts.topic_slug || null;

  if (!topicId && topicSlug) {
    const { data: topic, error } = await supabase
      .from('topics')
      .select('id')
      .eq('slug', String(topicSlug).toLowerCase())
      .eq('active', true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!topic) return [];
    topicId = topic.id;
  }

  // Random from full active pool (ORDER BY random via PostgREST not native;
  // fetch a larger candidate set with random ordering approximation, then sample).
  // For MVP: request up to 200 active rows ordered randomly via RPC-less approach —
  // we use created_at shuffle in app after fetching a bounded active set.
  // Better: use .order with random if available; fallback below is safe & bounded.

  let q = supabase
    .from('questions')
    .select('id, text, topic_id, x, y, z, created_at, expires_at, status, topics(name, slug)')
    .eq('status', 'active')
    .gt('expires_at', nowIso())
    .limit(200);

  if (topicId) q = q.eq('topic_id', topicId);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const pool = data || [];
  // Fisher–Yates shuffle then take `limit` — random from eligible set, not only newest
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, limit).map(mapQuestion);
}

async function getRandomQuestion(excludeIds = []) {
  const exclude = (Array.isArray(excludeIds) ? excludeIds : [])
    .filter(isUuid)
    .slice(0, 50);

  const { data, error } = await supabase
    .from('questions')
    .select('id, text, topic_id, x, y, z, created_at, expires_at, status, topics(name, slug)')
    .eq('status', 'active')
    .gt('expires_at', nowIso())
    .limit(150);

  if (error) throw new Error(error.message);
  let pool = data || [];
  if (exclude.length) {
    const set = new Set(exclude);
    const filtered = pool.filter((r) => !set.has(r.id));
    if (filtered.length) pool = filtered;
  }
  if (!pool.length) return null;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return mapQuestion(pick);
}

async function getQuestion(id) {
  if (!isUuid(id)) {
    const e = new Error('Invalid question id');
    e.status = 400;
    e.code = 'INVALID_ID';
    throw e;
  }
  const { data, error } = await supabase
    .from('questions')
    .select('id, text, topic_id, x, y, z, created_at, expires_at, status, topics(name, slug)')
    .eq('id', id)
    .eq('status', 'active')
    .gt('expires_at', nowIso())
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const e = new Error('Question not found or no longer active');
    e.status = 404;
    e.code = 'NOT_FOUND';
    throw e;
  }
  return mapQuestion(data);
}

async function createQuestion({ text, topic_id, x, y, z }) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    const e = new Error('Question text is required');
    e.status = 400;
    e.code = 'EMPTY_TEXT';
    throw e;
  }
  if (trimmed.length > 200000) {
    const e = new Error('Question text is too large');
    e.status = 400;
    e.code = 'TEXT_TOO_LARGE';
    throw e;
  }

  let topicId = null;
  if (topic_id) {
    if (!isUuid(topic_id)) {
      const e = new Error('Invalid topic_id');
      e.status = 400;
      e.code = 'INVALID_TOPIC';
      throw e;
    }
    const { data: topic, error } = await supabase
      .from('topics')
      .select('id')
      .eq('id', topic_id)
      .eq('active', true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!topic) {
      const e = new Error('Topic not found or inactive');
      e.status = 400;
      e.code = 'INVALID_TOPIC';
      throw e;
    }
    topicId = topic.id;
  }

  let coords =
    Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
      ? { x, y, z }
      : randomSpherePoint(2);

  const row = {
    text: trimmed,
    topic_id: topicId,
    x: coords.x,
    y: coords.y,
    z: coords.z,
    expires_at: expiresAtIso(),
    status: 'active',
  };

  const { data, error } = await supabase
    .from('questions')
    .insert([row])
    .select('id, text, topic_id, x, y, z, created_at, expires_at, status, topics(name, slug)')
    .single();
  if (error) throw new Error(error.message);
  return mapQuestion(data);
}

async function getReplies(questionId) {
  await getQuestion(questionId); // ensures active + not expired
  const { data, error } = await supabase
    .from('replies')
    .select('id, question_id, text, created_at')
    .eq('question_id', questionId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function createReply(questionId, text) {
  await getQuestion(questionId);
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    const e = new Error('Reply text is required');
    e.status = 400;
    e.code = 'EMPTY_TEXT';
    throw e;
  }
  if (trimmed.length > 200000) {
    const e = new Error('Reply text is too large');
    e.status = 400;
    e.code = 'TEXT_TOO_LARGE';
    throw e;
  }
  const { data, error } = await supabase
    .from('replies')
    .insert([{ question_id: questionId, text: trimmed }])
    .select('id, question_id, text, created_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getTopics() {
  const { data, error } = await supabase
    .from('topics')
    .select('id, name, slug, active, created_at')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function searchQuestions(queryText, opts = {}) {
  const term = (queryText || '').trim();
  if (!term) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 40);

  let q = supabase
    .from('questions')
    .select('id, text, topic_id, x, y, z, created_at, expires_at, status, topics(name, slug)')
    .eq('status', 'active')
    .gt('expires_at', nowIso())
    .ilike('text', `%${term}%`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (opts.topic_id && isUuid(opts.topic_id)) {
    q = q.eq('topic_id', opts.topic_id);
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(mapQuestion);
}

async function createReport({ question_id, reply_id, reason }) {
  let questionId = question_id || null;
  let replyId = reply_id || null;
  if (!questionId && !replyId) {
    const e = new Error('Provide question_id or reply_id');
    e.status = 400;
    e.code = 'INVALID_TARGET';
    throw e;
  }
  if (questionId && !isUuid(questionId)) {
    const e = new Error('Invalid question_id');
    e.status = 400;
    throw e;
  }
  if (replyId && !isUuid(replyId)) {
    const e = new Error('Invalid reply_id');
    e.status = 400;
    throw e;
  }

  // Validate targets exist; do NOT auto-hide on a single report
  if (questionId) {
    const { data, error } = await supabase
      .from('questions')
      .select('id')
      .eq('id', questionId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      const e = new Error('Question not found');
      e.status = 404;
      throw e;
    }
  }
  if (replyId) {
    const { data, error } = await supabase
      .from('replies')
      .select('id, question_id')
      .eq('id', replyId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      const e = new Error('Reply not found');
      e.status = 404;
      throw e;
    }
    if (!questionId) questionId = data.question_id;
  }

  const reasonText =
    typeof reason === 'string' && reason.trim()
      ? reason.trim().slice(0, 2000)
      : null;

  const { data, error } = await supabase
    .from('reports')
    .insert([
      {
        question_id: questionId,
        reply_id: replyId,
        reason: reasonText,
      },
    ])
    .select('id, created_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function createContactMessage(message) {
  const trimmed = typeof message === 'string' ? message.trim() : '';
  if (!trimmed) {
    const e = new Error('Message is required');
    e.status = 400;
    e.code = 'EMPTY_TEXT';
    throw e;
  }
  if (trimmed.length > 200000) {
    const e = new Error('Message is too large');
    e.status = 400;
    throw e;
  }
  const { data, error } = await supabase
    .from('contact_messages')
    .insert([{ message: trimmed }])
    .select('id, created_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));

const corsOrigin = FRONTEND_URL
  ? FRONTEND_URL.split(',').map((s) => s.trim()).filter(Boolean)
  : true; // reflect request origin when FRONTEND_URL not set (dev-friendly)

app.use(
  cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

function requireDb(req, res, next) {
  if (!supabase) {
    return fail(res, 503, 'Database is not configured', 'NO_DB');
  }
  if (!dbReady) {
    return fail(
      res,
      503,
      dbInitMessage || 'Database schema not ready. Check server logs for SQL to run.',
      'SCHEMA_MISSING'
    );
  }
  next();
}

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}


// Root — Railway health probes often hit /
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, service: 'questionable-sphere-api', health: '/api/health' });
});

// ---------- Health ----------
app.get(
  '/api/health',
  asyncRoute(async (req, res) => {
    let database = 'disconnected';
    if (supabase) {
      try {
        const { error } = await supabase.from('topics').select('id').limit(1);
        if (!error) database = 'connected';
        else if ((error.message || '').toLowerCase().includes('does not exist')) {
          database = 'schema_missing';
        } else {
          database = 'error';
        }
      } catch {
        database = 'error';
      }
    }
    const healthy = database === 'connected';
    res.status(healthy ? 200 : 503).json({
      ok: healthy,
      success: healthy,
      data: {
        status: healthy ? 'ok' : 'degraded',
        database,
        message: dbInitMessage,
        service: 'questionable-sphere-api',
        timestamp: nowIso(),
      },
      ...(healthy ? {} : { error: 'Database not ready' }),
    });
  })
);

app.get('/health', (req, res) => res.redirect(307, '/api/health'));

// ---------- Topics ----------
app.get(
  '/api/topics',
  requireDb,
  asyncRoute(async (req, res) => {
    const topics = await getTopics();
    ok(res, { topics });
  })
);

// ---------- Questions list (max 48, random from active pool) ----------
app.get(
  '/api/questions',
  requireDb,
  asyncRoute(async (req, res) => {
    const questions = await getQuestions({
      limit: req.query.limit,
      topic: req.query.topic || req.query.topic_slug,
      topic_id: req.query.topic_id || req.query.topicId,
    });
    ok(res, { questions, count: questions.length });
  })
);

// ---------- Random discovery ----------
app.get(
  '/api/questions/random',
  requireDb,
  asyncRoute(async (req, res) => {
    let exclude = [];
    if (typeof req.query.exclude === 'string' && req.query.exclude.trim()) {
      exclude = req.query.exclude.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const question = await getRandomQuestion(exclude);
    if (!question) {
      return fail(res, 404, 'No active questions in the sphere right now', 'EMPTY');
    }
    ok(res, { question });
  })
);

// ---------- Search ----------
app.get(
  '/api/questions/search',
  requireDb,
  asyncRoute(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const questions = await searchQuestions(q, {
      topic_id: req.query.topic_id,
      limit: req.query.limit,
    });
    ok(res, { questions, query: q, count: questions.length });
  })
);

// ---------- Single question ----------
app.get(
  '/api/questions/:id',
  requireDb,
  asyncRoute(async (req, res) => {
    const question = await getQuestion(req.params.id);
    ok(res, { question });
  })
);

// ---------- Create question (no posting quota) ----------
app.post(
  '/api/questions',
  requireDb,
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const question = await createQuestion({
      text: body.text,
      topic_id: body.topic_id || body.topicId || null,
      x: body.x,
      y: body.y,
      z: body.z,
    });
    ok(res, { question }, 201);
  })
);

// ---------- Replies ----------
app.get(
  '/api/questions/:id/replies',
  requireDb,
  asyncRoute(async (req, res) => {
    const replies = await getReplies(req.params.id);
    ok(res, { replies });
  })
);

app.post(
  '/api/questions/:id/replies',
  requireDb,
  asyncRoute(async (req, res) => {
    const text = req.body && req.body.text;
    const reply = await createReply(req.params.id, text);
    ok(res, { reply }, 201);
  })
);

// ---------- Reports (store only — no auto-hide) ----------
app.post(
  '/api/reports',
  requireDb,
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const report = await createReport({
      question_id: body.question_id || body.questionId || null,
      reply_id: body.reply_id || body.replyId || null,
      reason: body.reason || null,
    });
    ok(res, { id: report.id, created_at: report.created_at }, 201);
  })
);

// ---------- Contact ----------
app.post(
  '/api/contact',
  requireDb,
  asyncRoute(async (req, res) => {
    const message = req.body && req.body.message;
    const row = await createContactMessage(message);
    ok(res, { id: row.id, created_at: row.created_at }, 201);
  })
);

// Optional: serve static frontend from ./public if present (do not create folder)
try {
  const publicDir = path.join(__dirname, 'public');
  const fs = require('fs');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    console.log('[qs] serving ./public');
  }
} catch (_) {
  /* ignore */
}

// 404
app.use((req, res) => {
  fail(res, 404, 'Endpoint not found', 'NOT_FOUND');
});

// Global error handler — never crash on bad requests
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return fail(res, 400, 'Invalid JSON body', 'INVALID_JSON');
  }
  if (err.type === 'entity.too.large') {
    return fail(res, 413, 'Request body too large', 'BODY_TOO_LARGE');
  }

  const status = err.status || err.statusCode || 500;
  const message =
    status >= 500
      ? 'Something went wrong'
      : err.message || 'Request failed';

  if (status >= 500) {
    console.error('[qs] error:', err.message || err);
  }

  return fail(res, status, message, err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function startServer() {
  // ALWAYS bind first so Railway sees a live process (do not await DB before listen)
  const server = app.listen(PORT, HOST, () => {
    console.log(`[qs] listening on http://${HOST}:${PORT}`);
    console.log('[qs] health: GET /  and  GET /api/health');
  });
  server.on('error', (err) => {
    console.error('[qs] listen error:', err.message);
  });

  initializeDatabase()
    .then(() => {
      setTimeout(() => cleanupExpiredData().catch(() => {}), 15000);
      const t = setInterval(() => cleanupExpiredData().catch(() => {}), 15 * 60 * 1000);
      if (t && typeof t.unref === 'function') t.unref();
    })
    .catch((err) => console.error('[qs] init after listen:', err.message));
}

process.on('uncaughtException', (err) => {
  console.error('[qs] uncaughtException', err.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[qs] unhandledRejection', reason);
});

startServer();
