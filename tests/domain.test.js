import test from 'node:test';
import assert from 'node:assert/strict';
import { dateMonthBounds, localToUtc, dateInTimezone, validateTimezone, eventJson, recordSchema, handler, MAX_SHARING_MEMBERS, hasSharingCapacity } from '../api/[...path].js';

test('mês local respeita número de dias e fronteira do fuso', () => {
  const range = dateMonthBounds('2024-02', 'America/Sao_Paulo');
  assert.equal(range.days, 29);
  assert.equal(range.start.toISOString(), '2024-02-01T03:00:00.000Z');
  assert.equal(range.end.toISOString(), '2024-03-01T03:00:00.000Z');
});
test('conversão mantém o dia local no horário de verão', () => {
  const instant = localToUtc(2024, 11, 3, 1, 30, 'America/New_York');
  assert.equal(dateInTimezone(instant, 'America/New_York'), '2024-11-03');
});
test('fuso inválido é rejeitado', () => { assert.throws(() => validateTimezone('Brasil/Sao_Paulo')); });
test('registros mantêm ausências como null e pendências sem dose', () => {
  const value = eventJson({ glucoseMgDl: null, insulinUnits: null, insulinStatus: 'pending', sweetConsumed: false });
  assert.equal(value.glucoseMgDl, null); assert.equal(value.insulinUnits, null); assert.equal(value.insulinStatus, 'pending');
  const parsed = recordSchema.parse({ occurredAt: '2024-02-01T12:00:00.000Z', insulinStatus: 'pending' }); assert.equal(parsed.insulinStatus, 'pending');
});
test('health e OpenAPI podem ser consultados sem sessão', async () => {
  const response = () => ({ statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = value; this.writableEnded = true; } });
  const request = (url) => ({ method: 'GET', url, headers: {}, socket: {}, async *[Symbol.asyncIterator]() {} });
  const health = response(); await handler(request('/api/health'), health);
  assert.equal(health.statusCode, 200); assert.equal(JSON.parse(health.body).status, 'ok');
  const docs = response(); await handler(request('/api/openapi.json'), docs);
  assert.equal(docs.statusCode, 200); assert.equal(JSON.parse(docs.body).openapi, '3.1.0');
});
test('rotas de saúde negam acesso sem sessão antes de consultar o banco', async () => {
  const response = () => ({ statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = value; this.writableEnded = true; } });
  const req = { method: 'GET', url: '/api/patients/current', headers: {}, socket: {}, async *[Symbol.asyncIterator]() {} };
  const res = response(); await handler(req, res);
  assert.equal(res.statusCode, 401); assert.match(JSON.parse(res.body).message, /Entre na sua conta/);
});
test('compartilhamento permite responsável e duas cuidadoras, reservando vagas para convites pendentes', () => {
  assert.equal(MAX_SHARING_MEMBERS, 3);
  assert.equal(hasSharingCapacity(1), true);
  assert.equal(hasSharingCapacity(2), true);
  assert.equal(hasSharingCapacity(3), false);
  assert.equal(hasSharingCapacity(1, 1), true);
  assert.equal(hasSharingCapacity(1, 2), false);
  assert.equal(hasSharingCapacity(2, 1), false);
});
