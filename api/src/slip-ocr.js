/**
 * CafeFlow — อ่านภาพสลิปในเครื่อง (§17)
 * ══════════════════════════════════════════════════════════════════
 * สองงานบนภาพเดียว:
 *   1. ถอด mini-QR ของสลิปด้วย jsQR → เลขอ้างอิงที่ธนาคารฝังไว้ (แม่นกว่า OCR)
 *   2. OCR ข้อความไทย+อังกฤษด้วย Tesseract → ยอด เวลา ธนาคาร
 *
 * ★ worker ตัวเดียวอุ่นไว้ตลอด — สร้างใหม่ทุกครั้งใช้ 2–4 วินาทีแค่โหลดภาษา
 *   ลูกค้ายืนถือมือถือรออยู่หน้าจอ ทุกวินาทีมีความหมาย
 *
 * ★ ไฟล์ภาษาอยู่ใน data/tessdata/ (npm run fetch-tessdata) ห้ามโหลดจากเน็ตตอนรัน
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const jsQR = require('jsqr');

const { ROOT } = require('./env');

const LANG_DIR = path.join(ROOT, 'data', 'tessdata');
const TIMEOUT_MS = 20000;
const QR_EDGE = 1280;      // ย่อก่อนหา QR — ภาพใหญ่กว่านี้ช้าขึ้นมากแต่ไม่เจอเพิ่ม
const OCR_MIN_EDGE = 1600; // ขยายภาพเล็กก่อน OCR — ตัวอักษรไทยมีวรรณยุกต์เล็ก ๆ ที่หายง่าย

let workerP = null;

function ready() {
    return LANG_DIR && ['tha', 'eng'].every((l) =>
        fs.existsSync(path.join(LANG_DIR, `${l}.traineddata.gz`)));
}

function worker() {
    if (!workerP) {
        if (!ready()) {
            return Promise.reject(new Error(
                'ยังไม่มีไฟล์ภาษาของ OCR — รัน npm run fetch-tessdata ที่เครื่องเซิร์ฟเวอร์'));
        }
        const { createWorker } = require('tesseract.js');
        workerP = createWorker(['tha', 'eng'], 1, {
            langPath: LANG_DIR, gzip: true, cacheMethod: 'none',
        }).catch((err) => { workerP = null; throw err; });
    }
    return workerP;
}

/** เรียกตอนเซิร์ฟเวอร์พร้อม — ลูกค้าคนแรกของวันจะได้ไม่ต้องรอโหลดภาษา */
function warm(log) {
    if (!ready()) {
        log.warn('[slip-ocr] ไม่มีไฟล์ภาษา — ตรวจสลิปด้วยกล้องใช้ไม่ได้จนกว่าจะรัน npm run fetch-tessdata');
        return;
    }
    const t0 = Date.now();
    worker().then(() => log.info(`[slip-ocr] พร้อม (${Date.now() - t0} ms)`))
        .catch((err) => log.error('[slip-ocr] ' + err.message));
}

async function close() {
    if (!workerP) return;
    const w = await workerP.catch(() => null);
    workerP = null;
    if (w) await w.terminate();
}

function fit(img, maxEdge, minEdge) {
    let s = 1;
    const long = Math.max(img.width, img.height);
    if (maxEdge && long > maxEdge) s = maxEdge / long;
    if (minEdge && long < minEdge) s = Math.min(2, minEdge / long);
    const w = Math.round(img.width * s), h = Math.round(img.height * s);
    const cv = createCanvas(w, h);
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    return { cv, g, w, h };
}

function findQr(img) {
    const { g, w, h } = fit(img, QR_EDGE);
    const d = g.getImageData(0, 0, w, h);
    const r = jsQR(d.data, w, h, { inversionAttempts: 'attemptBoth' });
    return r ? r.data : null;
}

/**
 * ขาวดำ + ยืดคอนทราสต์ — ภาพจากเว็บแคมที่ถ่ายจอมือถือมักซีดและมีแสงสะท้อน
 * ยืดช่วง 2%–98% ของความสว่างให้เต็ม 0–255 แทนการตัดขาวดำตายตัว
 * (ตัดตายตัวแล้วสลิปพื้นสีเขียว/ม่วงของบางธนาคารจะดำทั้งแผ่น)
 */
function prepForOcr(img) {
    const { cv, g, w, h } = fit(img, null, OCR_MIN_EDGE);
    const d = g.getImageData(0, 0, w, h);
    const px = d.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
        const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
        px[i] = y;
        hist[y]++;
    }
    const n = w * h;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.02) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.02) break; }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < px.length; i += 4) {
        const v = Math.max(0, Math.min(255, ((px[i] - lo) * 255 / span) | 0));
        px[i] = px[i + 1] = px[i + 2] = v;
    }
    g.putImageData(d, 0, 0);
    return cv.encode('png');
}

function withTimeout(p, ms, msg) {
    let t;
    return Promise.race([
        p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); }),
    ]).finally(() => clearTimeout(t));
}

/**
 * @returns {{ text, qr, confidence, ms, engine }}
 */
async function read(buf) {
    const t0 = Date.now();
    const img = await loadImage(buf);
    if (!img.width || !img.height) throw new Error('อ่านไฟล์ภาพไม่ได้');

    const qr = findQr(img);
    const png = await prepForOcr(img);
    const w = await worker();
    const r = await withTimeout(w.recognize(png), TIMEOUT_MS, 'OCR ใช้เวลานานเกินไป');

    return {
        text: r.data.text || '',
        confidence: r.data.confidence,
        qr,
        ms: Date.now() - t0,
        engine: 'tesseract.js ' + require('tesseract.js/package.json').version,
    };
}

module.exports = { read, warm, close, ready };
