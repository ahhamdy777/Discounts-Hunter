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
      product: "-[a-z]{0,6}\\d{6,}\\.html", category: "^https://www\\.jumia\\.com\\.eg/[a-z0-9-]+(/[a-z0-9-]+)?/$",
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
    amazon: {
      // Best effort: Amazon blocks automated visitors. The scraper goes slowly, never tries to get past
      // a robot check, and stops asking Amazon for the rest of a run as soon as it is blocked.
      name: "Amazon", host: "amazon.eg", home: "https://www.amazon.eg/",
      search: "https://www.amazon.eg/s?k={q}", pageParam: "page",
      product: "/dp/[A-Z0-9]{10}",
      delayMs: 3000, maxPerRun: 20,
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
    { store: "jumia", url: "https://www.jumia.com.eg/smartphones/" },
    { store: "jumia", url: "https://www.jumia.com.eg/phones-tablets/" },
    { store: "jumia", url: "https://www.jumia.com.eg/televisions/" },
    { store: "jumia", url: "https://www.jumia.com.eg/home-appliances/" },
    { store: "btech", url: "https://btech.com/en/televisions.html" },
    { store: "btech", url: "https://btech.com/en/home-appliances.html" },
    { store: "2b", url: "https://2b.com.eg/en/mobile-phones.html" },
    { store: "2b", url: "https://2b.com.eg/en/home-appliances.html" },
    { store: "noon", url: "https://www.noon.com/egypt-en/electronics-and-mobiles/" },
    { store: "amazon", url: "https://www.amazon.eg/gp/bestsellers/" },
    { store: "amazon", url: "https://www.amazon.eg/gp/new-releases/" },
    { store: "amazon", url: "https://www.amazon.eg/gp/movers-and-shakers/" },
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
    if (/(^|\.)amazon\.eg$/i.test(x.hostname)) {
      const m = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Za-z0-9]{10})/.exec(x.pathname);
      if (m) return "https://www.amazon.eg/dp/" + m[1].toUpperCase();
    }
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
  if (isAmazon(pageUrl)) {
    const a = extractAmazon(html);
    if (a.price) return a;
  }
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
  if (!out.price) {
    const m = /["']price["']\s*:\s*["']?([0-9][0-9.,]*)/i.exec(html) || /data-price=["']([0-9][0-9.,]*)["']/i.exec(html);
    if (m) out.price = parsePrice(m[1]);
  }
  if (!out.price) {
    // last resort: first "EGP 1,234" after the page heading (skips header banners such as free-shipping thresholds)
    const h = html.search(/<h1/i);
    if (h >= 0) {
      const m = /(?:EGP|\u062C\.\u0645|\u062C\u0646\u064A\u0647)\s*([0-9][0-9.,]*)|([0-9][0-9.,]*)\s*(?:EGP|\u062C\.\u0645)/i.exec(html.slice(h, h + 60000));
      if (m) out.price = parsePrice(m[1] || m[2]);
    }
  }
  if (!out.title) {
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (h1) out.title = h1[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || null;
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

const AMAZON_BLOCK = /(validateCaptcha|Type the characters you see in this image|Enter the characters you see below|api-services-support@amazon\.com|not a robot)/i;

function isAmazon(u) {
  try {
    return /(^|\.)amazon\.eg$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
}

function stripTags(h) {
  return decodeEntities(String(h || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

/** Amazon product pages have no standard price data, so read the page markup directly. */
function extractAmazon(html) {
  const out = { title: null, price: null, image: null, brand: null, category: "" };
  const t = /id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
  if (t) out.title = stripTags(t[1]).slice(0, 200) || null;
  const pr =
    /class=["'][^"']*priceToPay[^"']*["'][^>]*>\s*<span class=["']a-offscreen["']>([^<]+)</i.exec(html) ||
    /id=["']corePrice_(?:desktop_)?feature_div["'][\s\S]{0,3000}?class=["']a-offscreen["']>([^<]+)</i.exec(html) ||
    /"priceAmount"\s*:\s*([0-9][0-9.]*)/.exec(html);
  if (pr) out.price = parsePrice(pr[1]);
  const im =
    /"hiRes"\s*:\s*"(https:[^"]+)"/.exec(html) ||
    /data-old-hires=["'](https:[^"']+)["']/.exec(html) ||
    /id=["']landingImage["'][^>]*\ssrc=["'](https:[^"']+)["']/.exec(html);
  if (im) out.image = im[1];
  const b = /id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i.exec(html);
  if (b) out.brand = stripTags(b[1]).replace(/^(Visit the|Brand:)\s*/i, "").replace(/\s*Store$/i, "").slice(0, 60) || null;
  const bc = /id=["']wayfinding-breadcrumbs_feature_div["'][\s\S]*?<\/ul>/i.exec(html);
  if (bc) out.category = stripTags(bc[0]);
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
        "upgrade-insecure-requests": "1",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
      },
    });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      if ([403, 429, 503].includes(res.status)) err.blocked = true;
      throw err;
    }
    const
