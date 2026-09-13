'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-'.repeat(4);

const { renderToBuffer, extractText } = require('./helpers/pdf');
const { streamVoterCard, verificationCode } = require('../utils/voterCardPdf');

const VOTER = {
  slNo: 1,
  name: 'Arnab Baruah',
  voterId: 'ASM1234567',
  state: 'Assam',
  district: 'Kamrup Metropolitan',
  dob: '1994-03-17',
};

const card = (voter = VOTER) => renderToBuffer((sink) => streamVoterCard(voter, sink));

test('voter card PDF', async (t) => {
  const pdf = await card();
  const text = extractText(pdf);

  await t.test('is a well-formed PDF file', () => {
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(pdf.toString('latin1'), /%%EOF\s*$/);
    assert.ok(pdf.length > 2000, `expected a non-trivial file, got ${pdf.length} bytes`);
  });

  await t.test('is a single A4 page', () => {
    const latin = pdf.toString('latin1');
    assert.match(latin, /\/MediaBox \[0 0 595\.28 841\.89\]/);
    assert.equal((latin.match(/\/Type \/Page[^s]/g) || []).length, 1);
  });

  await t.test('prints every roll field on the card', () => {
    assert.match(text, /Arnab Baruah/);
    assert.match(text, /ASM1234567/);
    assert.match(text, /Assam/);
    assert.match(text, /Kamrup Metropolitan/);
  });

  await t.test('prints the date of birth as DD-MM-YYYY, not ISO', () => {
    assert.match(text, /17-03-1994/);
    assert.doesNotMatch(text, /1994-03-17/);
  });

  await t.test('draws both faces of the card with their headings', () => {
    assert.match(text, /ELECTORAL PHOTO IDENTITY CARD/);
    assert.match(text, /PHOTOGRAPH/);
    assert.match(text, /Conditions of use/);
    assert.match(text, /Carry this card to the polling station/);
    assert.match(text, /Altering any printed detail invalidates the card/);
  });

  await t.test('carries the same verification code on front, back and footer', () => {
    const code = verificationCode(VOTER);
    const seen = text.split(code).length - 1;
    assert.equal(seen, 3, `expected the code ${code} three times, saw it ${seen} time(s)`);
  });
});

test('verification code', async (t) => {
  await t.test('is formatted as three dash-separated groups of four', () => {
    assert.match(verificationCode(VOTER), /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  await t.test('is stable for the same voter', () => {
    assert.equal(verificationCode(VOTER), verificationCode({ ...VOTER }));
  });

  await t.test('ignores fields that are not printed as identity', () => {
    assert.equal(
      verificationCode(VOTER),
      verificationCode({ ...VOTER, state: 'Kerala', district: 'Kochi', slNo: 99 })
    );
  });

  await t.test('changes when the name, ID or date of birth changes', () => {
    const base = verificationCode(VOTER);
    assert.notEqual(base, verificationCode({ ...VOTER, name: 'Arnab Baruaha' }));
    assert.notEqual(base, verificationCode({ ...VOTER, voterId: 'ASM1234568' }));
    assert.notEqual(base, verificationCode({ ...VOTER, dob: '1994-03-18' }));
  });

  await t.test('is keyed to JWT_SECRET, so a forged card cannot be verified', () => {
    const original = process.env.JWT_SECRET;
    const mine = verificationCode(VOTER);
    try {
      process.env.JWT_SECRET = 'a-different-server-secret-entirely';
      assert.notEqual(mine, verificationCode(VOTER));
    } finally {
      process.env.JWT_SECRET = original;
    }
  });
});

test('voter card edge cases', async (t) => {
  await t.test('renders a placeholder when state or district is blank', async () => {
    const text = extractText(await card({ ...VOTER, state: '', district: '' }));
    assert.match(text, /Arnab Baruah/);
    assert.match(text, /-/);
  });

  await t.test('does not overflow the card with a very long name', async () => {
    const long = 'Bhaskarjyoti Chandrakanta Deka Borthakur Barua Hazarika';
    const pdf = await card({ ...VOTER, name: long });
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length, 1);
  });

  await t.test('survives parentheses and backslashes in the name', async () => {
    const pdf = await card({ ...VOTER, name: 'A (Bobby) \\ Das' });
    const text = extractText(pdf);
    assert.match(pdf.toString('latin1'), /%%EOF\s*$/);
    assert.match(text, /Bobby/);
  });

  await t.test('renders a non-ISO date of birth as given rather than dropping it', async () => {
    const text = extractText(await card({ ...VOTER, dob: '17/03/1994' }));
    assert.match(text, /17\/03\/1994/);
  });
});
