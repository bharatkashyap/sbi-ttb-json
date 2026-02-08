import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const upstreamRepo = (process.env.UPSTREAM_REPO || "skbly7/sbi-tt-rates-historical").trim();
const upstreamRef = (process.env.UPSTREAM_REF || "master").trim();
const REPO_API = `https://api.github.com/repos/${upstreamRepo}/git/trees/${encodeURIComponent(upstreamRef)}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${upstreamRepo}/${upstreamRef}`;

const cwd = process.cwd();
const tmpDir = path.join(cwd, "tmp");
const byDateDir = path.join(cwd, "data", "by-date");
const byCurrencyDir = path.join(cwd, "data", "currency");
const latestFile = path.join(cwd, "data", "latest.json");
const tabulaJar = process.env.TABULA_JAR || path.join(cwd, "vendor", "tabula.jar");
const mode = (process.env.MODE || "incremental").toLowerCase(); // incremental | full
const maxFiles = Number(process.env.MAX_FILES || 0);
const startDate = (process.env.START_DATE || "").trim(); // YYYY-MM-DD inclusive

const HUNDRED_UNIT_CODES = new Set(["JPY", "IDR", "THB", "KRW"]);
const ALLOWED_CODES = new Set([
  "USD", "AED", "AUD", "BDT", "BHD", "CAD", "CHF", "CNY", "DKK", "EUR", "GBP", "HKD",
  "IDR", "JPY", "KES", "KRW", "KWD", "LKR", "MYR", "NOK", "NZD", "OMR", "PKR", "QAR",
  "RUB", "SAR", "SEK", "SGD", "THB", "TRY", "ZAR",
]);

fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(byDateDir, { recursive: true });
fs.mkdirSync(byCurrencyDir, { recursive: true });

function fetchJson(url) {
  const outPath = path.join(tmpDir, "api-response.json");
  execFileSync("curl", ["-sSL", "-o", outPath, url], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(outPath, "utf8"));
}

function fetchBinary(url, outPath) {
  execFileSync("curl", ["-sSL", "-o", outPath, url], { stdio: "inherit" });
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseNumber(raw) {
  if (!raw) return null;
  const n = Number(String(raw).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : null;
}

function normalizeRate(code, rate) {
  if (HUNDRED_UNIT_CODES.has(code)) {
    return Number((rate / 100).toFixed(6));
  }
  return rate;
}

function extractRatesFromPdfText(pdfText) {
  const text = (pdfText || "").toUpperCase();
  if (!text.trim()) return {};

  const rates = {};
  const matches = [...text.matchAll(/\b([A-Z]{3})\/INR\b/g)];

  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const code = m[1];
    if (!ALLOWED_CODES.has(code)) continue;

    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const window = text.slice(start, end);

    // TT BUY is first numeric token after CODE/INR in SBI statement layout.
    const n = parseNumber(window);
    if (n === null || n < 0) continue;
    rates[code] = normalizeRate(code, n);
  }

  return rates;
}

function dateFromPdfPath(pdfPath) {
  const m = pdfPath.match(/(\d{4}-\d{2}-\d{2})-/);
  return m ? m[1] : null;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function loadByDateData() {
  const out = new Map();
  if (!fs.existsSync(byDateDir)) return out;
  for (const name of fs.readdirSync(byDateDir)) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(byDateDir, name);
    try {
      const doc = JSON.parse(fs.readFileSync(full, "utf8"));
      if (doc?.date && doc?.rates) out.set(doc.date, doc);
    } catch {
      // ignore malformed existing file
    }
  }
  return out;
}

const existingByDate = loadByDateData();
const existingDates = [...existingByDate.keys()].sort();
const lastProcessedDate = existingDates[existingDates.length - 1] || null;

const tree = fetchJson(REPO_API);
const pdfPaths = (tree.tree || [])
  .map((n) => n.path)
  .filter((p) => /\.pdf$/i.test(p))
  .sort();

const dateToPaths = new Map();
for (const p of pdfPaths) {
  const d = dateFromPdfPath(p);
  if (!d) continue;
  if (!dateToPaths.has(d)) dateToPaths.set(d, []);
  dateToPaths.get(d).push(p);
}

let targetDates = [...dateToPaths.keys()].sort();

if (startDate) {
  if (!isIsoDate(startDate)) {
    throw new Error(`START_DATE must be YYYY-MM-DD, got: ${startDate}`);
  }
  targetDates = targetDates.filter((d) => d >= startDate);
}

if (mode !== "full") {
  const from = lastProcessedDate;
  if (from) {
    targetDates = targetDates.filter((d) => d > from);
  }
}

if (maxFiles > 0 && targetDates.length > maxFiles) {
  targetDates = targetDates.slice(-maxFiles);
}

for (const d of targetDates) {
  const candidates = (dateToPaths.get(d) || []).slice().sort().reverse();
  let parsed = null;

  for (const relPath of candidates) {
    const safeName = relPath.replace(/[/:]/g, "_");
    const pdfUrl = `${RAW_BASE}/${relPath}`;
    const pdfPath = path.join(tmpDir, safeName);

    try {
      fetchBinary(pdfUrl, pdfPath);
      const pdfText = execFileSync("pdftotext", [pdfPath, "-"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const rates = extractRatesFromPdfText(pdfText);
      if (Object.keys(rates).length > 0) {
        parsed = { sourcePath: relPath, rates };
        break;
      }
      console.error(`no rates parsed for ${relPath}`);
    } catch {
      console.error(`pdf text extraction failed for ${relPath}`);
    }
  }

  if (!parsed) {
    console.error(`all candidates failed for ${d}`);
    continue;
  }

  const entry = { date: d, sourcePath: parsed.sourcePath, rates: parsed.rates };
  fs.writeFileSync(path.join(byDateDir, `${d}.json`), JSON.stringify(entry, null, 2));
  existingByDate.set(d, entry);
}

const allDates = [...existingByDate.keys()].sort();
const byCurrency = new Map();

for (const d of allDates) {
  const doc = existingByDate.get(d);
  for (const [cur, rate] of Object.entries(doc.rates || {})) {
    if (!byCurrency.has(cur)) byCurrency.set(cur, []);
    byCurrency.get(cur).push({ date: d, rate });
  }
}

const seenCurrencyFiles = new Set();
const latest = {};
for (const [cur, rows] of byCurrency.entries()) {
  rows.sort((a, b) => a.date.localeCompare(b.date));
  seenCurrencyFiles.add(`${cur}.json`);
  fs.writeFileSync(path.join(byCurrencyDir, `${cur}.json`), JSON.stringify(rows, null, 2));
  latest[cur] = rows[rows.length - 1] || null;
}

if (fs.existsSync(byCurrencyDir)) {
  for (const name of fs.readdirSync(byCurrencyDir)) {
    if (name.endsWith(".json") && !seenCurrencyFiles.has(name)) {
      fs.rmSync(path.join(byCurrencyDir, name));
    }
  }
}

fs.writeFileSync(latestFile, JSON.stringify(latest, null, 2));
const newLastProcessedDate = allDates[allDates.length - 1] || null;

console.log(
  JSON.stringify(
    {
      mode,
      upstreamRepo,
      upstreamRef,
      startDate: startDate || null,
      processedNewDates: targetDates.length,
      totalDates: allDates.length,
      currencies: Object.keys(latest).length,
      lastProcessedDate: newLastProcessedDate,
    },
    null,
    2,
  ),
);
