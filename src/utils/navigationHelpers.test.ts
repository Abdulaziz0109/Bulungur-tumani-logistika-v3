import test from 'node:test';
import assert from 'node:assert/strict';
import {
  smartSearchLocations,
  parseMultiQueryLocations,
  buildYandexMapsUrl,
  buildGoogleMapsUrl,
  sortLocationsNearestFirst,
} from './navigationHelpers.ts';
import type { Location } from '../types.ts';

const SAMPLE_LOCATIONS: Location[] = [
  { id: 's4', name: '4-maktab', type: 'maktab', lat: 39.761, lng: 67.271, mahalla: 'Mehrjon MFY', cadastre: '14:01:41:05:05:0132' },
  { id: 's15', name: '15-maktab', type: 'maktab', lat: 39.772, lng: 67.285, mahalla: 'Sohibkor MFY', cadastre: '14:01:41:01:08:0264' },
  { id: 'k9', name: '9-DMTT', type: 'dmtt', lat: 39.764, lng: 67.275, mahalla: 'Mehrjon MFY', cadastre: '14:01:41:02:01:0086' },
  { id: 'k19', name: '19-DMTT', type: 'dmtt', lat: 39.780, lng: 67.290, mahalla: 'Guldasta MFY', cadastre: '14:01:41:05:04:0312' },
];

test('smartSearchLocations supports Russian/English aliases (sadik, yasli, shkola, school) and Cyrillic', () => {
  const sadik = smartSearchLocations(SAMPLE_LOCATIONS, '9 sadik');
  assert.equal(sadik[0]?.id, 'k9');

  const yasli = smartSearchLocations(SAMPLE_LOCATIONS, '9 yasli');
  assert.equal(yasli[0]?.id, 'k9');

  const shkola = smartSearchLocations(SAMPLE_LOCATIONS, '4 shkola');
  assert.equal(shkola[0]?.id, 's4');

  const cyrillic = smartSearchLocations(SAMPLE_LOCATIONS, '9 боғча');
  assert.equal(cyrillic[0]?.id, 'k9');
});

test('smartSearchLocations avoids matching short numbers only inside cadastre codes', () => {
  const res = smartSearchLocations(SAMPLE_LOCATIONS, '14');
  assert.equal(res.length, 0);

  const cadRes = smartSearchLocations(SAMPLE_LOCATIONS, '14:01:41:02:01:0086');
  assert.equal(cadRes[0]?.id, 'k9');
});

test('parseMultiQueryLocations handles commas, va, trailing type hints, and Uzbek -dan/-gacha', () => {
  const commaRes = parseMultiQueryLocations(SAMPLE_LOCATIONS, "4 maktab, 9 bog'cha");
  assert.deepEqual(commaRes.map(l => l.id), ['s4', 'k9']);

  const suffixRes = parseMultiQueryLocations(SAMPLE_LOCATIONS, "4-maktabdan 9-bog'chagacha");
  assert.deepEqual(suffixRes.map(l => l.id), ['s4', 'k9']);

  const hintRes = parseMultiQueryLocations(SAMPLE_LOCATIONS, "9, 19 bog'cha");
  assert.deepEqual(hintRes.map(l => l.id), ['k9', 'k19']);
});

test('buildYandexMapsUrl and buildGoogleMapsUrl format single and multi-stop routes cleanly', () => {
  const yandexSingleNoOrigin = buildYandexMapsUrl([SAMPLE_LOCATIONS[0]], null, false);
  assert.equal(yandexSingleNoOrigin, 'https://yandex.uz/maps/?rtext=~39.761,67.271&rtt=auto');

  const yandexWithGps = buildYandexMapsUrl([SAMPLE_LOCATIONS[0], SAMPLE_LOCATIONS[2]], [39.75, 67.26], true);
  assert.equal(
    yandexWithGps,
    'https://yandex.uz/maps/?rtext=39.75,67.26~39.761,67.271~39.764,67.275&rtt=auto'
  );

  const googleTwo = buildGoogleMapsUrl([SAMPLE_LOCATIONS[0], SAMPLE_LOCATIONS[2]], null, false);
  assert.ok(googleTwo.includes('origin=39.761,67.271'));
  assert.ok(googleTwo.includes('destination=39.764,67.275'));
});

test('sortLocationsNearestFirst orders stops greedily from origin', () => {
  const sorted = sortLocationsNearestFirst([SAMPLE_LOCATIONS[3], SAMPLE_LOCATIONS[0], SAMPLE_LOCATIONS[2]], 39.760, 67.270);
  assert.deepEqual(sorted.map(l => l.id), ['s4', 'k9', 'k19']);
});
