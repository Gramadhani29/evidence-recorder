const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../qa-core.js');

test('image fingerprint stabil untuk gambar sama dan berubah untuk gambar berbeda', () => {
  assert.equal(core.imageFingerprint('data:image/png;base64,AAAA'), core.imageFingerprint('data:image/png;base64,AAAA'));
  assert.notEqual(core.imageFingerprint('data:image/png;base64,AAAA'), core.imageFingerprint('data:image/png;base64,AAAB'));
});

test('dedupe checkpoint id dan interaction phase', () => {
  const previous={checkpointId:'cp-1',interactionId:'int-1',phase:'action',fingerprint:'x',at:1000};
  assert.equal(core.shouldSkipCapture(previous,{checkpointId:'cp-1'},1100).reason,'checkpoint-id');
  assert.equal(core.shouldSkipCapture(previous,{interactionId:'int-1',phase:'action'},1100).reason,'interaction-phase');
  assert.equal(core.shouldSkipCapture(previous,{interactionId:'int-1',phase:'result'},1100).skip,false);
});

test('gambar identik hanya didedupe dalam jendela waktu pendek', () => {
  const previous={fingerprint:'same',at:1000};
  assert.equal(core.shouldSkipCapture(previous,{fingerprint:'same'},3000).reason,'identical-image');
  assert.equal(core.shouldSkipCapture(previous,{fingerprint:'same'},4000).skip,false);
});

test('rect iframe diterjemahkan ke viewport induk', () => {
  const [rect]=core.translateRects([{x:5,y:7,w:20,h:30,viewportW:200,viewportH:100}],100,50,1280,720);
  assert.deepEqual(rect,{x:105,y:57,w:20,h:30,viewportW:1280,viewportH:720});
});

test('renumber menghasilkan urutan rapat tanpa memutasi input', () => {
  const input=[{id:'a',stepNumber:4},{id:'b',stepNumber:9}];
  assert.deepEqual(core.renumberSteps(input).map(s=>s.stepNumber),[1,2]);
  assert.deepEqual(input.map(s=>s.stepNumber),[4,9]);
});
