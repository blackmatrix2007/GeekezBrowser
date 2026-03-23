// verify.js — Auto-verify profile fingerprint across multiple test sites
// Requires an already-running Puppeteer browser instance (with proxy + fingerprint active)

const SITES = [
    {
        id: 'pixelscan',
        name: 'Pixelscan',
        url: 'https://pixelscan.net',
        timeout: 35000,
        waitMs: 5000,
        scrape: async (page) => {
            const text = await page.evaluate(() => document.body.innerText || '');
            const has = (s) => text.toLowerCase().includes(s.toLowerCase());
            const masking   = has('No masking detected')       ? 'pass' : has('Masking detected')           ? 'fail' : 'unknown';
            const bot       = has('No automated behavior')     ? 'pass' : has('automated behavior detected') ? 'fail' : 'unknown';
            const proxy     = has('No proxy detected')         ? 'pass' : has('Proxy detected')              ? 'warn' : 'unknown';
            const consistent = !has('inconsistent')            ? 'pass' : 'warn';

            // Extract key data points
            const webgl    = text.match(/WebGL Vendor\s*\n([^\n]+)/)?.[1]?.trim() || '';
            const canvas   = text.match(/Canvas Hash\s*\n([^\n]+)/)?.[1]?.trim() || '';
            const audio    = text.match(/AudioContext Hash\s*\n([^\n]+)/)?.[1]?.trim() || '';
            const hardware = text.match(/HardwareConcur[^\n]+\n([^\n]+)/)?.[1]?.trim() || '';

            return { masking, bot, proxy, consistent, webgl, canvas, audio, hardware };
        }
    },
    {
        id: 'sannysoft',
        name: 'Bot Detection (Sannysoft)',
        url: 'https://bot.sannysoft.com',
        timeout: 20000,
        waitMs: 3000,
        scrape: async (page) => {
            return await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('table tr'));
                const checks = {};
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 2) {
                        const key = cells[0].innerText.trim();
                        const cell = cells[1];
                        const val = cell.innerText.trim();
                        const cls = cell.className || '';
                        const pass = cls.includes('passed') || cell.style.background === 'green' || cls.includes('green');
                        if (key) checks[key] = { value: val, pass };
                    }
                });
                return checks;
            });
        }
    },
    {
        id: 'scamalytics',
        name: 'Scamalytics (IP Fraud Score)',
        url: null, // set dynamically from proxy IP
        timeout: 20000,
        waitMs: 2000,
        scrape: async (page) => {
            const text = await page.evaluate(() => document.body.innerText || '');
            const scoreMatch = text.match(/Fraud Score[:\s]*(\d+)/i);
            const riskMatch  = text.match(/(Very Low|Low|Medium|High|Very High)\s+Fraud/i);
            return {
                score: scoreMatch ? parseInt(scoreMatch[1]) : null,
                risk:  riskMatch  ? riskMatch[1] : null,
                isp:   text.match(/ISP[:\s]*([^\n]+)/i)?.[1]?.trim() || ''
            };
        }
    }
];

async function runVerify(browser, proxyIp, onProgress) {
    const allResults = {};

    for (const site of SITES) {
        onProgress({ id: site.id, site: site.name, status: 'loading' });
        let page = null;
        try {
            page = await browser.newPage();

            let url = site.url;
            if (site.id === 'scamalytics') {
                if (!proxyIp) { throw new Error('No proxy IP available'); }
                url = `https://scamalytics.com/ip/${proxyIp}`;
            }

            await page.goto(url, { waitUntil: 'networkidle2', timeout: site.timeout });
            await new Promise(r => setTimeout(r, site.waitMs));

            const data = await site.scrape(page);
            allResults[site.id] = { site: site.name, status: 'done', ...data };
            onProgress({ id: site.id, site: site.name, status: 'done', ...data });
        } catch (e) {
            allResults[site.id] = { site: site.name, status: 'error', error: e.message };
            onProgress({ id: site.id, site: site.name, status: 'error', error: e.message });
        } finally {
            if (page) { try { await page.close(); } catch (_) {} }
        }
    }

    return allResults;
}

module.exports = { runVerify };
