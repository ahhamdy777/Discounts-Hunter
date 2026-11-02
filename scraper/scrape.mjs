#!/usr/bin/env node
/**
 * Rasd price scraper (runs on GitHub Actions, no dependencies, Node 20+).
 *
 *  - reads  data/products.json, data/state.json, watchlist.txt, config.json
 *  - searches the stores, adds new products, re-checks prices, auto-categorizes
 *  - writes data/products.json (the website reads this), data/state.json, data/meta.json
 *
 * Optional environment variables (set by the workflow "Run workflow" form):
 *   TELEGRAM_LINK  new Telegram link -> written into config.json
 *   ADD_URLS       product links separated by spaces -> appended to watchlist.txt
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.RASD_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (...a) => path.join(ROOT, ...a);

// ============================== CONFIG ==============================
const CONFIG = {
  SITE_NAME: { ar: "رصد", en: "Rasd" },

  BATCH: 240,             // products re-checked per run
  MAX_PRODUCTS: 1200,
  MAX_LISTINGS: 200,      // category/search pages the crawler remembers
  MAX_NEW_PER_RUN: 60,    // new products accepted per run
  LISTINGS_PER_RUN: 10,   // listing pages crawled per run
  PAGES_MAX: 5,           // pages deep to crawl per listing (page 1..5, then restart)
  MIN_POINTS: 2,          // price points needed before claiming a record low
  HISTORY_MAX: 120,
  CONCURRENCY: 4,         // parallel requests
  DELAY_MS: 250,          // pause between request batches (be polite to the stores)
  DEMO_REMOVE_AT: 15,     // sample products disappear once this many real products have prices
  FETCH_TIMEOUT_MS: 15000,

  // Words the crawler searches for in every store's search page. Add or remove freely.
  SEARCH_TERMS: [
    "iphone", "samsung", "xiaomi", "laptop", "tv", "غسالة", "ثلاجة", "تكييف",
    "حذاء رياضي", "عطر", "سماعة", "ساعة ذكية", "air fryer", "مكنسة",
  ],

  // product  = regex a product link must match
  // category = (optional) regex that marks a link as a category page to crawl later
  // pageParam = query parameter the store uses for page 2, 3, ...
  // Starting points: if a store changes its layout, adjust here (or send me the /admin run result).
  STORES: {
    jumia: {
      name: "Jumia", host: "jumia.com.eg", home: "https://www.jumia.com.eg/",
      search: "https://www.jumia.com.eg/catalog/?q={q}", pageParam: "page",
      product: "-\\d+\\.html", category: "^https://www\\.jumia\\.com\\.eg/[a-z0-9-]+/$",
    },
    btech: {
      name: "B.TECH", host: "btech.com", home: "https://btech.com/en/",
      search: "https://btech.com/en/catalogsearch/result/?q={q}", pageParam: "p",
      product: "btech\\.com/en/[^?#]+\\.html",
    },
    "2b": {
      name: "2B", host: "2b.com.eg", home: "https://2b.com.eg/en/",
      search: "https://2b.com.eg/en/catalogsearch/result/?q={q}", pageParam: "p",
      product: "2b\\.com\\.eg/en/[^?#]+\\.html",
    },
    noon: {
      name: "Noon", host: "noon.com", home: "https://www.noon.com/egypt-en/",
      search: "https://www.noon.com/egypt-en/search/?q={q}", pageParam: "page",
      product: "/egypt-en/[^?#]+/N\\d+[A-Z]?/p/?",
    },
  },

  // Extra starting pages (the crawler also finds more categories by itself).
  SEEDS: [
    { store: "jumia", url: "https://www.jumia.com.eg/mobile-phones/" },
    { store: "jumia", url: "https://www.jumia.com.eg/televisions/" },
    { store: "jumia", url: "https://www.jumia.com.eg/home-appliances/" },
    { store: "jumia", url: "https://www.jumia.com.eg/mens-fashion/" },
    { store: "btech", url: "https://btech.com/en/televisions.html" },
    { store: "btech", url: "https://btech.com/en/home-appliances.html" },
    { store: "2b", url: "https://2b.com.eg/en/mobile-phones.html" },
    { store: "2b", url: "https://2b.com.eg/en/home-appliances.html" },
    { store: "noon", url: "https://www.noon.com/egypt-en/electronics-and-mobiles/" },
  ],
};

const CATS = {
  electronics: { ar: "إلكترونيات", en: "Electronics" },
  appliances: { ar: "أجهزة منزلية", en: "Appliances" },
  fashion: { ar: "أزياء", en: "Fashion" },
  home: { ar: "المنزل", en: "Home" },
  beauty: { ar: "الجمال والصحة", en: "Beauty & health" },
  grocery: { ar: "بقالة", en: "Grocery" },
  sports: { ar: "رياضة", en: "Sports" },
  kids: { ar: "أطفال وألعاب", en: "Kids & toys" },
  other: { ar: "أخرى", en: "Other" },
};

// Keywords used to sort products into categories automatically (Arabic + English).
// Add words here to improve accuracy. The category with the most keyword hits wins; ties go to the earlier one.
const KEYWORDS = {
  electronics: ["موبايل","هاتف","جوال","ايفون","iphone","galaxy","xiaomi","شاومي","redmi","oppo","realme","infinix","tecno","honor","لاب توب","لابتوب","laptop","notebook","macbook","تابلت","tablet","ipad","سماعه","سماعات","headphone","earbuds","airpods","bluetooth","بلوتوث","ساعه ذكيه","smartwatch","smart watch","شاشه","تلفزيون","تلفاز","television","tv","كاميرا","camera","playstation","بلايستيشن","ps5","xbox","gaming","جيمنج","mouse","ماوس","keyboard","كيبورد","لوحه مفاتيح","router","راوتر","power bank","باور بانك","شاحن","charger","cable","كابل","printer","طابعه","monitor","ssd","فلاش","speaker","مكبر صوت","smartphone","mobile","phone"],
  appliances: ["غساله","washing machine","washer","ثلاجه","refrigerator","fridge","فريزر","freezer","بوتجاز","cooker","فرن","oven","ميكروويف","microwave","مكنسه","vacuum","مكواه","steam iron","iron","خلاط","blender","غلايه","kettle","تكييف","air conditioner","مروحه","fan","سخان","water heater","دفايه","heater","قلايه","air fryer","fryer","عصاره","juicer","محضر طعام","food processor","شفاط","dishwasher","توستر","toaster","مفرمه","meat grinder","منقي مياه","purifier","coffee machine","ماكينه قهوه","sandwich maker","رايس كوكر","rice cooker","ساندويتش","ساندوتش"],
  fashion: ["حذاء","احذيه","shoe","shoes","sneaker","كوتشي","sandal","صندل","boot","تيشيرت","t-shirt","tshirt","قميص","shirt","بنطلون","pants","trousers","جينز","jeans","فستان","dress","جاكيت","jacket","hoodie","هودي","شورت","shorts","ملابس","clothing","عباءه","حقيبه","شنطه","bag","backpack","محفظه","wallet","belt","حزام","نظاره","sunglasses","ساعه","watch","جورب","socks","بيجامه","pajama","underwear","cap"],
  home: ["مطبخ","kitchen","اواني","cookware","طنجره","طاسه","frying pan","مفرش","bedding","ملايه","سرير","bed","مرتبه","mattress","كنبه","sofa","ستائر","curtain","سجاد","carpet","rug","اضاءه","lamp","مصباح","led light","تخزين","storage","food container","علب حفظ","اطباق","dinner set","اكواب","mug","cup","ديكور","decor","وسادة","pillow","لحاف","blanket","منشفه","towel","organizer","basket","shelf","ترابيزه","table","كرسي","chair","مكتب","desk","خزانه","wardrobe"],
  beauty: ["عطر","perfume","fragrance","مكياج","makeup","ماسكارا","mascara","روج","lipstick","كريم","cream","شامبو","shampoo","بلسم","hair conditioner","مزيل عرق","deodorant","ماكينه حلاقه","shaver","razor","trimmer","ترايمر","سيروم","serum","lotion","لوشن","بشره","skin","سشوار","hair dryer","مجفف شعر","straightener","فيتامين","vitamin","مكمل","supplement","eyeliner","foundation","بودره","nail polish","صبغه","hair color","غسول","cleanser","واقي شمس","sunscreen","عنايه"],
  grocery: ["زيت","oil","سكر","sugar","ارز","rice","شاي","tea","قهوه","coffee","معكرونه","مكرونه","pasta","عصير","juice","بسكويت","biscuit","شيكولاته","chocolate","snack","شيبسي","chips","لبن","milk","جبن","cheese","منظفات","detergent","صابون","soap","مسحوق","مناديل","tissue","مياه","water","دقيق","flour","عسل","honey","تمر","dates","مربي","jam","صلصه","sauce","cereal","اقراص","اقراص غساله","dishwasher tablet"],
  sports: ["رياضي","sport","dumbbell","دمبل","treadmill","مشايه","دراجه","bicycle","bike","yoga","يوغا","gym","weights","اوزان","تمرين","fitness","camping","خيمه","protein","بروتين","كره","football","tennis","تنس","swim","سباحه","goggles","boxing","kettlebell","resistance band","skipping rope"],
  kids: ["لعبه","العاب","toy","toys","lego","ليجو","طفل","اطفال","kids","baby","بيبي","حفاضات","diaper","pampers","stroller","رضاعه","دميه","doll","puzzle","بازل","crib","شنطه مدرسه","school bag"],
};


// Sample products so the site is not empty before the scrapers have run.
// Clearly labelled "demo" on the site; remove with the "Remove demo data" button.
const DEMO = [
  ["تلفزيون سامسونج 55 بوصة 4K سمارت", "electronics", "jumia", 21999, 0.82],
  ["موبايل شاومي ريدمي نوت 13 - 256 جيجا", "electronics", "jumia", 8999, 0.9],
  ["لاب توب لينوفو آيديا باد 15 بوصة", "electronics", "btech", 18499, 0.95],
  ["غسالة أوتوماتيك 9 كجم من شارب", "appliances", "btech", 17999, 0.88],
  ["ثلاجة ديجيتال 450 لتر نوفروست", "appliances", "2b", 24999, 1.0],
  ["مكنسة كهربائية 2000 وات", "appliances", "2b", 2899, 1.06],
  ["سماعة بلوتوث لاسلكية", "electronics", "noon", 1299, 0.93],
  ["ساعة ذكية بشاشة أموليد", "electronics", "noon", 2399, 0.97],
  ["حذاء رياضي للرجال للجري", "fashion", "jumia", 1599, 0.85],
  ["طقم أواني طهي 10 قطع", "home", "jumia", 1899, 1.02],
  ["خلاط كهربائي 600 وات", "appliances", "2b", 1199, 0.91],
  ["مكواة بخار 2400 وات", "appliances", "btech", 899, 0.96],
  ["كاميرا مراقبة واي فاي", "electronics", "noon", 749, 0.89],
  ["مروحة سقف 56 بوصة", "home", "btech", 1399, 0.99],
  ["ماكينة حلاقة للرجال", "beauty", "jumia", 599, 0.94],
  ["شاشة جيمنج 27 بوصة 165Hz", "electronics", "noon", 7999, 0.86],
];


const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function cleanUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "gclid", "fbclid"].forEach((k) => x.searchParams.delete(k));
    return x.toString();
  } catch {
    return null;
  }
}

function storeOf(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const [key, s] of Object.entries(CONFIG.STORES)) {
      if (host === s.host || host.endsWith("." + s.host)) return key;
    }
  } catch {}
  return null;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();
}

function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  let s = String(v)
    .replace(/[\u0660-\u0669]/g, (d) => d.charCodeAt(0) - 0x660)
    .replace(/[\u06F0-\u06F9]/g, (d) => d.charCodeAt(0) - 0x6f0)
    .replace(/\u066B/g, ".")
    .replace(/\u066C/g, ",")
    .replace(/[^0-9.,]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (s.includes(",")) s = /,\d{3}(?!\d)/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function metaContent(html, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = new RegExp(
    "<meta[^>]+(?:property|name|itemprop)=[\"']" + n + "[\"'][^>]*content=[\"']([^\"']*)[\"']",
    "i"
  ).exec(html);
  if (a) return decodeEntities(a[1]);
  const b = new RegExp(
    "<meta[^>]+content=[\"']([^\"']*)[\"'][^>]*(?:property|name|itemprop)=[\"']" + n + "[\"']",
    "i"
  ).exec(html);
  return b ? decodeEntities(b[1]) : null;
}

function findProductNode(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findProductNode(x);
      if (r) return r;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const t = node["@type"];
  if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) return node;
  if (node["@graph"]) return findProductNode(node["@graph"]);
  return null;
}

function offerPrice(offers) {
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];
  for (const o of list) {
    const p = parsePrice(o.price ?? o.lowPrice ?? (o.priceSpecification && o.priceSpecification.price));
    if (p) return p;
  }
  return null;
}

/** Pull title / price / image / brand out of a product page. */
function extract(html, pageUrl) {
  const out = { title: null, price: null, image: null, brand: null, category: "" };
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const b of blocks) {
    let data;
    try {
      data = JSON.parse(b[1].trim());
    } catch {
      continue;
    }
    const p = findProductNode(data);
    if (!p) continue;
    out.title = out.title || (p.name ? decodeEntities(p.name) : null);
    out.price = out.price || offerPrice(p.offers);
    const img = Array.isArray(p.image) ? p.image[0] : p.image;
    out.image = out.image || (typeof img === "string" ? img : img && img.url) || null;
    if (!out.category && typeof p.category === "string") out.category = p.category;
    const br = p.brand;
    out.brand = out.brand || (typeof br === "string" ? br : br && br.name) || null;
  }
  if (!out.price) {
    out.price = parsePrice(
      metaContent(html, "product:price:amount") ||
        metaContent(html, "og:price:amount") ||
        metaContent(html, "price")
    );
  }
  out.title = out.title || metaContent(html, "og:title") || (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || null;
  out.image = out.image || metaContent(html, "og:image");
  if (out.image) {
    try {
      out.image = new URL(out.image, pageUrl).toString();
    } catch {
      out.image = null;
    }
  }
  if (out.title) out.title = decodeEntities(out.title).slice(0, 200);
  if (out.brand) out.brand = decodeEntities(out.brand).slice(0, 60);
  return out;
}

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CONFIG.FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ar-EG,ar;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.text()).slice(0, 900000);
  } finally {
    clearTimeout(t);
  }
}

// ============================== AUTO-CATEGORY ==============================
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[\u0623\u0625\u0622]/g, "\u0627")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0649/g, "\u064A");
}

const KW = Object.entries(KEYWORDS).map(([cat, list]) => [
  cat,
  list.map((k) => {
    const n = norm(k);
    const w = n.includes(" ") ? 3 : n.length > 3 ? 2 : 1; // multi-word phrases are more specific
    if (/^[a-z0-9 .+-]+$/.test(n)) {
      return { re: new RegExp("(^|[^a-z0-9])" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "s?($|[^a-z0-9])"), w };
    }
    return { s: n, w };
  }),
]);

function urlWords(u) {
  try {
    return decodeURIComponent(new URL(u).pathname).replace(/[-_/.]+/g, " ");
  } catch {
    return "";
  }
}

/** Pick the best category from text; `hint` is used when nothing matches. */
function categorize(text, hint) {
  const t = norm(text);
  let best = null;
  let bestScore = 0;
  for (const [cat, ks] of KW) {
    let sc = 0;
    for (const k of ks) if (k.re ? k.re.test(t) : t.includes(k.s)) sc += k.w;
    if (sc > bestScore) {
      bestScore = sc;
      best = cat;
    }
  }
  return best || (hint && CATS[hint] ? hint : "other");
}


// ============================== STORAGE ==============================
async function readJson(rel, fallback) {
  try {
    return JSON.parse(await readFile(P(rel), "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJson(rel, obj, pretty) {
  await mkdir(path.dirname(P(rel)), { recursive: true });
  await writeFile(P(rel), JSON.stringify(obj, null, pretty ? 2 : 0) + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    const chunk = items.slice(i, i + n);
    out.push(...(await Promise.allSettled(chunk.map(fn))));
    if (i + n < items.length) await sleep(CONFIG.DELAY_MS);
  }
  return out;
}

async function loadDb() {
  const file = await readJson("data/products.json", { products: [] });
  const state = await readJson("data/state.json", {});
  return {
    products: Object.fromEntries((file.products || []).map((p) => [p.id, p])),
    listings: state.listings || {},
    skip: state.skip || {},
    checked: state.checked || {},
    fails: state.fails || {},
    locked: state.locked || {},
    seeded: !!state.seeded,
    lastRun: state.lastRun || null,
  };
}

async function saveDb(db) {
  const ids = Object.keys(db.products);
  for (const k of ["checked", "fails", "locked"]) for (const id of Object.keys(db[k])) if (!db.products[id]) delete db[k][id];
  const skipKeys = Object.keys(db.skip);
  if (skipKeys.length > 3000) skipKeys.slice(0, skipKeys.length - 3000).forEach((k) => delete db.skip[k]);
  await writeJson("data/products.json", { products: Object.values(db.products) });
  await writeJson("data/state.json", {
    seeded: db.seeded, listings: db.listings, skip: db.skip, checked: db.checked, fails: db.fails, locked: db.locked, lastRun: db.lastRun,
  });
  await writeJson("data/meta.json", { updated: Math.floor(Date.now() / 1000), products: ids.length });
}

function newProduct(url, store, cat) {
  return {
    id: store + "-" + hash(url), url, store, cat: cat || "other",
    title: null, image: null, brand: null, history: [], added: Math.floor(Date.now() / 1000),
  };
}

function addProduct(db, url, store, cat, locked) {
  url = cleanUrl(url);
  if (!url || !store) return null;
  const p = newProduct(url, store, cat);
  if (db.products[p.id] || db.skip[p.id]) return null;
  if (Object.keys(db.products).length >= CONFIG.MAX_PRODUCTS) return null;
  db.products[p.id] = p;
  if (locked) db.locked[p.id] = 1;
  return p;
}

function addListing(db, url, store, cat) {
  url = cleanUrl(url);
  if (!url || !store) return false;
  const id = "l-" + hash(url);
  if (db.listings[id] || db.skip[id]) return false;
  if (Object.keys(db.listings).length >= CONFIG.MAX_LISTINGS) return false;
  db.listings[id] = { id, url, store, cat: cat || null, page: 1, crawled: 0, fails: 0 };
  return true;
}

function ensureSeeds(db) {
  const hint = (t) => {
    const c = categorize(t, null);
    return c === "other" ? null : c;
  };
  for (const [key, s] of Object.entries(CONFIG.STORES)) {
    addListing(db, s.home, key);
    for (const q of CONFIG.SEARCH_TERMS) addListing(db, s.search.replace("{q}", encodeURIComponent(q)), key, hint(q));
  }
  for (const s of CONFIG.SEEDS) addListing(db, s.url, s.store, hint(urlWords(s.url)));
}

function seedDemo(db) {
  const now = Math.floor(Date.now() / 1000);
  const days = [30, 22, 15, 9, 4];
  const series = [1.1, 1.06, 1.12, 1.04, 0.98];
  DEMO.forEach((d, i) => {
    const [title, cat, store, base, last] = d;
    const history = series.map((m, k) => [now - days[k] * 86400, Math.round(base * m)]);
    history.push([now - 2 * 3600 * (i + 1), Math.round(base * last)]);
    db.products["demo-" + i] = {
      id: "demo-" + i, demo: true, url: "https://" + CONFIG.STORES[store].host + "/", store, cat, title,
      image: null, brand: null, history, added: now - i * 3600,
    };
  });
}

// ============================== INPUTS (Telegram link, extra product links, watchlist) ==============================
async function applyInputs(db, log) {
  const tg = (process.env.TELEGRAM_LINK || "").trim();
  if (tg) {
    if (/^https?:\/\/\S+$/i.test(tg)) {
      const cfg = await readJson("config.json", {});
      cfg.telegram = tg;
      await writeJson("config.json", cfg, true);
      log.telegram = tg;
    } else log.errors.push("TELEGRAM_LINK ignored (must start with https://)");
  }

  let text = "";
  try {
    text = await readFile(P("watchlist.txt"), "utf8");
  } catch {}
  const extra = (process.env.ADD_URLS || "").split(/\s+/).filter((u) => /^https?:\/\//i.test(u));
  if (extra.length) {
    const have = new Set(text.split(/\r?\n/).map((l) => l.split("|")[0].trim()));
    const add = extra.filter((u) => !have.has(u));
    if (add.length) {
      text = text.replace(/\s*$/, "\n") + add.join("\n") + "\n";
      await writeFile(P("watchlist.txt"), text);
    }
  }
  // watchlist.txt format:  <product link> | <optional category>
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [u, c] = t.split("|").map((x) => x.trim());
    const store = storeOf(u);
    if (!store) {
      log.errors.push("watchlist: store not supported: " + u.slice(0, 60));
      continue;
    }
    if (addProduct(db, u, store, CATS[c] ? c : null, !!CATS[c])) n++;
  }
  log.fromWatchlist = n;
}

// ============================== CRAWLER (search + discover + auto-categorize) ==============================
const EXCLUDE = /\/(customer|checkout|cart|wishlist|account|login|register|contact|about|blog|help|faq|privacy|terms|track|returns?)(\/|\.|$)/i;

function pageUrl(l) {
  const s = CONFIG.STORES[l.store];
  if (!s || !s.pageParam || l.page <= 1) return l.url;
  const u = new URL(l.url);
  u.searchParams.set(s.pageParam, String(l.page));
  return u.toString();
}

function* links(html, base) {
  const seen = new Set();
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let href;
    try {
      href = cleanUrl(new URL(decodeEntities(m[1]), base).toString());
    } catch {
      continue;
    }
    if (!href || seen.has(href)) continue;
    seen.add(href);
    yield href;
  }
}

async function discover(db, log) {
  ensureSeeds(db);
  const due = Object.values(db.listings)
    .sort((a, b) => (a.crawled || 0) - (b.crawled || 0))
    .slice(0, CONFIG.LISTINGS_PER_RUN);
  let added = 0;
  let found = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const l of due) {
    const store = CONFIG.STORES[l.store];
    const fetched = pageUrl(l);
    try {
      const html = await fetchText(fetched);
      const prodRe = new RegExp(store.product);
      const catRe = store.category ? new RegExp(store.category) : null;
      let prodLinks = 0;
      for (const href of links(html, l.url)) {
        if (storeOf(href) !== l.store || EXCLUDE.test(href)) continue;
        if (catRe && catRe.test(href)) {
          if (found < 20 && addListing(db, href, l.store, categorize(urlWords(href), l.cat))) found++;
          continue;
        }
        if (prodRe.test(href)) {
          prodLinks++;
          if (added < CONFIG.MAX_NEW_PER_RUN && addProduct(db, href, l.store, l.cat, false)) added++;
        }
      }
      l.crawled = now;
      l.fails = 0;
      l.page = prodLinks === 0 || l.page >= CONFIG.PAGES_MAX ? 1 : l.page + 1;
      log.sources.push({ url: fetched, links: prodLinks });
    } catch (e) {
      l.crawled = now;
      l.fails = (l.fails || 0) + 1;
      log.errors.push("listing " + fetched + ": " + e.message);
      if (l.fails >= 5) {
        delete db.listings[l.id];
        db.skip[l.id] = 1;
      }
    }
    await sleep(CONFIG.DELAY_MS);
  }
  log.added = added;
  log.newListings = found;
}

async function checkProduct(p, db) {
  const html = await fetchText(p.url);
  const d = extract(html, p.url);
  if (!d.price) {
    // a page with no price but many product links is a category page: remember it as a listing
    const re = new RegExp(CONFIG.STORES[p.store].product);
    let n = 0;
    for (const h of links(html, p.url)) if (h !== p.url && storeOf(h) === p.store && re.test(h) && !EXCLUDE.test(h)) n++;
    if (n >= 8) {
      addListing(db, p.url, p.store, p.cat === "other" ? null : p.cat);
      return "listing";
    }
    throw new Error("no price found");
  }
  const now = Math.floor(Date.now() / 1000);
  p.title = d.title || p.title;
  p.image = d.image || p.image;
  p.brand = d.brand || p.brand;
  if (!db.locked[p.id]) p.cat = categorize([p.title, d.category, urlWords(p.url)].join(" "), p.cat);
  db.checked[p.id] = now;
  delete db.fails[p.id];
  const last = p.history[p.history.length - 1];
  if (!last || last[1] !== d.price) {
    p.history.push([now, d.price]);
    if (p.history.length > CONFIG.HISTORY_MAX) p.history.splice(0, p.history.length - CONFIG.HISTORY_MAX);
  }
  return "ok";
}

async function checkBatch(db, log) {
  const due = Object.values(db.products)
    .filter((p) => !p.demo)
    .sort((a, b) => (db.checked[a.id] || 0) - (db.checked[b.id] || 0))
    .slice(0, CONFIG.BATCH);
  const res = await pool(due, CONFIG.CONCURRENCY, (p) => checkProduct(p, db));
  res.forEach((r, j) => {
    const p = due[j];
    log.checked++;
    if (r.status === "fulfilled") {
      if (r.value === "listing") {
        delete db.products[p.id];
        db.skip[p.id] = 1;
        log.newListings++;
      } else log.ok++;
      return;
    }
    log.failed++;
    db.checked[p.id] = Math.floor(Date.now() / 1000);
    db.fails[p.id] = (db.fails[p.id] || 0) + 1;
    if (log.errors.length < 15) log.errors.push(p.store + " " + p.url.slice(0, 80) + ": " + r.reason.message);
    if (!p.history.length && db.fails[p.id] >= 3) {
      delete db.products[p.id];
      db.skip[p.id] = 1;
      log.removed++;
    }
  });
}

function dropDemoIfReady(db, log) {
  const real = Object.values(db.products).filter((p) => !p.demo && p.history.length).length;
  if (real >= CONFIG.DEMO_REMOVE_AT) {
    let n = 0;
    for (const [id, p] of Object.entries(db.products)) {
      if (p.demo) {
        delete db.products[id];
        n++;
      }
    }
    if (n) log.demoRemoved = n;
  }
}

// ============================== MAIN ==============================
export async function run({ init = false } = {}) {
  const log = { ts: Math.floor(Date.now() / 1000), checked: 0, ok: 0, failed: 0, added: 0, newListings: 0, removed: 0, sources: [], errors: [] };
  const db = await loadDb();
  if (!db.seeded && !Object.keys(db.products).length) {
    seedDemo(db);
    db.seeded = true;
  }
  if (!init) {
    await applyInputs(db, log);
    await discover(db, log);
    await checkBatch(db, log);
    dropDemoIfReady(db, log);
  }
  db.lastRun = log;
  await saveDb(db);
  return log;
}

export { extract, categorize };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = await run({ init: process.argv.includes("--init") });
  console.log(JSON.stringify({ ...log, sources: log.sources.length, errors: log.errors.slice(0, 10) }, null, 2));
}
