/**
 * CafeFlow — QR พร้อมเพย์ตามยอดชำระ (§14, §16)
 * ══════════════════════════════════════════════════════════════════
 * สร้าง QR ที่ "ผูกยอดไว้ในตัว" ทันทีที่ลูกค้าเลือกจ่ายด้วย QR
 * ลูกค้าสแกนแล้วแอปธนาคารขึ้นยอดมาให้เลย — พิมพ์ยอดผิดไม่ได้
 * ซึ่งเป็นสาเหตุอันดับหนึ่งของยอดไม่ตรงที่ทำให้แคชเชียร์ต้องมานั่งไล่ทีหลัง
 *
 * ★ ไม่ต้องต่อ payment gateway — พร้อมเพย์เป็นมาตรฐานเปิด ประกอบ payload
 *   ได้ในเครื่อง จึงออก QR ได้แม้เน็ตร้านหลุด (ข้อกำหนดหลักของระบบนี้)
 *
 * สิ่งที่ QR ทำไม่ได้: บอกว่าเงินเข้าแล้วหรือยัง — ต้องมีคนหรือ OCR ยืนยัน
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');

const SHARED = path.resolve(__dirname, '..', '..', '..', 'shared');
const { CFEmv } = require(path.join(SHARED, 'cf-emv.js'));
const { CFSlipRules } = require(path.join(SHARED, 'cf-slip-rules.js'));
const { CF_SLIP_MODE } = require(path.join(SHARED, 'cf-consts.js'));

const { publish } = require('./stream');
const { audit, touch, ApiError, settingsOf, transition } = require('./orders');
const { sniff } = require('./media');
const slipOcr = require('../slip-ocr');
const { ROOT } = require('../env');

const DEFAULT_TIMEOUT_SEC = 60;

/**
 * ออก QR ใบใหม่ให้ออเดอร์
 *
 * ⚠️ ทุกครั้งที่ออกใบใหม่ต้องยกเลิกใบเก่าทั้งหมดก่อน
 *    ไม่งั้นลูกค้าอาจจ่ายตามยอดของใบเก่า (ตะกร้าเปลี่ยนไปแล้ว) แล้วระบบ
 *    บันทึกว่าจ่ายครบทั้งที่ขาด
 */
async function issueQr(c, branchId, orderId, ctx) {
    const o = (await c.query(
        'SELECT * FROM cf_order WHERE id = $1 AND branch_id = $2 FOR UPDATE',
        [orderId, branchId])).rows[0];
    if (!o) throw new ApiError(404, 'ไม่พบออเดอร์');

    const OK = ['ORDER_CONFIRMED', 'WAITING_PAYMENT', 'PAYMENT_TIMEOUT', 'PAYMENT_FAILED'];
    if (!OK.includes(o.status)) {
        throw new ApiError(409, 'ออเดอร์นี้ไม่อยู่ในขั้นตอนที่ออก QR ได้');
    }

    const br = (await c.query('SELECT promptpay_id, name_th FROM branch WHERE id = $1',
        [branchId])).rows[0];
    if (!br.promptpay_id) {
        // บอกให้ชัดว่าต้องไปตั้งที่ไหน — ไม่ใช่ error ลอย ๆ ที่หน้าร้านแก้เองไม่ได้
        throw new ApiError(409,
            'ยังไม่ได้ตั้งพร้อมเพย์ของร้าน — ตั้งได้ที่หน้าภาพรวม › ตั้งค่าคีออสก์');
    }

    const amount = Number(o.total);
    if (!(amount > 0)) throw new ApiError(409, 'ยอดออเดอร์ต้องมากกว่า 0');

    const payload = generatePayload(String(br.promptpay_id), { amount });

    // ตรวจก่อนส่งออกไป — QR ที่ CRC ผิดจะสแกนติดแต่ธนาคารปฏิเสธ
    // ปล่อยให้ลูกค้าเจอหน้าร้านแล้วหาสาเหตุยากกว่านี้มาก
    const check = CFEmv.verify(payload, { amount });
    if (!check.ok) {
        throw new ApiError(500, 'สร้าง QR ไม่ถูกต้อง: ' + check.problems.join(' · '));
    }

    const settings = await settingsOf(c, branchId);
    const sec = parseInt(settings.qrTimeoutSec, 10) || DEFAULT_TIMEOUT_SEC;

    await c.query(
        `UPDATE payment_qr SET cancelled_at = now()
          WHERE order_id = $1 AND cancelled_at IS NULL`, [orderId]);

    const q = (await c.query(
        `INSERT INTO payment_qr (order_id, target, amount, payload, expires_at)
         VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)
         RETURNING id, created_at, expires_at`,
        [orderId, String(br.promptpay_id), amount, payload, String(sec)])).rows[0];

    await c.query(
        `UPDATE cf_order SET payment_method = 'QR', rev = nextval('global_rev'),
                updated_at = now() WHERE id = $1`, [orderId]);

    await audit(c, branchId, {
        eventType: 'QR_ISSUED', orderId,
        actorKind: ctx.actorKind, actorUserId: ctx.actorUserId,
        deviceId: ctx.deviceId, ip: ctx.ip,
        payload: { amount, expiresAt: q.expires_at, qrId: q.id },
    });
    await touch(c, branchId, 'orders', orderId, 'update');

    return { qrId: q.id, payload, amount, orderNo: o.orderNo,
             createdAt: q.created_at, expiresAt: q.expires_at, timeoutSec: sec };
}

/**
 * ตัวนับเวลาอยู่ฝั่งเซิร์ฟเวอร์ ไม่ใช่ setInterval ในเบราว์เซอร์
 * เพราะถ้าคีออสก์ปิดจอหรือรีเฟรช ออเดอร์จะค้างรอชำระตลอดกาล
 * และไม่มีใครรู้ว่าต้องไปเคลียร์
 */
async function expireDueQr(pool, branchId, publishFn) {
    const due = await pool.query(
        `SELECT DISTINCT q.order_id, o.status
           FROM payment_qr q JOIN cf_order o ON o.id = q.order_id
          WHERE q.cancelled_at IS NULL AND q.expires_at < now()
            AND o.branch_id = $1 AND o.status = 'WAITING_PAYMENT'`, [branchId]);

    for (const row of due.rows) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const o = (await client.query(
                "SELECT * FROM cf_order WHERE id = $1 AND status = 'WAITING_PAYMENT' FOR UPDATE",
                [row.order_id])).rows[0];
            if (!o) { await client.query('ROLLBACK'); continue; }   // มีคนจ่ายไปพอดี

            await client.query(
                `UPDATE cf_order SET prev_status = status, status = 'PAYMENT_TIMEOUT',
                        rev = nextval('global_rev'), updated_at = now() WHERE id = $1`,
                [row.order_id]);
            await client.query(
                'UPDATE payment_qr SET cancelled_at = now() WHERE order_id = $1 AND cancelled_at IS NULL',
                [row.order_id]);
            await audit(client, branchId, {
                eventType: 'PAYMENT_TIMEOUT', orderId: row.order_id,
                oldStatus: 'WAITING_PAYMENT', newStatus: 'PAYMENT_TIMEOUT',
                actorKind: 'SYSTEM', reason: 'หมดเวลาสแกน QR',
            });
            await touch(client, branchId, 'orders', row.order_id, 'update');
            await client.query('COMMIT');
            publishFn(branchId, { entity: 'orders', op: 'update', id: row.order_id });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('[qr-expire]', err.message);
        } finally {
            client.release();
        }
    }
    return due.rows.length;
}

/* ══════════════════════════════════════════════════════════════════
   ตรวจสลิปจากกล้องคีออสก์ (§14, §17)
   ══════════════════════════════════════════════════════════════════
   คีออสก์ส่ง "ภาพ" มาเท่านั้น — การอ่านและตัดสินทั้งหมดอยู่ที่นี่
   ถ้าให้เบราว์เซอร์อ่านยอดแล้วบอกเซิร์ฟเวอร์ว่า "ผ่าน" ใครก็ยิง request ปลอมได้

   ผลที่เป็นไปได้:
     PAID    ผ่านครบกฎ + ร้านตั้ง slipMode = auto → เข้าครัวทันที
     REVIEW  ที่เหลือทั้งหมด → แคชเชียร์ตรวจพร้อมภาพและผลกฎ
     RETRY   ภาพอ่านไม่ออก/ไม่ผ่าน แต่ยังมีโอกาสถ่ายใหม่ (ออเดอร์ยังรอชำระ)
*/
const SLIP_MAX_TRIES = 3;
const SLIP_STATUSES = ['WAITING_PAYMENT', 'PAYMENT_TIMEOUT'];

function slipDir() {
    const d = new Date().toISOString().slice(0, 10);
    const dir = path.join(ROOT, 'data', 'slips', d);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function reasonOf(checks, prefix) {
    const bad = checks.filter((c) => !c.ok).map((c) => c.msg);
    return prefix + (bad.length ? ': ' + bad.join(' · ') : '');
}

async function checkSlip(deps, orderId, buf, ctx) {
    const { pool, tx, branchId } = deps;
    const br = branchId();

    const kind = sniff(buf);
    if (!kind) throw new ApiError(415, 'ไฟล์ภาพสลิปไม่ถูกต้อง');

    const o = (await pool.query('SELECT * FROM cf_order WHERE id = $1 AND branch_id = $2',
        [orderId, br])).rows[0];
    if (!o) throw new ApiError(404, 'ไม่พบออเดอร์');
    if (!SLIP_STATUSES.includes(o.status)) {
        throw new ApiError(409, 'ออเดอร์นี้ไม่ได้รอชำระแล้ว', { orderStatus: o.status });
    }
    const qr = (await pool.query(
        'SELECT * FROM payment_qr WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [orderId])).rows[0];
    if (!qr) throw new ApiError(409, 'ออเดอร์นี้ยังไม่ได้ออก QR');

    // ภาพเดิมเป๊ะส่งซ้ำ = ถูกบันทึกหรือส่งต่อมา ไม่ใช่ถ่ายจากกล้องใหม่ — ปฏิเสธก่อนเสียเวลา OCR
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if ((await pool.query('SELECT 1 FROM payment_slip WHERE sha256 = $1', [sha])).rows.length) {
        throw new ApiError(409, 'ภาพสลิปนี้ถูกส่งมาแล้ว');
    }

    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[kind];
    const file = path.join(slipDir(), `${orderId}-${sha.slice(0, 16)}.${ext}`);
    fs.writeFileSync(file, buf);
    const rel = path.relative(path.join(ROOT, 'data', 'slips'), file).replace(/\\/g, '/');

    // OCR นอกทรานแซกชัน — ใช้หลายวินาที ห้ามถือ lock ออเดอร์ไว้ระหว่างนั้น
    let ocr = null, ocrErr = null;
    try { ocr = await slipOcr.read(buf); } catch (err) { ocrErr = err.message; }

    const parsed = ocr ? CFSlipRules.parse(ocr.text, ocr.qr)
        : { amount: null, txAt: null, ref: null, bank: null, source: null };

    let refSeen = false;
    if (parsed.ref) {
        refSeen = (await pool.query(
            `SELECT 1 FROM payment WHERE branch_id = $1 AND ref = $2 AND order_id <> $3
                AND status IN ('PAID','REVIEW')
             UNION ALL
             SELECT 1 FROM payment_slip WHERE parsed_ref = $2 AND order_id <> $3
             LIMIT 1`, [br, parsed.ref, orderId])).rows.length > 0;
    }

    const settings = await settingsOf(pool, br);
    const result = CFSlipRules.check(parsed, {
        amount: Number(o.total), qrCreatedAt: qr.created_at, qrExpiresAt: qr.expires_at, refSeen,
    });
    if (ocrErr) {
        result.checks.unshift({ key: 'ocr', ok: false, level: 'WARN',
                                msg: 'อ่านสลิปอัตโนมัติไม่ได้ — ' + ocrErr });
        if (result.verdict !== 'FAIL') result.verdict = 'WARN';
    }
    const mode = CF_SLIP_MODE(settings);

    // ผู้ตัดสินว่า "จ่ายแล้ว" คือระบบ ไม่ใช่คีออสก์ — audit ต้องบอกแบบนั้น
    const sys = { ...ctx, actorKind: 'SYSTEM', actorUserId: null };

    const decide = (status, tries) => {
        const left = SLIP_MAX_TRIES - tries;
        // อ่านไม่ออก หรือไม่ผ่าน แต่ออเดอร์ยังรอชำระและยังมีโอกาส → ให้ลูกค้าถ่ายใหม่
        // (อาจยกสลิปผิดใบ หรือแสงสะท้อน — ส่งคนตรวจทันทีทำให้คิวแคชเชียร์ยาวโดยไม่จำเป็น)
        if (!ocrErr && status === 'WAITING_PAYMENT' && left > 0
            && (result.unreadable || result.verdict === 'FAIL')) return 'RETRY';
        if (result.verdict === 'PASS' && mode === 'auto') return 'PAID';
        return 'REVIEW';
    };

    const run = (allowPaid) => tx(async (c) => {
        const cur = (await c.query('SELECT status FROM cf_order WHERE id = $1 FOR UPDATE',
            [orderId])).rows[0];
        if (!SLIP_STATUSES.includes(cur.status)) {
            throw new ApiError(409, 'ออเดอร์นี้ไม่ได้รอชำระแล้ว', { orderStatus: cur.status });
        }
        const tries = Number((await c.query(
            'SELECT count(*) AS n FROM payment_slip WHERE order_id = $1', [orderId])).rows[0].n) + 1;
        let outcome = decide(cur.status, tries);
        if (outcome === 'PAID' && !allowPaid) outcome = 'REVIEW';

        const slip = (await c.query(
            `INSERT INTO payment_slip (order_id, image_path, sha256, uploaded_by, ocr_status,
                    ocr_engine, ocr_raw, ocr_ms, parsed_amount, parsed_tx_at, parsed_ref,
                    parsed_bank, parsed_source, checks, verdict)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
            [orderId, rel, sha, ctx.actorUserId || ctx.deviceId || null,
             ocr ? 'DONE' : 'ERROR', ocr ? ocr.engine : null,
             JSON.stringify(ocr ? { text: ocr.text, qr: ocr.qr, confidence: ocr.confidence }
                                : { error: ocrErr }),
             ocr ? ocr.ms : null, parsed.amount, parsed.txAt, parsed.ref, parsed.bank,
             parsed.source, JSON.stringify(result.checks), result.verdict])).rows[0];

        await audit(c, br, {
            eventType: 'SLIP_CHECKED', orderId, actorKind: ctx.actorKind,
            actorUserId: ctx.actorUserId, deviceId: ctx.deviceId, ip: ctx.ip,
            payload: { slipId: Number(slip.id), verdict: result.verdict, outcome, mode, tries,
                       amount: parsed.amount, ref: parsed.ref },
        });

        if (outcome === 'PAID') {
            if (cur.status === 'PAYMENT_TIMEOUT') {
                await transition(c, br, orderId, 'PAYMENT_REVIEW',
                    { reason: 'สลิปผ่านการตรวจหลัง QR หมดเวลา' }, sys);
            }
            await transition(c, br, orderId, 'PAID',
                { method: 'QR', ref: parsed.ref, bank: parsed.bank }, sys);
            await c.query(
                `UPDATE payment_slip SET payment_id =
                    (SELECT id FROM payment WHERE order_id = $1 AND status = 'PAID' LIMIT 1)
                  WHERE id = $2`, [orderId, slip.id]);
        } else if (outcome === 'REVIEW') {
            await transition(c, br, orderId, 'PAYMENT_REVIEW', {
                reason: reasonOf(result.checks, result.verdict === 'PASS'
                    ? 'สลิปผ่านการตรวจ รอแคชเชียร์ยืนยัน' : 'สลิปไม่ผ่านการตรวจอัตโนมัติ'),
            }, sys);
        } else {
            await touch(c, br, 'orders', orderId, 'update');
        }
        return { slipId: Number(slip.id), outcome, tries,
                 triesLeft: Math.max(0, SLIP_MAX_TRIES - tries) };
    });

    let out;
    try {
        out = await run(true);
    } catch (err) {
        // ด่านสุดท้ายของฐานข้อมูล: เลขอ้างอิงนี้ถูกบันทึกจ่ายไปแล้ว (uq_pay_ref) → ให้คนตรวจ
        if (err.code !== '23505') throw err;
        result.verdict = 'FAIL';
        result.checks = result.checks.map((c) => (c.key === 'ref'
            ? { ...c, ok: false, level: 'FAIL', msg: 'สลิปนี้เคยใช้ชำระไปแล้ว' } : c));
        out = await run(false);
    }

    return {
        ...out, verdict: result.verdict, checks: result.checks, mode,
        parsed: { amount: parsed.amount, txAt: parsed.txAt, ref: parsed.ref, bank: parsed.bank },
        expected: Number(o.total),
        status: out.outcome === 'PAID' ? 'PAID'
            : out.outcome === 'REVIEW' ? 'PAYMENT_REVIEW' : o.status,
    };
}

function registerPayments(app, deps) {
    const { pool, tx, branchId } = deps;
    const { context, handle, requireKioskOrUser } = deps.helpers;

    /** ออก QR — คีออสก์เรียกได้โดยไม่ต้องล็อกอิน (ลูกค้าเป็นคนกด) */
    app.post('/api/orders/:id/qr', handle(async (req) => {
        const ctx = await context(req);
        const out = await tx((c) => issueQr(c, branchId(), req.params.id, ctx));

        // ส่ง SVG ไปเลย เบราว์เซอร์จึงไม่ต้องมีไลบรารี QR
        // (และอาร์ติแฟกต์คีออสก์ก็ไม่ต้องแบกมันไปด้วย)
        out.svg = await QRCode.toString(out.payload, {
            type: 'svg', errorCorrectionLevel: 'M', margin: 1,
        });
        publish(branchId(), { entity: 'orders', op: 'update', id: req.params.id });
        return out;
    }));

    /** ดูใบที่ยังใช้ได้ — คีออสก์รีเฟรชแล้วต้องได้ใบเดิม ไม่ใช่ออกใบใหม่ */
    app.get('/api/orders/:id/qr', handle(async (req) => {
        const r = await deps.query(
            `SELECT q.* FROM payment_qr q JOIN cf_order o ON o.id = q.order_id
              WHERE q.order_id = $1 AND o.branch_id = $2
                AND q.cancelled_at IS NULL AND q.expires_at > now()
              ORDER BY q.id DESC LIMIT 1`, [req.params.id, branchId()]);
        if (!r.rows.length) throw new ApiError(404, 'ไม่มี QR ที่ยังใช้ได้');
        const q = r.rows[0];
        return {
            qrId: q.id, payload: q.payload, amount: Number(q.amount),
            createdAt: q.created_at, expiresAt: q.expires_at,
            svg: await QRCode.toString(q.payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }),
        };
    }));

    /**
     * ส่งภาพสลิปมาตรวจ — คีออสก์ที่จับคู่แล้ว (หรือพนักงาน) เท่านั้น
     * ตอบกลับหลัง OCR เสร็จ (ราว 2–6 วินาที) คีออสก์แสดง "กำลังตรวจสอบ…" ระหว่างนั้น
     */
    app.post('/api/orders/:id/slip', handle(async (req) => {
        const ctx = await context(req);
        requireKioskOrUser(ctx);

        const file = await req.file({ limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
        if (!file) throw new ApiError(400, 'ไม่พบภาพสลิป');
        let buf;
        try {
            buf = await file.toBuffer();
        } catch (err) {
            if (err.code === 'FST_REQ_FILE_TOO_LARGE') throw new ApiError(413, 'ภาพใหญ่เกินไป');
            throw err;
        }
        if (!buf || !buf.length) throw new ApiError(400, 'ภาพว่าง');

        const out = await checkSlip(deps, req.params.id, buf, ctx);
        req.log.info(`[slip] ${req.params.id} ${out.verdict} → ${out.outcome}` +
                     ` (฿${out.parsed.amount} / ฿${out.expected})`);
        publish(branchId(), { entity: 'orders', op: 'update', id: req.params.id });
        return out;
    }));

    /** ผลตรวจสลิปของออเดอร์ — หน้าแคชเชียร์ใช้ตอนเปิดตรวจ (พนักงานเท่านั้น) */
    app.get('/api/orders/:id/slips', handle(async (req) => {
        const ctx = await context(req);
        if (!ctx.user) throw new ApiError(401, 'ต้องเข้าสู่ระบบก่อน');
        const r = await deps.query(
            `SELECT s.id, s.created_at, s.ocr_status, s.ocr_ms, s.parsed_amount, s.parsed_tx_at,
                    s.parsed_ref, s.parsed_bank, s.parsed_source, s.checks, s.verdict
               FROM payment_slip s JOIN cf_order o ON o.id = s.order_id
              WHERE s.order_id = $1 AND o.branch_id = $2 ORDER BY s.id DESC`,
            [req.params.id, branchId()]);
        return r.rows.map((x) => ({
            id: Number(x.id), createdAt: x.created_at, ocrStatus: x.ocr_status, ocrMs: x.ocr_ms,
            amount: x.parsed_amount == null ? null : Number(x.parsed_amount),
            txAt: x.parsed_tx_at, ref: x.parsed_ref, bank: x.parsed_bank,
            source: x.parsed_source, checks: x.checks || [], verdict: x.verdict,
            imageUrl: '/api/slips/' + x.id + '/image',
        }));
    }));

    /** ภาพสลิป — เป็นข้อมูลการเงินของลูกค้า ห้ามเปิดแบบไม่ล็อกอิน */
    app.get('/api/slips/:id/image', handle(async (req, reply) => {
        const ctx = await context(req);
        if (!ctx.user) throw new ApiError(401, 'ต้องเข้าสู่ระบบก่อน');
        const r = await deps.query(
            `SELECT s.image_path FROM payment_slip s JOIN cf_order o ON o.id = s.order_id
              WHERE s.id = $1 AND o.branch_id = $2`, [req.params.id, branchId()]);
        if (!r.rows.length) throw new ApiError(404, 'ไม่พบภาพสลิป');
        const base = path.join(ROOT, 'data', 'slips');
        const file = path.resolve(base, r.rows[0].image_path);
        if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) {
            throw new ApiError(404, 'ไม่พบไฟล์ภาพสลิป');
        }
        const buf = fs.readFileSync(file);
        return reply.type(sniff(buf) || 'application/octet-stream')
            .header('Cache-Control', 'private, max-age=3600').send(buf);
    }));

    /**
     * ตัวเก็บกวาด QR หมดอายุ — เดินทุก 5 วินาที
     * ความคลาดเคลื่อนไม่เกิน 5 วินาทีถือว่ายอมรับได้สำหรับ timeout 60 วินาที
     * และถูกกว่าการตั้ง timer ต่อออเดอร์มาก
     */
    let timer = null;
    app.addHook('onReady', async () => {
        timer = setInterval(() => {
            expireDueQr(pool, branchId(), publish).catch((e) =>
                console.error('[qr-expire]', e.message));
        }, 5000);
        timer.unref();
        slipOcr.warm(app.log);
    });
    app.addHook('onClose', async () => {
        if (timer) clearInterval(timer);
        await slipOcr.close();
    });
}

module.exports = { registerPayments, issueQr, expireDueQr, checkSlip };
