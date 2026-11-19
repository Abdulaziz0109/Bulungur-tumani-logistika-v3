import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isNineKindergartenMatch,
  isSixteenKindergartenMatch,
  resolveCadastreDetails,
} from './cadastreHelpers.ts';

test('isNineKindergartenMatch matches 9-DMTT/9-bogcha but rejects 19, 29, 39, 90', () => {
  assert.equal(isNineKindergartenMatch("9-sonli DMTT", "dmtt"), true);
  assert.equal(isNineKindergartenMatch("9-bog'cha", "bogcha"), true);
  assert.equal(isNineKindergartenMatch("To'qqizinchi bog'cha", "dmtt"), true);
  assert.equal(isNineKindergartenMatch("Noma'lum", "dmtt", "14:01:41:02:01:0086"), true);

  // Critical regression checks: must NOT match numbers containing '9' as a digit
  assert.equal(isNineKindergartenMatch("19-sonli DMTT", "dmtt"), false);
  assert.equal(isNineKindergartenMatch("29-bog'cha", "dmtt"), false);
  assert.equal(isNineKindergartenMatch("39-DMTT", "dmtt"), false);
  assert.equal(isNineKindergartenMatch("90-bog'cha", "dmtt"), false);
  assert.equal(isNineKindergartenMatch("9-maktab", "maktab"), false);
});

test('isSixteenKindergartenMatch matches 16-DMTT/16-bogcha but rejects 116 or 16-maktab', () => {
  assert.equal(isSixteenKindergartenMatch("16-DMTT", "dmtt"), true);
  assert.equal(isSixteenKindergartenMatch("16-sonli bog'cha", "bogcha"), true);
  assert.equal(isSixteenKindergartenMatch("O'n oltinchi bog'cha", "dmtt"), true);
  assert.equal(isSixteenKindergartenMatch("116-DMTT", "dmtt"), false);
  assert.equal(isSixteenKindergartenMatch("16-maktab", "maktab"), false);
});

test('resolveCadastreDetails returns verified presets for 9 & 16 DMTT and deterministic values for others', () => {
  const dmtt9 = resolveCadastreDetails({ name: "9-DMTT", type: "dmtt", lat: 39.76, lng: 67.27 });
  assert.equal(dmtt9.cadastreCode, "14:01:41:02:01:0086");
  assert.equal(dmtt9.totalLandArea, 6800);
  assert.equal(dmtt9.isVerifiedPreset, true);

  const dmtt19a = resolveCadastreDetails({ name: "19-DMTT", type: "dmtt", lat: 39.77, lng: 67.28 });
  const dmtt19b = resolveCadastreDetails({ name: "19-DMTT", type: "dmtt", lat: 39.77, lng: 67.28 });
  assert.notEqual(dmtt19a.cadastreCode, "14:01:41:02:01:0086");
  assert.equal(dmtt19a.cadastreCode, dmtt19b.cadastreCode);
  assert.equal(dmtt19a.isVerifiedPreset, false);

  const namelessA = resolveCadastreDetails({ name: "Yangi maktab", type: "maktab", lat: 39.75, lng: 67.26 });
  const namelessB = resolveCadastreDetails({ name: "Yangi maktab", type: "maktab", lat: 39.75, lng: 67.26 });
  assert.equal(namelessA.cadastreCode, namelessB.cadastreCode);
});
