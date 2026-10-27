import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import webpush from 'web-push';
import { Resend } from 'resend';

const SESSION_COOKIE = 'glicocare_session';
const SESSION_SECONDS = 60 * 60 * 12;
let pool;
function database() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new HttpError(503, 'Banco de dados não configurado. Defina DATABASE_URL e aplique as migrações.');
    const databaseUrl = new URL(process.env.DATABASE_URL);
    databaseUrl.searchParams.delete('sslmode');
    const ca = process.env.SUPABASE_CA_CERT_BASE64 ? Buffer.from(process.env.SUPABASE_CA_CERT_BASE64, 'base64').toString('utf8') : undefined;
    pool = new Pool({ connectionString: databaseUrl.toString(), options: '-c search_path=glicocare,public', ssl: process.env.DATABASE_SSL === 'false' ? false : { ca, rejectUnauthorized: true }, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 7000 });
    pool.on('error', (error) => console.error('Falha na conexão PostgreSQL:', error.code || 'erro interno'));
  }
  return pool;
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const passwordSchema = z.string().min(10).max(128);
const registerSchema = z.object({ name: z.string().trim().min(2).max(120), patientName: z.string().trim().min(2).max(120), email: emailSchema, password: passwordSchema });
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });
const recordSchema = z.object({
  occurredAt: z.string().datetime({ offset: true }), glucoseMgDl: z.number().int().min(1).max(2000).nullable().optional(),
  mealAt: z.string().datetime({ offset: true }).nullable().optional(), insulinStatus: z.enum(['applied', 'pending']).nullable().optional(),
  insulinUnits: z.number().positive().max(1000).nullable().optional(), insulinAt: z.string().datetime({ offset: true }).nullable().optional(),
  sweetConsumed: z.boolean().optional(), sweetAt: z.string().datetime({ offset: true }).nullable().optional(),
  sweetDetails: z.string().trim().max(1000).nullable().optional(), notes: z.string().trim().max(4000).nullable().optional(),
});
const updateSchema = recordSchema.partial();

function cookieOptions(maxAge = SESSION_SECONDS) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=${process.env.NODE_ENV === 'production' ? 'None' : 'Lax'}; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
function sessionCookie(token) { return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=${process.env.NODE_ENV === 'production' ? 'None' : 'Lax'}; Max-Age=${SESSION_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
function secretKey() {
  const value = process.env.JWT_SECRET;
  if (!value || Buffer.byteLength(value) < 32) throw new HttpError(503, 'Autenticação ainda não configurada. Defina JWT_SECRET com pelo menos 32 bytes.');
  return new TextEncoder().encode(value);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
function parseCookies(header = '') { return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => { const index = part.indexOf('='); return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]; })); }
function send(res, status, body, headers = {}) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value)); res.end(JSON.stringify(body)); }
function noContent(res, headers = {}) { res.statusCode = 204; Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value)); res.end(); }
async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32_768) throw new HttpError(413, 'O conteúdo enviado excede o limite permitido.'); chunks.push(chunk); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'O conteúdo enviado não está em um formato válido.'); }
}
function validate(schema, value) { const result = schema.safeParse(value); if (!result.success) throw new HttpError(422, result.error.issues.map((issue) => `${issue.path.join('.') || 'campo'}: ${issue.message}`).join('; ')); return result.data; }
function normalizePath(path) { const clean = decodeURIComponent(path.split('?')[0]).replace(/\/$/, ''); return clean.startsWith('/api/') ? clean.slice(4) : clean === '/api' ? '/' : clean; }
function assertOrigin(req) {
  const origin = req.headers.origin; const expected = process.env.FRONTEND_URL;
  if (origin && expected && origin.replace(/\/$/, '') !== expected.replace(/\/$/, '')) throw new HttpError(403, 'Origem não autorizada.');
  if (process.env.NODE_ENV === 'production' && !origin) throw new HttpError(403, 'A origem da solicitação não pôde ser validada.');
}
function clientIp(req) { const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); return forwarded || req.socket?.remoteAddress || 'unknown'; }
async function rateLimit(req, key, max = 20, minutes = 60) {
  const db = database(); const identity = sha256(`${key}:${clientIp(req)}`); const windowStart = new Date(Math.floor(Date.now() / (minutes * 60_000)) * minutes * 60_000);
  const result = await db.query(`INSERT INTO rate_limits (key_hash, window_start, attempts) VALUES ($1,$2,1)
    ON CONFLICT (key_hash, window_start) DO UPDATE SET attempts=rate_limits.attempts+1 RETURNING attempts`, [identity, windowStart]);
  if (Number(result.rows[0].attempts) > max) throw new HttpError(429, 'Muitas tentativas. Aguarde antes de tentar novamente.');
}
async function issueSession(res, user) {
  const token = await new SignJWT({ email: user.email, name: user.name }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime(`${SESSION_SECONDS}s`).sign(secretKey());
  res.setHeader('Set-Cookie', sessionCookie(token));
}
async function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) throw new HttpError(401, 'Entre na sua conta para continuar.');
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    if (!payload.sub) throw new Error('missing subject');
    const result = await database().query(`SELECT u.id,u.name,u.email FROM users u WHERE u.id=$1 AND u.deleted_at IS NULL`, [payload.sub]);
    if (!result.rowCount) throw new HttpError(401, 'Sua sessão expirou. Entre novamente.');
    return result.rows[0];
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(401, 'Sua sessão expirou. Entre novamente.'); }
}
async function patientForUser(userId, requestedId) {
  const params = [userId]; let where = '';
  if (requestedId) { params.push(requestedId); where = ' AND p.id=$2'; }
  const result = await database().query(`SELECT p.id,p.name,p.timezone,m.role FROM patients p JOIN memberships m ON m.patient_id=p.id
    WHERE m.user_id=$1 AND m.status='active' AND p.deleted_at IS NULL${where} ORDER BY m.joined_at DESC LIMIT 1`, params);
  if (!result.rowCount) throw new HttpError(403, 'Você não tem acesso a este acompanhamento.');
  return result.rows[0];
}
async function audit(client, patientId, userId, action, resourceType, resourceId, changedFields = []) {
  await client.query(`INSERT INTO audit_logs (patient_id,user_id,action,resource_type,resource_id,changed_fields) VALUES ($1,$2,$3,$4,$5,$6)`, [patientId, userId, action, resourceType, resourceId, changedFields]);
}
async function withTransaction(fn) {
  const client = await database().connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
function validateTimezone(timezone) {
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: timezone }).format(new Date()); return timezone; }
  catch { throw new HttpError(422, 'Informe um fuso horário IANA válido.'); }
}
function localToUtc(year, month, day, hour, minute, timezone) {
  const target = Date.UTC(year, month - 1, day, hour, minute); let candidate = target;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const adjustment = represented - target; if (!adjustment) break; candidate -= adjustment;
  }
  return new Date(candidate);
}
function dateInTimezone(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value])); return `${map.year}-${map.month}-${map.day}`;
}
function dateMonthBounds(month, timezone) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(422, 'Informe o mês no formato AAAA-MM.');
  const [year, value] = month.split('-').map(Number); const nextYear = value === 12 ? year + 1 : year; const nextMonth = value === 12 ? 1 : value + 1;
  return { start: localToUtc(year, value, 1, 0, 0, timezone), end: localToUtc(nextYear, nextMonth, 1, 0, 0, timezone), days: new Date(Date.UTC(year, value, 0)).getUTCDate() };
}
function eventSelect(extraWhere = '') {
  return `SELECT e.id,e.occurred_at AS "occurredAt",e.created_at AS "createdAt",e.updated_at AS "updatedAt",e.notes,
    u.name AS "authorName",g.value_mg_dl AS "glucoseMgDl",g.meal_at AS "mealAt",i.status AS "insulinStatus",i.units AS "insulinUnits",i.applied_at AS "insulinAt",
    s.consumed_at AS "sweetAt",s.details AS "sweetDetails",(s.id IS NOT NULL) AS "sweetConsumed"
    FROM care_events e JOIN users u ON u.id=e.author_user_id LEFT JOIN glucose_measurements g ON g.event_id=e.id
    LEFT JOIN insulin_applications i ON i.event_id=e.id LEFT JOIN sweet_events s ON s.event_id=e.id ${extraWhere}`;
}
function eventJson(row) { return { ...row, glucoseMgDl: row.glucoseMgDl == null ? null : Number(row.glucoseMgDl), insulinUnits: row.insulinUnits == null ? null : Number(row.insulinUnits), insulinStatus: row.insulinStatus || null, sweetConsumed: Boolean(row.sweetConsumed) }; }
async function fetchEvents(patientId, { start, end, limit = 100 } = {}) {
  const params = [patientId]; let where = 'WHERE e.patient_id=$1';
  if (start) { params.push(start); where += ` AND e.occurred_at >= $${params.length}`; }
  if (end) { params.push(end); where += ` AND e.occurred_at < $${params.length}`; }
  params.push(limit);
  const result = await database().query(`${eventSelect(where)} ORDER BY e.occurred_at DESC LIMIT $${params.length}`, params);
  return result.rows.map(eventJson);
}
async function createEvent(client, patientId, userId, record) {
  const base = await client.query(`INSERT INTO care_events (patient_id,author_user_id,occurred_at,notes) VALUES ($1,$2,$3,$4) RETURNING id`, [patientId, userId, record.occurredAt, record.notes || null]);
  const id = base.rows[0].id; const fields = [];
  if (record.glucoseMgDl != null) { await client.query(`INSERT INTO glucose_measurements (event_id,value_mg_dl,measured_at,meal_at) VALUES ($1,$2,$3,$4)`, [id, record.glucoseMgDl, record.occurredAt, record.mealAt || null]); fields.push('glicose'); }
  if (record.insulinStatus) { const applied = record.insulinStatus === 'applied'; if (!applied && (record.insulinUnits != null || record.insulinAt)) throw new HttpError(422, 'Aplicação pendente não pode ter quantidade aplicada ou horário de aplicação.');
    await client.query(`INSERT INTO insulin_applications (event_id,status,units,applied_at) VALUES ($1,$2,$3,$4)`, [id, record.insulinStatus, applied ? record.insulinUnits || null : null, applied ? record.insulinAt || null : null]); fields.push('insulina'); }
  if (record.sweetConsumed) { await client.query(`INSERT INTO sweet_events (event_id,consumed_at,details) VALUES ($1,$2,$3)`, [id, record.sweetAt || record.occurredAt, record.sweetDetails || null]); fields.push('algo doce'); }
  if (!fields.length && !record.notes) throw new HttpError(422, 'Informe ao menos uma medição, aplicação, ocorrência ou observação.');
  await audit(client, patientId, userId, 'created', 'care_event', id, fields); return id;
}
async function updateEvent(client, patientId, userId, id, input) {
  const found = await client.query('SELECT id FROM care_events WHERE id=$1 AND patient_id=$2 FOR UPDATE', [id, patientId]);
  if (!found.rowCount) throw new HttpError(404, 'Registro não encontrado.');
  const updates = [];
  if ('occurredAt' in input) { await client.query('UPDATE care_events SET occurred_at=$1 WHERE id=$2', [input.occurredAt, id]); updates.push('data e horário'); }
  if ('notes' in input) { await client.query('UPDATE care_events SET notes=$1 WHERE id=$2', [input.notes || null, id]); updates.push('observações'); }
  if ('glucoseMgDl' in input || 'mealAt' in input) {
    const current = await client.query('SELECT id,value_mg_dl,meal_at FROM glucose_measurements WHERE event_id=$1', [id]);
    if (input.glucoseMgDl === null) { await client.query('DELETE FROM glucose_measurements WHERE event_id=$1', [id]); }
    else if (current.rowCount) await client.query('UPDATE glucose_measurements SET value_mg_dl=$1,meal_at=$2,measured_at=COALESCE($3,measured_at) WHERE event_id=$4', [input.glucoseMgDl ?? Number(current.rows[0].value_mg_dl), input.mealAt === undefined ? current.rows[0].meal_at : input.mealAt, input.occurredAt || null, id]);
    else if (input.glucoseMgDl != null) await client.query('INSERT INTO glucose_measurements (event_id,value_mg_dl,measured_at,meal_at) VALUES ($1,$2,COALESCE($3,now()),$4)', [id, input.glucoseMgDl, input.occurredAt || null, input.mealAt || null]);
    updates.push('glicose');
  }
  if ('insulinStatus' in input || 'insulinUnits' in input || 'insulinAt' in input) {
    const current = await client.query('SELECT status,units,applied_at FROM insulin_applications WHERE event_id=$1', [id]);
    const status = input.insulinStatus === undefined ? current.rows[0]?.status : input.insulinStatus;
    if (!status) await client.query('DELETE FROM insulin_applications WHERE event_id=$1', [id]);
    else { const applied = status === 'applied'; const units = applied ? (input.insulinUnits === undefined ? current.rows[0]?.units : input.insulinUnits) : null; const appliedAt = applied ? (input.insulinAt === undefined ? current.rows[0]?.applied_at : input.insulinAt) : null;
      if (!current.rowCount) await client.query('INSERT INTO insulin_applications (event_id,status,units,applied_at) VALUES ($1,$2,$3,$4)', [id, status, units, appliedAt]);
      else await client.query('UPDATE insulin_applications SET status=$1,units=$2,applied_at=$3 WHERE event_id=$4', [status, units, appliedAt, id]); }
    updates.push('insulina');
  }
  if ('sweetConsumed' in input || 'sweetAt' in input || 'sweetDetails' in input) {
    if (input.sweetConsumed === false) await client.query('DELETE FROM sweet_events WHERE event_id=$1', [id]);
    else { const current = await client.query('SELECT consumed_at,details FROM sweet_events WHERE event_id=$1', [id]); if (!current.rowCount && input.sweetConsumed) await client.query('INSERT INTO sweet_events (event_id,consumed_at,details) VALUES ($1,$2,$3)', [id, input.sweetAt || new Date(), input.sweetDetails || null]); else if (current.rowCount) await client.query('UPDATE sweet_events SET consumed_at=$1,details=$2 WHERE event_id=$3', [input.sweetAt === undefined ? current.rows[0].consumed_at : input.sweetAt, input.sweetDetails === undefined ? current.rows[0].details : input.sweetDetails, id]); }
    updates.push('algo doce');
  }
  await client.query('UPDATE care_events SET updated_at=now() WHERE id=$1', [id]); await audit(client, patientId, userId, 'updated', 'care_event', id, updates);
}
async function summaryFor(patient, month) {
  const { start, end, days } = dateMonthBounds(month, patient.timezone); const db = database();
  const aggregates = await db.query(`SELECT COUNT(g.id)::int AS measurements,ROUND(AVG(g.value_mg_dl),1)::float AS mean,MIN(g.value_mg_dl)::int AS min,MAX(g.value_mg_dl)::int AS max,
    COUNT(DISTINCT ((e.occurred_at AT TIME ZONE $3)::date))::int AS record_days,
    COUNT(*) FILTER (WHERE i.status='applied')::int AS applied,
    COUNT(*) FILTER (WHERE i.status='applied' AND (i.units IS NULL OR i.applied_at IS NULL))::int AS incomplete,
    COUNT(s.id)::int AS sweets
    FROM care_events e LEFT JOIN glucose_measurements g ON g.event_id=e.id LEFT JOIN insulin_applications i ON i.event_id=e.id LEFT JOIN sweet_events s ON s.event_id=e.id
    WHERE e.patient_id=$1 AND e.occurred_at >= $2 AND e.occurred_at < $4`, [patient.id, start, patient.timezone, end]);
  const [year, monthNumber] = month.split('-').map(Number); const previousDate = new Date(Date.UTC(year, monthNumber - 2, 1)); const previousMonth = `${previousDate.getUTCFullYear()}-${String(previousDate.getUTCMonth() + 1).padStart(2, '0')}`; const previousBounds = dateMonthBounds(previousMonth, patient.timezone);
  const [previous, authors, events] = await Promise.all([
    db.query(`SELECT COUNT(g.id)::int AS measurements,ROUND(AVG(g.value_mg_dl),1)::float AS mean FROM care_events e LEFT JOIN glucose_measurements g ON g.event_id=e.id WHERE e.patient_id=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3`, [patient.id, previousBounds.start, previousBounds.end]),
    db.query(`SELECT u.id,u.name,COUNT(e.id)::int AS "eventCount",COUNT(g.id)::int AS "measurementCount" FROM care_events e JOIN users u ON u.id=e.author_user_id LEFT JOIN glucose_measurements g ON g.event_id=e.id WHERE e.patient_id=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3 GROUP BY u.id,u.name ORDER BY "eventCount" DESC`, [patient.id,start,end]),
    fetchEvents(patient.id, { start, end, limit: 500 }),
  ]);
  const row = aggregates.rows[0]; const prior = previous.rows[0]; const comparison = Number(prior.measurements) ? { previousMonth, previousMeasurementCount: Number(prior.measurements), previousMean: prior.mean == null ? null : Number(prior.mean), measurementDelta: Number(row.measurements) - Number(prior.measurements), meanDelta: row.mean == null || prior.mean == null ? null : Number((Number(row.mean) - Number(prior.mean)).toFixed(1)) } : null;
  return { month, measurementCount: Number(row.measurements), mean: row.mean == null ? null : Number(row.mean), min: row.min == null ? null : Number(row.min), max: row.max == null ? null : Number(row.max), appliedCount: Number(row.applied), sweetCount: Number(row.sweets), dayCount: Number(row.record_days), daysWithoutRecords: Math.max(0, days - Number(row.record_days)), incompleteCount: Number(row.incomplete), authorBreakdown: authors.rows, comparison, events };
}
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return false;
  const client = new Resend(process.env.RESEND_API_KEY); const result = await client.emails.send({ from: process.env.EMAIL_FROM, to, subject, html });
  if (result.error) throw new HttpError(502, 'Não foi possível entregar o e-mail agora. Tente novamente mais tarde.'); return true;
}
function publicBaseUrl() { return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, ''); }
function validSubscription(value) {
  const result = z.object({ endpoint: z.string().url().max(2048), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string().min(16).max(256), auth: z.string().min(8).max(128) }) }).safeParse(value);
  if (!result.success) throw new HttpError(422, 'Assinatura de notificações inválida.'); return result.data;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost'); const path = normalizePath(url.pathname); const method = req.method || 'GET';
  if (method === 'OPTIONS') { noContent(res, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); return; }
  if (!['GET', 'HEAD'].includes(method)) assertOrigin(req);
  if (path === '/health' && method === 'GET') { send(res, 200, { status: 'ok', service: 'GlicoCare API', databaseConfigured: Boolean(process.env.DATABASE_URL) }); return; }
  if (path === '/openapi.json' && method === 'GET') { send(res, 200, openApi); return; }

  if (path === '/auth/register' && method === 'POST') {
    secretKey(); await rateLimit(req, 'register', 5); const data = validate(registerSchema, await readBody(req)); const hash = await bcrypt.hash(data.password, 12);
    const user = await withTransaction(async (client) => {
      const existing = await client.query('SELECT id FROM users WHERE email=$1', [data.email]); if (existing.rowCount) throw new HttpError(409, 'Este e-mail já possui uma conta.');
      const inserted = await client.query('INSERT INTO users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id,name,email', [data.name, data.email, hash]);
      const patient = await client.query('INSERT INTO patients (name,timezone) VALUES ($1,$2) RETURNING id', [data.patientName, process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo']);
      await client.query("INSERT INTO memberships (patient_id,user_id,role,status) VALUES ($1,$2,'owner','active')", [patient.rows[0].id, inserted.rows[0].id]);
      await client.query("INSERT INTO reminders (patient_id,local_time,timezone,enabled) VALUES ($1,'22:00',$2,false)", [patient.rows[0].id, process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo']);
      await audit(client, patient.rows[0].id, inserted.rows[0].id, 'created', 'patient', patient.rows[0].id, ['acompanhamento']); return inserted.rows[0];
    });
    await issueSession(res, user); send(res, 201, { user }); return;
  }
  if (path === '/auth/login' && method === 'POST') {
    secretKey(); await rateLimit(req, 'login', 10); const data = validate(loginSchema, await readBody(req)); const result = await database().query('SELECT id,name,email,password_hash FROM users WHERE email=$1 AND deleted_at IS NULL', [data.email]);
    const user = result.rows[0]; if (!user || !(await bcrypt.compare(data.password, user.password_hash))) throw new HttpError(401, 'E-mail ou senha incorretos.');
    await issueSession(res, user); send(res, 200, { user: { id: user.id, name: user.name, email: user.email } }); return;
  }
  if (path === '/auth/logout' && method === 'POST') { res.setHeader('Set-Cookie', cookieOptions(0)); noContent(res); return; }
  if (path === '/auth/me' && method === 'GET') { const user = await currentUser(req); send(res, 200, { user }); return; }
  if (path === '/auth/password/forgot' && method === 'POST') {
    await rateLimit(req, 'password-reset', 5); const { email } = validate(z.object({ email: emailSchema }), await readBody(req)); const result = await database().query('SELECT id FROM users WHERE email=$1 AND deleted_at IS NULL', [email]);
    if (result.rowCount) { const raw = randomBytes(32).toString('base64url'); await database().query('INSERT INTO password_resets (user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval \'1 hour\')', [result.rows[0].id, sha256(raw)]); await sendEmail(email, 'Recuperação de acesso ao GlicoCare', `<p>Para redefinir sua senha, acesse <a href="${publicBaseUrl()}/?redefinir=${raw}">este link seguro</a>. O link expira em uma hora.</p>`); }
    send(res, 200, { message: 'Se o e-mail estiver cadastrado, você receberá as instruções de recuperação.' }); return;
  }
  if (path === '/auth/password/reset' && method === 'POST') {
    const data = validate(z.object({ token: z.string().min(32).max(128), password: passwordSchema }), await readBody(req)); const hash = await bcrypt.hash(data.password, 12);
    await withTransaction(async (client) => { const reset = await client.query('SELECT id,user_id FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE', [sha256(data.token)]); if (!reset.rowCount) throw new HttpError(400, 'Este link expirou ou já foi utilizado.'); await client.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [hash, reset.rows[0].user_id]); await client.query('UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [reset.rows[0].user_id]); });
    send(res, 200, { message: 'Senha atualizada. Você já pode entrar com a nova senha.' }); return;
  }

  if (path === '/jobs/reminders' && method === 'GET') {
    const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); if (!process.env.CRON_SECRET || !safeEqual(provided, process.env.CRON_SECRET)) throw new HttpError(401, 'Acesso não autorizado.');
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) throw new HttpError(503, 'Envio de notificações push não está configurado.');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    const db = database(); const now = new Date();
    await db.query(`UPDATE reminder_recipient_deliveries SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,next_attempt_at=now(),updated_at=now()
      WHERE status='sending' AND updated_at<now()-interval '10 minutes'`);
    const due = await db.query(`SELECT r.id,r.patient_id,r.timezone FROM reminders r WHERE r.enabled=true
      AND r.local_time <= (now() AT TIME ZONE r.timezone)::time
      AND NOT EXISTS (SELECT 1 FROM reminder_deliveries d WHERE d.reminder_id=r.id AND d.occurrence_date=(now() AT TIME ZONE r.timezone)::date)`);
    for (const reminder of due.rows) {
      const occurrence = dateInTimezone(now, reminder.timezone);
      const inserted = await db.query(`INSERT INTO reminder_deliveries (reminder_id,occurrence_date,status) VALUES ($1,$2,'queued') ON CONFLICT (reminder_id,occurrence_date) DO NOTHING RETURNING id`, [reminder.id, occurrence]);
      const deliveryId = inserted.rows[0]?.id || (await db.query('SELECT id FROM reminder_deliveries WHERE reminder_id=$1 AND occurrence_date=$2', [reminder.id, occurrence])).rows[0]?.id;
      if (!deliveryId) continue;
      await db.query(`INSERT INTO reminder_recipient_deliveries (delivery_id,subscription_id)
        SELECT $1,ps.id FROM push_subscriptions ps JOIN memberships m ON m.user_id=ps.user_id
        WHERE m.patient_id=$2 AND m.status='active' AND ps.status='active' ON CONFLICT (delivery_id,subscription_id) DO NOTHING`, [deliveryId, reminder.patient_id]);
    }
    const retryable = await db.query(`SELECT rd.id,rd.delivery_id,ps.id AS subscription_id,ps.endpoint,ps.keys
      FROM reminder_recipient_deliveries rd JOIN push_subscriptions ps ON ps.id=rd.subscription_id
      WHERE rd.status='queued' AND rd.attempts<3 AND rd.next_attempt_at<=now() AND ps.status='active'
      ORDER BY rd.created_at LIMIT 500`);
    let sentCount = 0; let failedCount = 0;
    for (const item of retryable.rows) {
      const claimed = await db.query(`UPDATE reminder_recipient_deliveries SET status='sending',attempts=attempts+1,updated_at=now()
        WHERE id=$1 AND status='queued' AND attempts<3 RETURNING attempts`, [item.id]);
      if (!claimed.rowCount) continue;
      try {
        await webpush.sendNotification({ endpoint: item.endpoint, keys: item.keys }, JSON.stringify({ title: 'GlicoCare', body: 'Lembrete de cuidado: confira sua rotina de insulina e registre a aplicação, conforme a orientação do seu profissional de saúde.', url: `${publicBaseUrl()}/?pagina=registrar` }), { TTL: 60 * 60 });
        sentCount++; await db.query(`UPDATE reminder_recipient_deliveries SET status='sent',sent_at=now(),updated_at=now() WHERE id=$1`, [item.id]);
      } catch (error) {
        const attempts = Number(claimed.rows[0].attempts); const gone = [404, 410].includes(error.statusCode); failedCount++;
        if (gone) await db.query("UPDATE push_subscriptions SET status='revoked',updated_at=now() WHERE id=$1", [item.subscription_id]);
        const status = gone || attempts >= 3 ? 'failed' : 'queued';
        await db.query(`UPDATE reminder_recipient_deliveries SET status=$1,next_attempt_at=now()+interval '5 minutes',updated_at=now() WHERE id=$2`, [status,item.id]);
      }
      await db.query(`UPDATE reminder_deliveries d SET
        sent_count=(SELECT COUNT(*)::int FROM reminder_recipient_deliveries x WHERE x.delivery_id=d.id AND x.status='sent'),
        failed_count=(SELECT COUNT(*)::int FROM reminder_recipient_deliveries x WHERE x.delivery_id=d.id AND x.status='failed'),
        attempted_at=now(),status=CASE WHEN EXISTS(SELECT 1 FROM reminder_recipient_deliveries x WHERE x.delivery_id=d.id AND x.status IN ('queued','sending')) THEN 'queued'
          WHEN EXISTS(SELECT 1 FROM reminder_recipient_deliveries x WHERE x.delivery_id=d.id AND x.status='failed') AND EXISTS(SELECT 1 FROM reminder_recipient_deliveries x WHERE x.delivery_id=d.id AND x.status='sent') THEN 'partial'
          WHEN EXISTS(SELECT 1 FROM reminder_recipient_deliveries x WHERE x.delivery_id=d.id AND x.status='failed') THEN 'failed' ELSE 'sent' END
        WHERE d.id=$1`, [item.delivery_id]);
    }
    const withoutDevices = await db.query(`UPDATE reminder_deliveries d SET status='failed',attempted_at=now()
      WHERE d.status='queued' AND NOT EXISTS (SELECT 1 FROM reminder_recipient_deliveries x WHERE x.delivery_id=d.id)`);
    send(res, 200, { status: 'ok', occurrences: due.rowCount, attempted: retryable.rowCount, sent: sentCount, failed: failedCount, withoutDevices: withoutDevices.rowCount }); return;
  }

  const user = await currentUser(req); const db = database();
  if (path === '/patients/current' && method === 'GET') { const patient = await patientForUser(user.id, url.searchParams.get('patientId')); send(res, 200, { patient }); return; }
  if (path === '/records' && method === 'GET') {
    const patient = await patientForUser(user.id, url.searchParams.get('patientId')); const limitRaw = Number(url.searchParams.get('limit') || 100); const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 100;
    const start = url.searchParams.get('from'); const end = url.searchParams.get('to'); const events = await fetchEvents(patient.id, { start: start ? localToUtc(...start.split('-').map(Number), 0, 0, patient.timezone) : undefined, end: end ? (() => { const [y,m,d] = end.split('-').map(Number); const date = new Date(Date.UTC(y,m-1,d+1)); return localToUtc(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),0,0,patient.timezone); })() : undefined, limit });
    send(res, 200, { events }); return;
  }
  if (path === '/records' && method === 'POST') {
    const patient = await patientForUser(user.id, url.searchParams.get('patientId')); const data = validate(recordSchema, await readBody(req));
    const id = await withTransaction((client) => createEvent(client, patient.id, user.id, data)); send(res, 201, { id, message: 'Registro salvo.' }); return;
  }
  const recordRoute = path.match(/^\/records\/([0-9a-f-]{36})$/i);
  if (recordRoute && (method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
    const patient = await patientForUser(user.id, url.searchParams.get('patientId')); const id = recordRoute[1];
    if (method === 'DELETE') { await withTransaction(async (client) => { const result = await client.query('SELECT id FROM care_events WHERE id=$1 AND patient_id=$2 FOR UPDATE', [id, patient.id]); if (!result.rowCount) throw new HttpError(404, 'Registro não encontrado.'); await audit(client, patient.id, user.id, 'deleted', 'care_event', id, []); await client.query('DELETE FROM care_events WHERE id=$1', [id]); }); noContent(res); return; }
    const data = validate(updateSchema, await readBody(req)); await withTransaction((client) => updateEvent(client, patient.id, user.id, id, data)); send(res, 200, { message: 'Registro atualizado.' }); return;
  }
  if (path === '/reports/month' && method === 'GET') { const patient = await patientForUser(user.id, url.searchParams.get('patientId')); const month = url.searchParams.get('month') || new Intl.DateTimeFormat('en-CA', { timeZone: patient.timezone, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0,7); send(res, 200, await summaryFor(patient, month)); return; }
  if (path === '/reports/month/pdf' && method === 'GET') {
    const patient = await patientForUser(user.id, url.searchParams.get('patientId')); const month = url.searchParams.get('month') || new Intl.DateTimeFormat('en-CA', { timeZone: patient.timezone, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0,7); const report = await summaryFor(patient, month);
    const doc = new PDFDocument({ size: 'A4', margin: 52, info: { Title: 'Relatório mensal GlicoCare', Author: 'GlicoCare' } }); const chunks = []; doc.on('data', (chunk) => chunks.push(chunk)); const finished = new Promise((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); });
    doc.fontSize(20).fillColor('#004bd3').text('GlicoCare', { continued: true }).fillColor('#0b1c30').fontSize(14).text('  · Relatório mensal de registros'); doc.moveDown(); doc.fontSize(12).fillColor('#0b1c30').text(`Pessoa acompanhada: ${patient.name}`); doc.text(`Período: ${monthLabelPt(month)}`); doc.text(`Gerado em: ${new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:patient.timezone}).format(new Date())}`); doc.moveDown();
    doc.fontSize(11).text(`Medições: ${report.measurementCount}`); doc.text(`Média dos valores informados: ${report.mean ?? 'Sem dados'}${report.mean == null ? '' : ' mg/dL'}`); doc.text(`Menor valor: ${report.min ?? 'Sem dados'}${report.min == null ? '' : ' mg/dL'}`); doc.text(`Maior valor: ${report.max ?? 'Sem dados'}${report.max == null ? '' : ' mg/dL'}`); doc.text(`Aplicações registradas como realizadas: ${report.appliedCount}`); doc.text(`Ocorrências de consumo de algo doce: ${report.sweetCount}`); doc.text(`Dias com registros: ${report.dayCount} · dias sem registros: ${report.daysWithoutRecords}`); doc.moveDown().fontSize(13).text('Histórico'); doc.moveDown(0.4);
    report.events.forEach((event) => { if (doc.y > 730) doc.addPage(); const parts = [event.glucoseMgDl != null && `Glicose: ${event.glucoseMgDl} mg/dL`, event.insulinStatus === 'applied' && `Insulina aplicada${event.insulinUnits ? ` · ${event.insulinUnits} UI` : ''}`, event.insulinStatus === 'pending' && 'Aplicação pendente', event.sweetConsumed && 'Consumo de algo doce', event.notes].filter(Boolean); doc.fontSize(9).fillColor('#0b1c30').text(`${new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:patient.timezone}).format(new Date(event.occurredAt))} · ${parts.join(' · ') || 'Registro de cuidado'}`); doc.fillColor('#64748b').text(`Registrado por ${event.authorName}`, { indent: 10 }); doc.moveDown(0.4); });
    doc.moveDown().fontSize(8).fillColor('#64748b').text('Este documento apresenta registros informados no GlicoCare e não constitui diagnóstico, meta clínica ou orientação médica.', { align: 'left' }); doc.end(); await finished;
    res.statusCode = 200; res.setHeader('Content-Type','application/pdf'); res.setHeader('Content-Disposition',`attachment; filename="glicocare-relatorio-${month}.pdf"`); res.end(Buffer.concat(chunks)); return;
  }
  if (path === '/sharing' && method === 'GET') {
    const patient = await patientForUser(user.id, url.searchParams.get('patientId')); const members = await db.query(`SELECT m.id,u.name,u.email,m.role,m.joined_at AS "joinedAt" FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.patient_id=$1 AND m.status='active' ORDER BY m.joined_at`, [patient.id]); send(res, 200, { members: members.rows }); return;
  }
  if (path === '/invites' && method === 'POST') {
    const patient = await patientForUser(user.id, url.searchParams.get('patientId')); if (patient.role !== 'owner') throw new HttpError(403, 'Somente o responsável principal pode convidar pessoas.');
    if (process.env.NODE_ENV === 'production' && (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)) throw new HttpError(503, 'O serviço de e-mail ainda não está configurado; o convite não foi criado.');
    const { email } = validate(z.object({ email: emailSchema }), await readBody(req)); const raw = randomBytes(32).toString('base64url'); const urlToAccept = `${publicBaseUrl()}/?convite=${raw}`;
    const count = await db.query("SELECT COUNT(*)::int AS total FROM memberships WHERE patient_id=$1 AND status='active'", [patient.id]); if (Number(count.rows[0].total) >= 2) throw new HttpError(409, 'Este acompanhamento já possui duas pessoas autorizadas.');
    const exists = await db.query("SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.patient_id=$1 AND u.email=$2 AND m.status='active'", [patient.id, email]); if (exists.rowCount) throw new HttpError(409, 'Esta pessoa já tem acesso ao acompanhamento.');
    const expiresAt = new Date(Date.now() + 7 * 86400_000); await db.query("INSERT INTO invitations (patient_id,email,role,token_hash,expires_at,created_by) VALUES ($1,$2,'caregiver',$3,$4,$5) ON CONFLICT (patient_id,email) WHERE status='pending' DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,created_by=EXCLUDED.created_by", [patient.id, email, sha256(raw), expiresAt, user.id]);
    let sent = false;
    try { sent = await sendEmail(email, 'Convite para acompanhar no GlicoCare', `<p>Você foi convidado(a) a acompanhar registros no GlicoCare.</p><p><a href="${urlToAccept}">Aceitar convite</a> · Este link expira em 7 dias e só pode ser usado pela conta ${email}.</p>`); }
    catch (error) { await db.query("UPDATE invitations SET status='revoked' WHERE token_hash=$1 AND status='pending'", [sha256(raw)]); throw error; }
    if (!sent && process.env.NODE_ENV === 'production') { await db.query("UPDATE invitations SET status='revoked' WHERE token_hash=$1 AND status='pending'", [sha256(raw)]); throw new HttpError(503, 'O serviço de e-mail ainda não está configurado; o convite não foi enviado.'); }
    await withTransaction((client) => audit(client, patient.id, user.id, 'created', 'invitation', 'pending', ['convite de cuidador']));
    send(res, 201, { message: sent ? 'Convite enviado. Ele expira em 7 dias e só pode ser aceito pela conta indicada.' : 'Convite criado para desenvolvimento. Configure o serviço de e-mail antes de usar em produção.', ...(process.env.NODE_ENV !== 'production' ? { inviteUrl: urlToAccept } : {}) }); return;
  }
  if (path === '/invites/accept' && method === 'POST') {
    const { token } = validate(z.object({ token: z.string().min(32).max(128) }), await readBody(req)); const membership = await withTransaction(async (client) => { const inv = await client.query("SELECT id,patient_id,email FROM invitations WHERE token_hash=$1 AND status='pending' AND expires_at>now() FOR UPDATE", [sha256(token)]); if (!inv.rowCount) throw new HttpError(400, 'Este convite expirou ou já foi utilizado.'); if (inv.rows[0].email !== user.email) throw new HttpError(403, 'Entre com o e-mail que recebeu o convite.'); const count = await client.query("SELECT COUNT(*)::int AS total FROM memberships WHERE patient_id=$1 AND status='active'", [inv.rows[0].patient_id]); if (Number(count.rows[0].total) >= 2) throw new HttpError(409, 'Este acompanhamento já atingiu o limite de pessoas.'); const inserted = await client.query("INSERT INTO memberships (patient_id,user_id,role,status) VALUES ($1,$2,'caregiver','active') ON CONFLICT (patient_id,user_id) DO UPDATE SET status='active',revoked_at=NULL RETURNING id,patient_id", [inv.rows[0].patient_id,user.id]); await client.query("UPDATE invitations SET status='accepted',accepted_at=now() WHERE id=$1", [inv.rows[0].id]); await audit(client, inv.rows[0].patient_id, user.id, 'accepted', 'invitation', inv.rows[0].id, []); return inserted.rows[0]; }); send(res, 200, { membership }); return;
  }
  const sharingRoute = path.match(/^\/sharing\/([0-9a-f-]{36})$/i);
  if (sharingRoute && method === 'DELETE') { const patient = await patientForUser(user.id, url.searchParams.get('patientId')); if (patient.role !== 'owner') throw new HttpError(403, 'Somente o responsável principal pode revogar o acesso.'); await withTransaction(async (client) => { const target = await client.query("UPDATE memberships SET status='revoked',revoked_at=now(),updated_at=now() WHERE id=$1 AND patient_id=$2 AND role='caregiver' AND status='active' RETURNING user_id", [sharingRoute[1], patient.id]); if (!target.rowCount) throw new HttpError(404, 'Vínculo não encontrado.'); await audit(client, patient.id, user.id, 'revoked', 'membership', sharingRoute[1], []); }); noContent(res); return; }
  if (path === '/reminders' && method === 'GET') { const patient = await patientForUser(user.id, url.searchParams.get('patientId')); let result = await db.query(`SELECT to_char(local_time,'HH24:MI') AS "localTime",timezone,enabled FROM reminders WHERE patient_id=$1`, [patient.id]); if (!result.rowCount) result = { rows: [{ localTime: '22:00', timezone: patient.timezone, enabled: false }] }; send(res, 200, result.rows[0]); return; }
  if (path === '/reminders' && (method === 'PUT' || method === 'PATCH')) { const patient = await patientForUser(user.id, url.searchParams.get('patientId')); const data = validate(z.object({ enabled: z.boolean(), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().min(1).max(100) }), await readBody(req)); const timezone = validateTimezone(data.timezone); await withTransaction(async (client) => { await client.query(`INSERT INTO reminders (patient_id,local_time,timezone,enabled) VALUES ($1,$2,$3,$4) ON CONFLICT (patient_id) DO UPDATE SET local_time=EXCLUDED.local_time,timezone=EXCLUDED.timezone,enabled=EXCLUDED.enabled,updated_at=now()`, [patient.id,data.localTime,timezone,data.enabled]); await client.query('UPDATE patients SET timezone=$1,updated_at=now() WHERE id=$2', [timezone,patient.id]); await audit(client, patient.id, user.id, 'updated', 'reminder', patient.id, ['preferências do lembrete','fuso horário']); }); send(res, 200, { ...data, timezone }); return; }
  if (path === '/push/public-key' && method === 'GET') { if (!process.env.VAPID_PUBLIC_KEY) throw new HttpError(503, 'Notificações push não estão configuradas.'); send(res, 200, { publicKey: process.env.VAPID_PUBLIC_KEY }); return; }
  if (path === '/push/subscriptions' && method === 'POST') { const patient = await patientForUser(user.id, url.searchParams.get('patientId')); const subscription = validSubscription(await readBody(req)); await db.query(`INSERT INTO push_subscriptions (user_id,endpoint,keys,status) VALUES ($1,$2,$3,'active') ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,keys=EXCLUDED.keys,status='active',updated_at=now()`, [user.id,subscription.endpoint,subscription.keys]); await withTransaction((client) => audit(client,patient.id,user.id,'created','push_subscription','registered',[])); send(res,201,{message:'Dispositivo registrado para notificações.'}); return; }
  const pushRoute = path.match(/^\/push\/subscriptions\/([0-9a-f-]{36})$/i);
  if (pushRoute && method === 'DELETE') { const patient = await patientForUser(user.id, url.searchParams.get('patientId')); await db.query("UPDATE push_subscriptions SET status='revoked',updated_at=now() WHERE id=$1 AND user_id=$2", [pushRoute[1],user.id]); await withTransaction((client) => audit(client,patient.id,user.id,'revoked','push_subscription',pushRoute[1],[])); noContent(res); return; }
  if (path === '/push/subscriptions/remove' && method === 'POST') { const patient = await patientForUser(user.id, url.searchParams.get('patientId')); const { endpoint } = validate(z.object({ endpoint: z.string().url().max(2048) }), await readBody(req)); await db.query("UPDATE push_subscriptions SET status='revoked',updated_at=now() WHERE endpoint=$1 AND user_id=$2", [endpoint,user.id]); await withTransaction((client) => audit(client,patient.id,user.id,'revoked','push_subscription','device',[])); send(res,200,{message:'Dispositivo removido das notificações.'}); return; }
  throw new HttpError(404, 'Rota não encontrada.');
}

function monthLabelPt(month) { const [year, value] = month.split('-').map(Number); return new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric'}).format(new Date(year,value-1,1)); }
const openApi = { openapi: '3.1.0', info: { title: 'GlicoCare API', version: '1.0.0', description: 'API de registros de acompanhamento compartilhado. Rotas privadas exigem cookie de sessão HttpOnly.' }, servers: [{ url: '/api' }], paths: {
  '/health': { get: { summary: 'Estado do serviço', responses: { 200: { description: 'API disponível' } } } },
  '/auth/register': { post: { summary: 'Criar conta e acompanhamento', responses: { 201: { description: 'Conta criada' }, 409: { description: 'E-mail existente' } } } },
  '/auth/login': { post: { summary: 'Entrar', responses: { 200: { description: 'Sessão criada' }, 401: { description: 'Credenciais inválidas' } } } },
  '/auth/logout': { post: { summary: 'Encerrar sessão', responses: { 204: { description: 'Sessão encerrada' } } } },
  '/auth/me': { get: { summary: 'Consultar sessão', responses: { 200: { description: 'Usuário atual' } } } },
  '/records': { get: { summary: 'Listar registros', parameters: [{ name:'from',in:'query',schema:{type:'string',format:'date'} },{ name:'to',in:'query',schema:{type:'string',format:'date'} },{ name:'limit',in:'query',schema:{type:'integer',maximum:200} }], responses:{200:{description:'Histórico autorizado'}} }, post:{summary:'Criar registro de cuidado',responses:{201:{description:'Registro persistido'},422:{description:'Dados inválidos'}}} },
  '/records/{id}': { patch:{summary:'Atualizar registro',responses:{200:{description:'Atualizado'},404:{description:'Não encontrado'}}}, delete:{summary:'Excluir registro com auditoria',responses:{204:{description:'Excluído'}}} },
  '/reports/month': { get:{summary:'Resumo estatístico descritivo mensal',responses:{200:{description:'Resumo autorizado'}}} },
  '/reports/month/pdf': { get:{summary:'Gerar relatório PDF autorizado',responses:{200:{description:'PDF'}}} },
  '/sharing': { get:{summary:'Listar pessoas vinculadas',responses:{200:{description:'Vínculos autorizados'}}} },
  '/invites': { post:{summary:'Convidar cuidador por e-mail',responses:{201:{description:'Convite criado'}}} },
  '/invites/accept': { post:{summary:'Aceitar convite de uso único',responses:{200:{description:'Convite aceito'}}} },
  '/reminders': { get:{summary:'Consultar lembrete',responses:{200:{description:'Preferências'}}},put:{summary:'Atualizar lembrete',responses:{200:{description:'Preferências salvas'}}} },
  '/push/subscriptions': { post:{summary:'Cadastrar dispositivo para push',responses:{201:{description:'Dispositivo cadastrado'}}}
}} };

export async function handler(req, res) {
  const origin = req.headers.origin; const allowed = process.env.FRONTEND_URL;
  if (origin && allowed && origin.replace(/\/$/,'') === allowed.replace(/\/$/,'')) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials','true'); res.setHeader('Vary','Origin'); }
  try { await handle(req,res); }
  catch (error) {
    const status = error instanceof HttpError ? error.status : (error?.name === 'ZodError' ? 422 : error?.code === '23505' ? 409 : 500);
    if (status >= 500) console.error('Falha na API GlicoCare:', error?.code || error?.name || 'erro interno');
    const message = status === 500 ? 'Ocorreu uma falha interna. Tente novamente mais tarde.' : status === 409 ? 'Este registro já existe ou entrou em conflito com outro.' : error.message;
    if (!res.headersSent) send(res,status,{message}); else if (!res.writableEnded) res.end();
  }
}
export { dateMonthBounds, localToUtc, dateInTimezone, validateTimezone, eventJson, recordSchema };
export default handler;
