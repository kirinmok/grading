/* 同步與完整備份的測試。跑法：node tests/sync.test.mjs
   手機端：抽出 v2/index.html 裡 <backup-helpers> 區塊的純函式來測。
   雲端端：把 Apps Script 原始檔放進假的試算表環境跑 doPost / doGet。
   假試算表故意模擬真試算表最會出事的三件事：一格超過 5 萬字就丟錯、
   長得像日期的字串變成 Date、長得像數字的字串變成數字。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'v2', 'index.html');
const GS = process.env.GRADING_GS || path.join(os.homedir(), 'grading_rosters', 'Apps Script_同步端點.gs');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

/* ---------- 手機端純函式 ---------- */
const html = fs.readFileSync(APP, 'utf8');
const m = html.match(/\/\*<backup-helpers>[\s\S]*?\*\/([\s\S]*?)\/\*<\/backup-helpers>\*\//);
assert.ok(m, '找不到 <backup-helpers> 區塊');
const H = new Function(m[1] + '\nreturn {SNAP_CHUNK,DAY,hashStr,splitSnap,mergeRestore,syncAlert,sameRecord};')();

console.log('手機端');
test('分段後接回來一字不差，且每段不超過上限', () => {
  const s = '學生🚁資料'.repeat(30000);
  const parts = H.splitSnap(s, H.SNAP_CHUNK);
  assert.equal(parts.join(''), s);
  assert.ok(parts.length > 1);
  parts.forEach(p => assert.ok(p.length <= H.SNAP_CHUNK && p.length > 0));
});
test('不會把 emoji 切成兩半', () => {
  for (let size = 2; size <= 9; size++) {
    const s = 'a🚁b🤖c🚗'.repeat(50);
    const parts = H.splitSnap(s, size);
    assert.equal(parts.join(''), s);
    parts.forEach(p => {
      const c = p.charCodeAt(p.length - 1);
      assert.ok(!(c >= 0xD800 && c <= 0xDBFF), `size ${size} 的段尾是半個 emoji`);
    });
  }
});
test('空字串與剛好整除', () => {
  assert.deepEqual(H.splitSnap('', 10), []);
  assert.deepEqual(H.splitSnap('abcdef', 3), ['abc', 'def']);
});
test('檢查碼：同內容同碼，差一字不同碼', () => {
  assert.equal(H.hashStr('abc'), H.hashStr('abc'));
  assert.notEqual(H.hashStr('abc'), H.hashStr('abd'));
});
test('還原保留手機現在的同步網址，不被備份裡的舊網址蓋掉', () => {
  const cur = { records: [{ t: 2, no: 1, name: '發言' }], sync: { url: 'NEW', lastAt: 9 } };
  const old = { courses: [], records: [{ t: 1, no: 1, name: '發言' }], sync: { url: 'OLD', lastAt: 1, backupAt: 5 } };
  const r = H.mergeRestore(cur, old, { courses: [], records: [], size: 20 });
  assert.equal(r.merged.sync.url, 'NEW');
  assert.equal(r.merged.sync.lastAt, 9);
  assert.equal(r.merged.sync.backupAt, 5);
  assert.equal(r.merged.records.length, 2);
  assert.deepEqual([r.restored, r.extra], [1, 1]);
});
test('網址跟備份當時不同：還原回來的記錄全部當成沒傳過，會重送', () => {
  const cur = { records: [], sync: { url: 'NEW' } };
  const old = { courses: [], records: [{ t: 1, cls: '801', no: 1, name: '發言', sy: 1 }], sync: { url: 'OLD' } };
  assert.equal(H.mergeRestore(cur, old, { courses: [] }).merged.records[0].sy, undefined);
});
test('網址跟備份當時相同：已同步的記號保留，不重送', () => {
  const cur = { records: [], sync: { url: 'SAME' } };
  const old = { courses: [], records: [{ t: 1, cls: '801', no: 1, name: '發言', sy: 1 }], sync: { url: 'SAME' } };
  assert.equal(H.mergeRestore(cur, old, { courses: [] }).merged.records[0].sy, 1);
});
test('不同班同座號同時間的記錄不會被當成同一筆', () => {
  const a = { t: 1, cls: '801', no: 3, name: '協作' }, b = { t: 1, cls: '802', no: 3, name: '協作' };
  assert.equal(H.mergeRestore({ records: [a] }, { courses: [], records: [b] }, { courses: [] }).merged.records.length, 2);
});
test('手機沒設網址時，沿用備份裡的同步設定', () => {
  const r = H.mergeRestore({ records: [] }, { courses: [], records: [], sync: { url: 'OLD' } }, { courses: [] });
  assert.equal(r.merged.sync.url, 'OLD');
});
test('還原時重複的記錄不會變兩筆', () => {
  const rec = { t: 1, no: 3, name: '協作' };
  const r = H.mergeRestore({ records: [rec] }, { courses: [], records: [{ ...rec }] }, { courses: [] });
  assert.equal(r.merged.records.length, 1);
});
test('備份內容不完整就丟錯，不回傳半套資料', () => {
  assert.throws(() => H.mergeRestore({ records: [] }, { records: [] }, { courses: [] }), /不完整/);
  assert.throws(() => H.mergeRestore({ records: [] }, null, { courses: [] }), /不完整/);
});
test('刪一筆加分：別班同時間同座號同項目的那筆不會被當成同一筆', () => {
  const a = { t: 1, course: 'c2', cls: '901', no: 5, item: 'i1' };
  assert.equal(H.sameRecord(a, { ...a }), true);
  assert.equal(H.sameRecord(a, { ...a, cls: '902' }), false);
  assert.equal(H.sameRecord(a, { ...a, course: 'c3' }), false);
  const kept = [a, { ...a, cls: '902' }].filter(r => !H.sameRecord(r, a));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].cls, '902');
});
const NOW = 1_800_000_000_000;
test('警示：沒有記錄就不吵', () => {
  assert.equal(H.syncAlert({ records: [] }, NOW), null);
});
test('警示：有記錄但沒設網址', () => {
  assert.equal(H.syncAlert({ records: [{ t: NOW }] }, NOW).level, 'amber');
});
test('警示：未同步超過一天亮紅燈並報筆數', () => {
  const d = { sync: { url: 'u', backupAt: NOW }, records: [{ t: NOW - 2 * H.DAY }, { t: NOW - 3 * H.DAY }, { t: NOW, sy: 1 }, { t: NOW - 1000 }] };
  const a = H.syncAlert(d, NOW);
  assert.equal(a.level, 'red');
  assert.match(a.msg, /2 筆/);
});
test('警示：剛打的分還沒傳（一天內）不吵', () => {
  const d = { sync: { url: 'u', backupAt: NOW }, records: [{ t: NOW - 1000 }] };
  assert.equal(H.syncAlert(d, NOW), null);
});
test('警示：完整備份超過七天或從未成功', () => {
  const base = { records: [{ t: NOW - 5 * H.DAY, sy: 1 }] };
  assert.match(H.syncAlert({ ...base, sync: { url: 'u', backupAt: NOW - 8 * H.DAY } }, NOW).msg, /8 天/);
  assert.match(H.syncAlert({ ...base, sync: { url: 'u' } }, NOW).msg, /從來沒成功/);
  assert.equal(H.syncAlert({ ...base, sync: { url: 'u', backupAt: NOW - 6 * H.DAY } }, NOW), null);
});

/* ---------- 雲端端 ---------- */
const SHEET_CELL_LIMIT = 50000;
function coerce(v) {
  if (typeof v !== 'string') return v;
  if (v.length > SHEET_CELL_LIMIT) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) return new Date(v);
  if (v !== '' && !isNaN(Number(v))) return Number(v);
  return v;
}
function makeSheet(opt = {}) {
  const data = [];
  const sh = {
    data,
    getLastRow: () => data.length,
    appendRow: row => { data.push(row.map(coerce)); },
    setFrozenRows: () => {},
    deleteRows: (start, n) => { data.splice(start - 1, n); },
    deleteRow: r => { data.splice(r - 1, 1); },
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => Array.from({ length: nr }, (_, i) =>
        Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setValues: vals => {
        const staged = vals.map(row => row.map(coerce)).map(row => opt.corrupt ? opt.corrupt(row) : row);
        staged.forEach((row, i) => {
          const y = r - 1 + i;
          while (data.length <= y) data.push([]);
          row.forEach((v, j) => { data[y][c - 1 + j] = v; });
        });
      },
      clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r - 1 + i]) data[r - 1 + i][c - 1 + j] = ''; },
    }),
  };
  return sh;
}
function makeCloud(opt = {}) {
  const sheets = {};
  const ctx = {
    SpreadsheetApp: { flush() { if (opt.flushFails && opt.flushFails()) throw new Error('Service error: Spreadsheets'); }, getActiveSpreadsheet: () => ({
      getSheetByName: n => sheets[n] || null,
      insertSheet: n => (sheets[n] = makeSheet(opt)),
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' },
      createTextOutput: s => ({ setMimeType() { return this; }, text: s }) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(GS, 'utf8'), ctx);
  return {
    sheets, ctx,
    post: body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text),
    get: parameter => JSON.parse(ctx.doGet({ parameter }).text),
  };
}
function bigSnapshot(n) {
  const records = Array.from({ length: n }, (_, i) =>
    ({ t: 1757000000000 + i * 1000, course: 'c1', cls: '804', no: (i % 20) + 1, name: '實作進度', tag: 'work', v: 1, sy: 1 }));
  return JSON.stringify({ courses: [{ id: 'c1', name: '水陸兩用車', icon: '🚗' }], records, sync: { url: 'X' } });
}
function backupBody(snap, at) {
  return { backup: { at, version: '1.16', device: 'test', students: 177, records: 1,
    parts: H.splitSnap(snap, H.SNAP_CHUNK), len: snap.length, hash: H.hashStr(snap) } };
}

console.log('雲端端');
test('八千筆的備份：寫得進去、清單看得到、取回來一字不差', () => {
  const c = makeCloud(), snap = bigSnapshot(8200), at = '2026-11-10T05:00:00.000Z';
  assert.ok(snap.length > 500000, '測試資料要夠大');
  const out = c.post(backupBody(snap, at));
  assert.equal(out.ok, true, out.error);
  assert.equal(out.parts, H.splitSnap(snap, H.SNAP_CHUNK).length);
  const list = c.get({ what: 'backups' });
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0][5], '', '清單不該夾帶內容');
  assert.equal(list.rows[0][6], list.rows[0][7], '段數要齊');
  const got = c.get({ what: 'backup', at: list.rows[0][0] });
  assert.equal(got.ok, true, got.error);
  assert.equal(got.snapshot, snap);
  assert.equal(got.len, snap.length);
  assert.equal(got.hash, H.hashStr(snap));
});
test('App 宣告的檢查碼或長度跟內容對不上：拒絕，而且一列都不寫', () => {
  const c = makeCloud(), body = backupBody(bigSnapshot(2000), '2026-11-10T05:00:00.000Z');
  body.backup.hash = 'zzz';
  const out = c.post(body);
  assert.equal(out.ok, false);
  assert.match(out.error, /檢查碼/);
  body.backup.hash = H.hashStr(body.backup.parts.join('')); body.backup.len += 1;
  assert.match(c.post(body).error, /長度/);
  assert.equal(c.get({ what: 'backups' }).rows.length, 0);
});
test('寫進試算表後讀回來對不上：撤掉這次寫入，舊備份原封不動', () => {
  let bad = false;
  const c = makeCloud({ corrupt: row => (bad && typeof row[5] === 'string' ? row.map((v, i) => (i === 5 ? v.slice(0, -1) + '?' : v)) : row) });
  const good = bigSnapshot(900);
  assert.equal(c.post(backupBody(good, '2026-11-09T05:00:00.000Z')).ok, true);
  bad = true;
  const out = c.post(backupBody(bigSnapshot(950), '2026-11-10T05:00:00.000Z'));
  assert.equal(out.ok, false);
  assert.match(out.error, /驗證失敗/);
  bad = false;
  const rows = c.get({ what: 'backups' }).rows;
  assert.equal(rows.length, 1);
  assert.equal(c.get({ what: 'backup', at: '2026-11-09T05:00:00.000Z' }).snapshot, good);
});
test('同一份備份重送：內容相同當成功且不重複寫，內容不同就拒絕', () => {
  const c = makeCloud(), at = '2026-11-10T05:00:00.000Z', snap = bigSnapshot(900);
  assert.equal(c.post(backupBody(snap, at)).ok, true);
  const n = c.sheets['BackupV2'].data.length;
  assert.equal(c.post(backupBody(snap, at)).ok, true);
  assert.equal(c.sheets['BackupV2'].data.length, n);
  const other = c.post(backupBody(bigSnapshot(901), at));
  assert.equal(other.ok, false);
  assert.equal(c.get({ what: 'backup', at }).snapshot, snap);
});
test('只留最近 7 份，舊的整份刪掉，新的完整', () => {
  const c = makeCloud(), snap = bigSnapshot(900);
  for (let d = 1; d <= 9; d++) assert.equal(c.post(backupBody(snap, `2026-11-0${d}T05:00:00.000Z`)).ok, true);
  const rows = c.get({ what: 'backups' }).rows;
  assert.equal(rows.length, 7);
  assert.equal(rows[0][0], '2026-11-03T05:00:00.000Z');
  rows.forEach(r => assert.equal(r[6], r[7]));
  assert.equal(c.get({ what: 'backup', at: '2026-11-09T05:00:00.000Z' }).snapshot, snap);
  assert.equal(c.get({ what: 'backup', at: '2026-11-01T05:00:00.000Z' }).ok, false);
});
test('舊的 Backup 分頁不讀也不動（舊部署誤寫也裁不到新格式）', () => {
  const c = makeCloud();
  const legacy = c.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('Backup');
  legacy.appendRow(['at', 'version', 'device', 'students', 'records', 'snapshot']);
  legacy.appendRow(['2026-09-09T03:19:35.986Z', '1.11', 'old', 177, 491, '{}']);
  assert.equal(c.get({ what: 'backups' }).rows.length, 0);
  for (let d = 1; d <= 9; d++) c.post(backupBody(bigSnapshot(900), `2026-11-0${d}T05:00:00.000Z`));
  assert.equal(legacy.data.length, 2);
});
test('缺了一段就報錯，不回殘缺內容', () => {
  const c = makeCloud(), snap = bigSnapshot(2000), at = '2026-11-10T05:00:00.000Z';
  c.post(backupBody(snap, at));
  c.sheets['BackupV2'].deleteRow(3);
  const list = c.get({ what: 'backups' }).rows[0];
  assert.notEqual(list[6], list[7]);
  const got = c.get({ what: 'backup', at });
  assert.equal(got.ok, false);
  assert.match(got.error, /不完整/);
  assert.equal(got.snapshot, undefined);
});
test('舊版 App 整包送來太大：明確拒絕，而且一列都不寫', () => {
  const c = makeCloud();
  const out = c.post({ backup: { at: '2026-11-10T05:00:00.000Z', version: '1.15', device: 'old', students: 1, records: 1, snapshot: bigSnapshot(2000) } });
  assert.equal(out.ok, false);
  assert.match(out.error, /更新 App/);
  assert.equal(c.get({ what: 'backups' }).rows.length, 0);
});
test('舊版 App 整包送來夠小：照收', () => {
  const c = makeCloud();
  assert.equal(c.post({ backup: { at: '2026-11-10T05:00:00.000Z', version: '1.15', device: 'old', students: 1, records: 1, snapshot: '{"courses":[]}' } }).ok, true);
  assert.equal(c.get({ what: 'backup', at: '2026-11-10T05:00:00.000Z' }).snapshot, '{"courses":[]}');
});
test('空的備份被拒絕', () => {
  const c = makeCloud();
  assert.equal(c.post({ backup: { at: '2026-11-10T05:00:00.000Z' } }).ok, false);
});
test('找不到的備份時間回報錯誤', () => {
  const c = makeCloud();
  c.post(backupBody('{"courses":[]}', '2026-11-10T05:00:00.000Z'));
  assert.equal(c.get({ what: 'backup', at: '2020-01-01T00:00:00.000Z' }).ok, false);
  assert.equal(c.get({ what: 'backup' }).ok, false);
});
test('加分記錄重送不會重複（原有行為沒被動到）', () => {
  const c = makeCloud();
  const rows = [['2026-11-10T01:00:00.000Z', '無人機', '901', 5, '', '', '發言', '平常成績', 1, '', 1757000000001]];
  assert.equal(c.post({ rows }).added, 1);
  const again = c.post({ rows });
  assert.deepEqual([again.added, again.skipped], [0, 1]);
  assert.equal(c.get({}).rows, 1);
});
test('刪舊備份的列數計算；排列被動過就一列都不刪', () => {
  const p = ids => makeCloud().ctx.pruneCount_(ids, 2);
  assert.equal(p(['Ja', 'Ja', 'Jb', 'Jc', 'Jc']), 2);
  assert.equal(p(['Ja', 'Jb']), 0);
  assert.equal(p(['Jc', 'Jb', 'Ja']), 0, '被排成新的在上：不可刪到最新那份');
  assert.equal(p(['Ja', 'Jb', 'Ja', 'Jc']), 0, '同一份被拆開：不刪');
});
test('試算表被排成新的在上之後再備份：舊的一份都不會被刪', () => {
  const c = makeCloud();
  for (let d = 1; d <= 7; d++) c.post(backupBody('{"courses":[],"d":' + d + '}', `2026-11-0${d}T05:00:00.000Z`));
  const sh = c.sheets['BackupV2'], head = sh.data.shift();
  sh.data.reverse(); sh.data.unshift(head);
  assert.equal(c.post(backupBody('{"courses":[],"d":8}', '2026-11-08T05:00:00.000Z')).pruned, 0);
  assert.equal(c.get({ what: 'backups' }).rows.length, 8);
});
test('版本號 1.10 不會被試算表變成 1.1', () => {
  const c = makeCloud(), body = backupBody('{"courses":[]}', '2026-11-10T05:00:00.000Z');
  body.backup.version = '1.10';
  c.post(body);
  assert.equal(c.get({ what: 'backups' }).rows[0][1], '1.10');
});

test('雲端寫入送不出去（flush 失敗）：一定回失敗，手機才會重送', () => {
  let fail = false;
  const c = makeCloud({ flushFails: () => fail });
  const rows = [['2026-11-10T01:00:00.000Z', '無人機', '901', 5, '', '', '發言', '平常成績', 1, '', 1757000000001]];
  fail = true;
  const out = c.post({ rows });
  assert.equal(out.ok, false);
  assert.match(out.error, /Service error/);
});
test('備份寫入後驗證時直接丟例外：也會撤掉剛寫的列', () => {
  let n = 0, armed = false;
  const c = makeCloud({ flushFails: () => armed && ++n === 1 });
  assert.equal(c.post(backupBody(bigSnapshot(900), '2026-11-09T05:00:00.000Z')).ok, true);
  const before = c.sheets['BackupV2'].data.length;
  armed = true;
  const out = c.post(backupBody(bigSnapshot(950), '2026-11-10T05:00:00.000Z'));
  armed = false;
  assert.equal(out.ok, false);
  assert.match(out.error, /驗證失敗/);
  assert.equal(c.sheets['BackupV2'].data.length, before);
});
test('同一時間的備份，檢查碼相同但內容不同：仍然拒絕', () => {
  const a = '{"courses":[],"note":"Aa"}', b = '{"courses":[],"note":"B@"}';
  assert.equal(H.hashStr(a), H.hashStr(b), '這組要真的撞碼才測得到');
  const c = makeCloud(), at = '2026-11-10T05:00:00.000Z';
  assert.equal(c.post(backupBody(a, at)).ok, true);
  assert.equal(c.post(backupBody(b, at)).ok, false);
  assert.equal(c.get({ what: 'backup', at }).snapshot, a);
});
test('不同班、同時間同座號同項目的加分：兩筆都要收', () => {
  const c = makeCloud();
  const r = cls => ['2026-11-10T01:00:00.000Z', '無人機', cls, 5, '', '', '發言', '平常成績', 1, '', 1757000000001];
  assert.equal(c.post({ rows: [r('901'), r('902')] }).added, 2);
});
test('還原試算不會動到手機現有的記錄', () => {
  const mine = { t: 5, cls: '801', no: 1, name: '發言', sy: 1 };
  H.mergeRestore({ records: [mine], sync: { url: 'NEW' } }, { courses: [], records: [], sync: { url: 'OLD' } }, { courses: [] });
  assert.equal(mine.sy, 1);
});

test('刪除帶班級：只刪那一班的，別班同鍵的留著；舊版 App 不帶班級照舊', () => {
  const r = cls => ['2026-11-10T01:00:00.000Z', '無人機', cls, 5, '', '', '發言', '平常成績', 1, '', 1757000000001];
  const c = makeCloud();
  c.post({ rows: [r('901'), r('902')] });
  assert.equal(c.post({ del: [[1757000000001, 5, '發言', '902']] }).deleted, 1);
  assert.equal(c.get({}).rows, 1);
  assert.equal(c.sheets['加分記錄'].data[1][2], 901);
  assert.equal(c.post({ del: [[1757000000001, 5, '發言']] }).deleted, 1);
  assert.equal(c.get({}).rows, 0);
});

console.log(process.exitCode ? '\n有測試沒過' : `\n全部通過（${passed} 項）`);
