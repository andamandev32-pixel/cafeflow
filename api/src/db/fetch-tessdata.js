/**
 * ดาวน์โหลดไฟล์ภาษาของ OCR (ไทย + อังกฤษ) มาเก็บในเครื่องครั้งเดียว
 * ══════════════════════════════════════════════════════════════════
 * ตัวอ่านสลิปต้องทำงานได้ตอนเน็ตร้านหลุด — จึงห้ามให้ tesseract.js
 * ไปโหลดจาก CDN เองตอนรัน ไฟล์อยู่ที่ data/tessdata/ (ไม่ขึ้น repo)
 *
 *   npm run fetch-tessdata
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../env');

const DIR = path.join(ROOT, 'data', 'tessdata');
const LANGS = ['tha', 'eng'];
const SRC = (lang) =>
    `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;

(async () => {
    fs.mkdirSync(DIR, { recursive: true });
    for (const lang of LANGS) {
        const dest = path.join(DIR, `${lang}.traineddata.gz`);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            console.log(`✓ ${lang} มีอยู่แล้ว`);
            continue;
        }
        process.stdout.write(`↓ ${lang} … `);
        const res = await fetch(SRC(lang));
        if (!res.ok) throw new Error(`${SRC(lang)} → HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(dest + '.part', buf);
        fs.renameSync(dest + '.part', dest);     // โหลดครึ่งทางแล้วหลุดต้องไม่เหลือไฟล์เสีย
        console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    }
    console.log('เก็บไว้ที่', DIR);
})().catch((err) => { console.error('✗', err.message); process.exit(1); });
