const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const read = name => fs.readFileSync(path.join(root,name),'utf8');

test('review memusatkan mutasi sesi ke background', () => {
  const source=read('review.js');
  for(const action of ['DELETE_STEP','CLEAR_STEPS','UNDO_DELETE','REORDER_STEPS','RENAME_TC']) assert.match(source,new RegExp(`callBg\\('${action}'`));
  assert.doesNotMatch(source,/QA_DB\.deleteStep\(/);
});

test('content script membawa korelasi interaction dan relay iframe', () => {
  const source=read('content.js');
  assert.match(source,/interactionId/);
  assert.match(source,/FRAME_CHANNEL/);
  assert.match(source,/phase:\s*'result'/);
  assert.match(source,/if \(!action && !mergedFieldAfter\) immediateClickCheckpoint/);
});

test('capture dan mutasi review memakai antrean TC yang sama',()=>{
  const source=read('background.js');
  assert.match(source,/enqueueTc\(session\.tc,\(\)=>saveCheckpoint/);
  for(const action of ['DELETE_STEP','CLEAR_STEPS','REORDER_STEPS','RENAME_TC']) assert.match(source,new RegExp(`msg\\.type==='${action}'`));
  assert.match(source,/return await enqueueTc\(msg\.tc/);
});

test('database v2 memisahkan gambar, trash, dan diagnostics',()=>{
  const source=read('db.js');
  assert.match(source,/dbVersion:\s*2/);
  for(const store of ['stepImages','trash','diagnostics']) assert.match(source,new RegExp(store));
});

test('manifest memuat core sebelum content recorder', () => {
  const manifest=JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.content_scripts[0].js.slice(0,2),['qa-core.js','content.js']);
});
