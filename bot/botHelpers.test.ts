import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BotLocation,
  stripUzbekSuffix,
  searchSingleQuery,
  extractMultipleLocations,
  isDistanceIntent,
  sanitizeCallbackData,
  buildYandexNavUrl,
} from './botHelpers.ts';

const BOT_LOCATIONS: BotLocation[] = [
  { id: 'loc_m4', name: '4-maktab', type: 'maktab', lat: 39.761, lng: 67.271, mahalla: 'Mehrjon MFY' },
  { id: 'loc_k9', name: '9-DMTT', type: 'dmtt', lat: 39.764, lng: 67.275, mahalla: 'Mehrjon MFY', cadastre: '14:01:41:02:01:0086' },
  { id: 'loc_k19', name: '19-DMTT', type: 'dmtt', lat: 39.780, lng: 67.290, mahalla: 'Guldasta MFY' },
];

test('stripUzbekSuffix preserves kindergarten/school aliases like yasli', () => {
  assert.equal(stripUzbekSuffix('yasli'), 'yasli');
  assert.equal(stripUzbekSuffix('maktabdan'), 'maktab');
  assert.equal(stripUzbekSuffix('bogchagacha'), 'bogcha');
  assert.equal(stripUzbekSuffix('9'), '9');
});

test('extractMultipleLocations splits comma-separated, va, and -dan/-gacha queries', () => {
  const comma = extractMultipleLocations("4-maktab, 9-bog'cha", BOT_LOCATIONS);
  assert.deepEqual(comma.map(l => l.id), ['loc_m4', 'loc_k9']);

  const uzbek = extractMultipleLocations("4-maktabdan 9-bog'chagacha masofa qancha?", BOT_LOCATIONS);
  assert.deepEqual(uzbek.map(l => l.id), ['loc_m4', 'loc_k9']);

  const withHint = extractMultipleLocations("9, 19 bog'cha", BOT_LOCATIONS);
  assert.deepEqual(withHint.map(l => l.id), ['loc_k9', 'loc_k19']);
});

test('searchSingleQuery finds locations by yasli alias and cadastre code', () => {
  const byYasli = searchSingleQuery(BOT_LOCATIONS, '9 yasli');
  assert.equal(byYasli[0]?.id, 'loc_k9');

  const byCadastre = searchSingleQuery(BOT_LOCATIONS, '14:01:41:02:01:0086');
  assert.equal(byCadastre[0]?.id, 'loc_k9');
});

test('isDistanceIntent detects distance questions and sanitizeCallbackData enforces 64-byte Telegram limit', () => {
  assert.equal(isDistanceIntent("4-maktab bilan 9-bog'cha orasidagi masofa qancha?"), true);
  assert.equal(isDistanceIntent("9 bog'cha"), false);

  const longId = 'a'.repeat(100);
  const cb = sanitizeCallbackData('pick_loc_', longId);
  assert.ok(Buffer.byteLength(cb, 'utf8') <= 64);
  assert.ok(cb.startsWith('pick_loc_'));

  assert.equal(buildYandexNavUrl([BOT_LOCATIONS[0]]), 'https://yandex.uz/maps/?rtext=~39.761,67.271&rtt=auto');
});
