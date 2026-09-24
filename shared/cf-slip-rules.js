/**
 * CafeFlow — อ่านและตรวจสลิปโอนเงิน (§14 Validation Rule, §17)
 * ══════════════════════════════════════════════════════════════════
 * แยกเป็นสองขั้นที่ทดสอบแยกกันได้:
 *   parse(text, qrText)  ข้อความจาก OCR (+ mini-QR บนสลิป) → ยอด เวลา เลขอ้างอิง ธนาคาร
 *   check(parsed, ctx)   ผลที่อ่านได้ + ข้อมูล QR ที่เราออก → PASS / WARN / FAIL
 *
 * ★ อ่านไม่ออก = WARN ไม่ใช่ PASS
 *   OCR จากจอมือถือผ่านเว็บแคมพลาดได้เสมอ ค่าที่ไม่รู้ต้องไม่ถูกนับว่า "ผ่าน"
 *   ไม่งั้นภาพเบลอ ๆ ที่อ่านอะไรไม่ได้เลยจะกลายเป็นทางลัดให้ออเดอร์เข้าครัว
 *
 * ★ mini-QR บนสลิปเชื่อได้กว่าข้อความ — มันคือเลขอ้างอิงที่ธนาคารฝังไว้
 *   แต่ไม่มียอดเงิน ยอดจึงต้องมาจาก OCR เสมอ
 *
 * ⚠️ ตรรกะบริสุทธิ์ — ห้ามอ้าง window / require ไลบรารีภายนอก
 */
(function (root, factory) {
    const m = factory();
    if (typeof module === 'object' && module.exports) module.exports = m;
    else Object.keys(m).forEach((k) => { root[k] = m[k]; });
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /** รหัสธนาคารใน mini-QR (มาตรฐานธนาคารแห่งประเทศไทย) */
    const BANK_CODES = {
        '002': 'BBL', '004': 'KBANK', '006': 'KTB', '011': 'TTB', '014': 'SCB',
        '022': 'CIMB', '024': 'UOB', '025': 'BAY', '030': 'GSB', '033': 'GHB',
        '034': 'BAAC', '067': 'TISCO', '069': 'KKP', '073': 'LHB',
    };

    /** ชื่อที่พบในข้อความสลิป — ลำดับสำคัญ คำเฉพาะมาก่อนคำกว้าง */
    const BANK_WORDS = [
        ['KBANK', /K\s*PLUS|กสิกร|KBank|KASIKORN/i],
        ['SCB',   /SCB|ไทยพาณิชย์/i],
        ['KTB',   /Krungthai|กรุงไทย|เป๋าตัง/i],
        ['BAY',   /Krungsri|กรุงศรี|KMA/i],
        ['TTB',   /ttb|ทหารไทย|ธนชาต/i],
        ['GSB',   /ออมสิน|MyMo|GSB/i],
        ['BBL',   /Bangkok\s*Bank|ธนาคารกรุงเทพ|Bualuang|บัวหลวง/i],
        ['KKP',   /เกียรตินาคิน|KKP/i],
        ['UOB',   /UOB|ยูโอบี/i],
        ['CIMB',  /CIMB|ซีไอเอ็มบี/i],
    ];

    const TH_MONTHS = [
        ['ม.ค.', 'มกราคม'], ['ก.พ.', 'กุมภาพันธ์'], ['มี.ค.', 'มีนาคม'], ['เม.ย.', 'เมษายน'],
        ['พ.ค.', 'พฤษภาคม'], ['มิ.ย.', 'มิถุนายน'], ['ก.ค.', 'กรกฎาคม'], ['ส.ค.', 'สิงหาคม'],
        ['ก.ย.', 'กันยายน'], ['ต.ค.', 'ตุลาคม'], ['พ.ย.', 'พฤศจิกายน'], ['ธ.ค.', 'ธันวาคม'],
    ];
    const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                       'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

    /**
     * "ก.ย." → pattern ที่ยอมให้ OCR ทำจุดหาย หรืออ่านจุดเป็นสระล่าง/บน ("กุย.")
     * จุดแต่ละจุดจึงแทนด้วย "อะไรก็ได้ไม่เกิน 2 ตัวในกลุ่มจุด/ช่องว่าง/สระลอย"
     */
    const SEP = '[.,\\s\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E]{0,2}';
    function looseAbbr(a) {
        return a.split('.').filter(Boolean)
            .map((part) => part.split('').join('\\s?')).join(SEP) + SEP;
    }
    // ชื่อย่อยาวก่อน — "ม.ค." แบบหลวม ๆ จะไปจับ "มี.ค." ได้ถ้าตรวจก่อน
    const MONTH_RE = TH_MONTHS.map(([abbr, full], i) => ({
        i, len: abbr.length, re: new RegExp('(?:' + full + '|' + looseAbbr(abbr) + ')'),
    })).sort((a, b) => b.len - a.len);

    /** แก้ความผิดพลาดที่ OCR ชอบทำกับตัวเลข: O/o/l/I ติดกับตัวเลข */
    function fixDigits(s) {
        return s
            .replace(/(?<=\d)[Oo](?=[\d.,])|(?<=[\d.,])[Oo](?=\d|\b)/g, '0')
            .replace(/(?<=\d)[lI|](?=\d)/g, '1');
    }

    function toNum(s) {
        const n = parseFloat(String(s).replace(/[,\s]/g, ''));
        return isFinite(n) ? n : null;
    }

    const MONEY = /(\d{1,3}(?:[,\s]\d{3})*|\d+)[.,](\d{2})(?!\d)/g;

    /**
     * ยอดเงิน — หาจากบรรทัดที่มีคำว่า "จำนวน/Amount" ก่อน (ตัวเลขอาจอยู่บรรทัดถัดไป)
     * ข้ามบรรทัดค่าธรรมเนียม/ยอดคงเหลือ ซึ่งเป็นตัวเลขรูปแบบเดียวกันบนสลิปเดียวกัน
     */
    function findAmount(lines) {
        const SKIP = /ค่าธรรมเนียม|fee|คงเหลือ|balance|ยอดเงินคงเหลือ/i;
        const KEY = /จำนวน|ยอดเงิน|ยอดโอน|amount|total/i;
        const moneyIn = (line) => {
            const out = [];
            let m;
            MONEY.lastIndex = 0;
            while ((m = MONEY.exec(line))) out.push(toNum(m[1] + '.' + m[2]));
            return out.filter((n) => n != null);
        };

        for (let i = 0; i < lines.length; i++) {
            if (!KEY.test(lines[i]) || SKIP.test(lines[i])) continue;
            for (let j = i; j < Math.min(lines.length, i + 3); j++) {
                if (j > i && SKIP.test(lines[j])) break;
                const got = moneyIn(lines[j]);
                if (got.length) return got[0];
            }
        }

        // ไม่เจอคำนำ — รับเฉพาะกรณีมีตัวเลขเงินที่ไม่ใช่ศูนย์เพียงค่าเดียว
        // (มีหลายค่าแล้วเดาเอาจะเลือกผิดได้ ปล่อยเป็น "อ่านไม่ได้" ให้คนตรวจดีกว่า)
        const all = new Set();
        lines.forEach((l) => { if (!SKIP.test(l)) moneyIn(l).forEach((n) => { if (n > 0) all.add(n); }); });
        return all.size === 1 ? [...all][0] : null;
    }

    /** ปี 2 หลัก/4 หลัก พ.ศ./ค.ศ. → ค.ศ. เลือกค่าที่ใกล้ "ตอนนี้" ที่สุด */
    function fullYear(y, now) {
        y = parseInt(y, 10);
        if (y >= 2400) return y - 543;
        if (y >= 1900) return y;
        const cur = now.getUTCFullYear();
        const be = 2500 + y - 543, ce = 2000 + y;
        return Math.abs(be - cur) <= Math.abs(ce - cur) ? be : ce;
    }

    /** วันเวลาบนสลิปเป็นเวลาไทยเสมอ (UTC+7) ไม่ขึ้นกับโซนเวลาของเครื่องที่รัน */
    function bangkok(y, mo, d, hh, mm, ss) {
        if (!(mo >= 0 && mo < 12 && d >= 1 && d <= 31 && hh < 24 && mm < 60)) return null;
        return new Date(Date.UTC(y, mo, d, hh - 7, mm, ss || 0));
    }

    function findDateTime(text, now) {
        const time = /(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*[:.]\s*(\d{2}))?(?!\d)/;
        const flat = text.replace(/\s+/g, ' ');

        // ไทย: 24 ก.ย. 69 14:32 · 24 กันยายน 2569 - 14:32 น.
        for (const { i, re } of MONTH_RE) {
            const m = new RegExp('(\\d{1,2})\\s*' + re.source + '\\s*(\\d{2,4})').exec(flat);
            if (!m) continue;
            const t = time.exec(flat.slice(m.index + m[0].length));
            if (!t) continue;
            return bangkok(fullYear(m[2], now), i, +m[1], +t[1], +t[2], t[3] ? +t[3] : 0);
        }

        // อังกฤษ: 24 Sep 2026 14:32 · 24 Sep 26, 14:32
        const e = /(\d{1,2})\s*([A-Za-z]{3})[a-z]*\.?,?\s*(\d{2,4})/.exec(flat);
        if (e && EN_MONTHS.includes(e[2].toLowerCase())) {
            const t = time.exec(flat.slice(e.index + e[0].length));
            if (t) {
                return bangkok(fullYear(e[3], now), EN_MONTHS.indexOf(e[2].toLowerCase()),
                    +e[1], +t[1], +t[2], t[3] ? +t[3] : 0);
            }
        }

        // ตัวเลขล้วน: 24/09/2569 14:32
        const n = /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(flat);
        if (n) {
            const t = time.exec(flat.slice(n.index + n[0].length));
            if (t) return bangkok(fullYear(n[3], now), +n[2] - 1, +n[1], +t[1], +t[2], t[3] ? +t[3] : 0);
        }
        return null;
    }

    function findRef(lines) {
        const KEY = /เลขที่รายการ|รหัสอ้างอิง|เลขอ้างอิง|หมายเลขอ้างอิง|เลขที่อ้างอิง|transaction\s*(?:id|no)|ref(?:erence)?\s*(?:no|id)?/i;
        const TOKEN = /[A-Za-z0-9]{10,}/;
        for (let i = 0; i < lines.length; i++) {
            if (!KEY.test(lines[i])) continue;
            for (let j = i; j < Math.min(lines.length, i + 3); j++) {
                const rest = j === i ? lines[j].replace(KEY, ' ') : lines[j];
                const m = TOKEN.exec(rest.replace(/[\s:]/g, ''));
                if (m && /\d{6,}/.test(m[0])) return m[0].toUpperCase();
            }
        }
        return null;
    }

    function findBank(text) {
        for (const [code, re] of BANK_WORDS) if (re.test(text)) return code;
        return null;
    }

    /** TLV แบบ EMV (tag 2 หลัก · ความยาว 2 หลัก) — คืน null ถ้าโครงพัง */
    function tlv(s) {
        const out = {};
        let i = 0;
        while (i < s.length) {
            if (i + 4 > s.length) return null;
            const tag = s.substr(i, 2), len = parseInt(s.substr(i + 2, 2), 10);
            if (!/^\d{2}$/.test(tag) || isNaN(len) || i + 4 + len > s.length) return null;
            out[tag] = s.substr(i + 4, len);
            i += 4 + len;
        }
        return out;
    }

    /**
     * mini-QR บนสลิป (Slip Verify API ของธนาคารไทย)
     * โครง: 00 → { 00: API ID "000001", 01: รหัสธนาคารผู้โอน, 02: เลขอ้างอิง } · 51: "TH" · 91: CRC
     * คืน null ถ้าไม่ใช่ QR ของสลิป — เช่นลูกค้ายก QR พร้อมเพย์ของร้านขึ้นมาแทน
     */
    function parseSlipQr(qr) {
        if (!qr || typeof qr !== 'string') return null;
        const top = tlv(qr.trim());
        if (!top || !top['00'] || top['51'] !== 'TH') return null;
        const inner = tlv(top['00']);
        if (!inner || !inner['02'] || !/^0000\d\d$/.test(inner['00'] || '')) return null;
        return { ref: inner['02'].toUpperCase(), bank: BANK_CODES[inner['01']] || null,
                 bankCode: inner['01'] || null };
    }

    /**
     * @param {string} text   ข้อความจาก OCR
     * @param {string} [qr]   ข้อความจาก mini-QR ถ้าถอดได้
     * @param {Date}   [now]  ใช้เดาปี 2 หลักว่าเป็น พ.ศ. หรือ ค.ศ.
     */
    function parse(text, qr, now) {
        now = now || new Date();
        const clean = fixDigits(String(text || '')).replace(/\r/g, '');
        const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
        const fromQr = parseSlipQr(qr);

        const txAt = findDateTime(clean, now);
        const textRef = findRef(lines);
        return {
            amount: findAmount(lines),
            txAt: txAt ? txAt.toISOString() : null,
            ref: fromQr ? fromQr.ref : textRef,
            bank: (fromQr && fromQr.bank) || findBank(clean),
            source: fromQr ? 'BARCODE' : 'TEXT',
        };
    }

    const MIN = 60 * 1000;

    /**
     * กฎ 4 ข้อ (§14) — ทุกข้อคืน { key, ok, level, msg } ให้หน้าแคชเชียร์แสดงได้ตรง ๆ
     *
     * @param ctx.amount       ยอดที่ต้องชำระ
     * @param ctx.qrCreatedAt  เวลาออก QR
     * @param ctx.qrExpiresAt  เวลาหมดอายุ QR
     * @param ctx.refSeen      เลขอ้างอิงนี้เคยใช้กับออเดอร์อื่นแล้วหรือไม่
     * @param ctx.graceSec     ผ่อนเวลาหลังหมดอายุ (คนโอนทันแต่ยกสลิปช้า)
     * @param ctx.now
     */
    function check(p, ctx) {
        const now = ctx.now ? new Date(ctx.now) : new Date();
        const grace = (ctx.graceSec != null ? ctx.graceSec : 180) * 1000;
        const checks = [];
        const add = (key, level, msg) => checks.push({ key, ok: level === 'PASS', level, msg });

        if (p.amount == null) add('amount', 'WARN', 'อ่านยอดเงินไม่ได้');
        else if (Math.abs(p.amount - Number(ctx.amount)) > 0.005) {
            add('amount', 'FAIL', `ยอดในสลิป ฿${p.amount.toFixed(2)} ไม่ตรงกับยอด ฿${Number(ctx.amount).toFixed(2)}`);
        } else add('amount', 'PASS', `ยอดตรง ฿${p.amount.toFixed(2)}`);

        if (!p.txAt) add('time', 'WARN', 'อ่านวันเวลาที่โอนไม่ได้');
        else {
            const t = new Date(p.txAt).getTime();
            // สลิปส่วนใหญ่แสดงแค่ระดับนาที — ปัดเวลาออก QR ลงเป็นนาทีก่อน + เผื่อนาฬิกาคลาด 1 นาที
            const created = Math.floor(new Date(ctx.qrCreatedAt).getTime() / MIN) * MIN - MIN;
            const expires = new Date(ctx.qrExpiresAt).getTime();
            if (t < created) add('time', 'FAIL', 'สลิปนี้โอนก่อนออก QR — อาจเป็นสลิปเก่า');
            else if (t > now.getTime() + 5 * MIN) add('time', 'FAIL', 'เวลาในสลิปอยู่ในอนาคต');
            else if (t > expires + grace) add('time', 'WARN', 'โอนหลัง QR หมดเวลา');
            else add('time', 'PASS', 'เวลาโอนอยู่ในช่วงของ QR');
        }

        if (!p.ref) add('ref', 'WARN', 'อ่านเลขอ้างอิงไม่ได้');
        else if (ctx.refSeen) add('ref', 'FAIL', 'สลิปนี้เคยใช้ชำระไปแล้ว');
        else add('ref', 'PASS', 'เลขอ้างอิงไม่ซ้ำ');

        const verdict = checks.some((c) => c.level === 'FAIL') ? 'FAIL'
            : checks.some((c) => c.level === 'WARN') ? 'WARN' : 'PASS';

        // อ่านไม่ออกเลยทั้งยอดและเวลา = ภาพใช้ไม่ได้ ให้ลูกค้าถ่ายใหม่ ดีกว่าส่งคนตรวจ
        const unreadable = p.amount == null && !p.txAt;
        return { verdict, checks, unreadable };
    }

    return { CFSlipRules: { parse, check, parseSlipQr, BANK_CODES } };
});
