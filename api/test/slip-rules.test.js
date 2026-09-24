/**
 * อ่านสลิปและกฎตรวจ 4 ข้อ (§14)
 *
 * ข้อความตัวอย่างจำลองรูปแบบสลิปของแต่ละธนาคารตามที่ OCR อ่านออกมาจริง
 * (บรรทัดแตก จุดหาย ตัว O แทนเลข 0) — ไม่ใช่ข้อความที่สะอาดสวยงาม
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { CFSlipRules } = require(path.resolve(__dirname, '..', '..', 'shared', 'cf-slip-rules.js'));

const NOW = new Date('2026-09-24T07:33:00Z');   // 14:33 เวลาไทย

test('KBANK: ปี พ.ศ. 2 หลัก ยอดอยู่บรรทัดถัดจาก "จำนวน" ข้ามค่าธรรมเนียม', () => {
    const p = CFSlipRules.parse(`โอนเงินสำเร็จ
24 ก.ย. 69 14:32 น.
นาย ลูกค้า ท.
ธ.กสิกรไทย
xxx-x-x1234-x
เลขที่รายการ:
016267143218ATF09876
จำนวน:
70.00 บาท
ค่าธรรมเนียม:
0.00 บาท`, null, NOW);
    assert.strictEqual(p.amount, 70);
    assert.strictEqual(p.txAt, '2026-09-24T07:32:00.000Z');
    assert.strictEqual(p.ref, '016267143218ATF09876');
    assert.strictEqual(p.bank, 'KBANK');
    assert.strictEqual(p.source, 'TEXT');
});

test('SCB: ปี พ.ศ. 4 หลัก จุดในชื่อเดือนหาย และ OCR อ่าน 0 เป็น O', () => {
    const p = CFSlipRules.parse(`SCB
โอนเงินสำเร็จ
24 กย 2569 - 14:32
รหัสอ้างอิง: 2026O924143212345
จำนวนเงิน
1,25O.00`, null, NOW);
    assert.strictEqual(p.amount, 1250);
    assert.strictEqual(p.txAt, '2026-09-24T07:32:00.000Z');
    assert.strictEqual(p.ref, '20260924143212345');
    assert.strictEqual(p.bank, 'SCB');
});

test('OCR อ่านจุดในชื่อเดือนเป็นสระ ("กุย.") และ "มี.ค." ไม่ถูกจับเป็น "ม.ค."', () => {
    // ผลจริงจาก Tesseract บนสลิป KBANK
    assert.strictEqual(CFSlipRules.parse('24 กุย. 69 14:32 wu.\nจํานวน:\n70.00 บาท', null, NOW).txAt,
        '2026-09-24T07:32:00.000Z');
    assert.strictEqual(CFSlipRules.parse('5 มี.ค. 69 09:05', null, NOW).txAt,
        '2026-03-05T02:05:00.000Z');
    assert.strictEqual(CFSlipRules.parse('5 ม.ค. 69 09:05', null, NOW).txAt,
        '2026-01-05T02:05:00.000Z');
});

test('อังกฤษ: 24 Sep 2026, 14:32:10 และ Amount THB', () => {
    const p = CFSlipRules.parse(`Bangkok Bank
Transfer successful
24 Sep 2026, 14:32:10
Transaction ID 60ABCD1234567890
Amount 99.50 THB`, null, NOW);
    assert.strictEqual(p.amount, 99.5);
    assert.strictEqual(p.txAt, '2026-09-24T07:32:10.000Z');
    assert.strictEqual(p.bank, 'BBL');
});

test('mini-QR บนสลิปชนะเลขอ้างอิงจากข้อความ', () => {
    const inner = '0006000001' + '0103004' + '0225' + '016267143218ATF09876XYZAB';
    const qr = '00' + String(inner.length).padStart(2, '0') + inner + '5102TH' + '9104ABCD';
    const p = CFSlipRules.parse('จำนวน 70.00', qr, NOW);
    assert.strictEqual(p.ref, '016267143218ATF09876XYZAB');
    assert.strictEqual(p.bank, 'KBANK');
    assert.strictEqual(p.source, 'BARCODE');
});

test('QR พร้อมเพย์ของร้าน (ไม่ใช่สลิป) ไม่ถูกนับเป็นเลขอ้างอิง', () => {
    assert.strictEqual(CFSlipRules.parseSlipQr('00020101021229370016A000000677010111'), null);
    assert.strictEqual(CFSlipRules.parseSlipQr('hello'), null);
});

test('ไม่มีคำนำ แต่มีตัวเลขเงินหลายค่า → ไม่เดา', () => {
    const p = CFSlipRules.parse('70.00\n120.00', null, NOW);
    assert.strictEqual(p.amount, null);
});

/* ── กฎ 4 ข้อ ─────────────────────────────────────────────── */
const CTX = {
    amount: 70,
    qrCreatedAt: '2026-09-24T07:31:40Z',
    qrExpiresAt: '2026-09-24T07:32:40Z',
    refSeen: false, now: NOW,
};
const GOOD = { amount: 70, txAt: '2026-09-24T07:31:00Z', ref: 'ABC1234567890', bank: 'KBANK' };

test('ครบทุกข้อ → PASS (สลิปแสดงแค่นาที จึงเร็วกว่าเวลาออก QR ได้ไม่เกินนาทีนั้น)', () => {
    const r = CFSlipRules.check(GOOD, CTX);
    assert.strictEqual(r.verdict, 'PASS', JSON.stringify(r.checks));
});

test('ยอดไม่ตรง → FAIL', () => {
    const r = CFSlipRules.check({ ...GOOD, amount: 7 }, CTX);
    assert.strictEqual(r.verdict, 'FAIL');
    assert.ok(r.checks.find((c) => c.key === 'amount').msg.includes('ไม่ตรง'));
});

test('สลิปเก่ากว่าเวลาออก QR → FAIL', () => {
    const r = CFSlipRules.check({ ...GOOD, txAt: '2026-09-24T07:10:00Z' }, CTX);
    assert.strictEqual(r.verdict, 'FAIL');
});

test('เลขอ้างอิงเคยใช้แล้ว → FAIL', () => {
    assert.strictEqual(CFSlipRules.check(GOOD, { ...CTX, refSeen: true }).verdict, 'FAIL');
});

test('โอนหลังหมดเวลา (เกิน grace) → WARN ให้คนตัดสิน ไม่ใช่ปฏิเสธ', () => {
    const r = CFSlipRules.check({ ...GOOD, txAt: '2026-09-24T07:40:00Z' },
        { ...CTX, now: new Date('2026-09-24T07:41:00Z') });
    assert.strictEqual(r.verdict, 'WARN');
});

test('อ่านไม่ออก → WARN ไม่ใช่ PASS และบอกว่าควรถ่ายใหม่', () => {
    const r = CFSlipRules.check({ amount: null, txAt: null, ref: null }, CTX);
    assert.strictEqual(r.verdict, 'WARN');
    assert.strictEqual(r.unreadable, true);
});
