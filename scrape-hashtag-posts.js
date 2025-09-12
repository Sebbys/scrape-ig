const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
require("dotenv").config();

puppeteer.use(StealthPlugin());

const IG_USER = process.env.IG_USER;
const IG_PASS = process.env.IG_PASS;
const IG_COOKIES = process.env.IG_COOKIES;

if (!IG_USER || !IG_PASS) {
  console.warn("ℹ️ IG_USER/IG_PASS not set; will attempt scrape without login.");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ensureLogsDir() {
  const dir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function acceptCookies(page) {
  try {
    await page.evaluate(() => {
      const texts = [
        "allow all","accept all","accept","only allow essential","allow essential",
        "only allow essential cookies","izinkan semua","terima","setuju","accept necessary"
      ];
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const btn = nodes.find(b => texts.some(t => (b.textContent||"").toLowerCase().includes(t)));
      if (btn) btn.click();
    });
  } catch {}
  await sleep(1200);
}

async function loadCookies(page) {
  if (!IG_COOKIES) return;
  try {
    const json = Buffer.from(IG_COOKIES, 'base64').toString('utf8');
    const cookies = JSON.parse(json);
    if (Array.isArray(cookies) && cookies.length) {
      const norm = cookies.map(c => ({ domain: '.instagram.com', ...c }));
      await page.setCookie(...norm);
      console.log(`🍪 loaded ${norm.length} cookies from secret`);
    }
  } catch (e) {
    console.warn("⚠️ Failed to load IG_COOKIES:", e?.message || e);
  }
}

async function login(page) {
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      await page.goto("https://www.instagram.com/accounts/login/", {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      break;
    } catch (error) {
      attempt++;
      console.log(`Login attempt ${attempt} failed: ${error.message}`);
      if (attempt >= maxRetries) {
        throw new Error(`Failed to load login page after ${maxRetries} attempts: ${error.message}`);
      }
      await sleep(2000 * attempt);
    }
  }

  await acceptCookies(page);

  let usernameHandle, usernameFrame;
  try {
    const { handle, frame } = await waitForAnySelectorInFrames(page, [
      'input[name="username"]',
      'input[aria-label="Phone number, username, or email"]',
      'input[aria-label="Username"]',
      'input[autocomplete="username"]'
    ], { attempts: 6, timeout: 12000 });
    usernameHandle = handle;
    usernameFrame = frame;
  } catch (e1) {
    try {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await acceptCookies(page);
      await page.evaluate(() => {
        const texts = ['log in','masuk','login'];
        const el = Array.from(document.querySelectorAll('a,button')).find(b => texts.some(t => (b.textContent||'').toLowerCase().includes(t)));
        el?.click();
      });
      const { handle, frame } = await waitForAnySelectorInFrames(page, [
        'input[name="username"]',
        'input[aria-label="Phone number, username, or email"]',
        'input[aria-label="Username"]',
        'input[autocomplete="username"]'
      ], { attempts: 4, timeout: 8000 });
      usernameHandle = handle;
      usernameFrame = frame;
    } catch (e2) {
      await page.goto('https://m.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await acceptCookies(page);
      const { handle, frame } = await waitForAnySelectorInFrames(page, [
        'input[name="username"]',
        'input[aria-label="Phone number, username, or email"]',
        'input[aria-label="Username"]',
        'input[autocomplete="username"]'
      ], { attempts: 4, timeout: 8000 });
      usernameHandle = handle;
      usernameFrame = frame;
    }
  }

  let passwordHandle = null;
  if (usernameFrame) {
    try {
      passwordHandle = await usernameFrame.waitForSelector('input[name="password"], input[type="password"], input[autocomplete="current-password"]', { visible: true, timeout: 12000 });
    } catch (_) {}
  }
  if (!passwordHandle) {
    const { handle } = await waitForAnySelectorInFrames(page, [
      'input[name="password"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]'
    ], { attempts: 6, timeout: 12000 });
    passwordHandle = handle;
  }

  await usernameHandle.type(IG_USER, { delay: 45 });
  await passwordHandle.type(IG_PASS, { delay: 45 });

  const submitted = await page.evaluate((selUser) => {
    const input = document.querySelector(selUser) || document.querySelector('input[name="username"]');
    const form = input?.closest('form');
    if (form) { form.submit?.(); return true; }
    const btn = Array.from(document.querySelectorAll('button[type="submit"], button'))
      .find(b => (b.textContent||'').toLowerCase().includes('log in') || b.type === 'submit');
    if (btn) { btn.click(); return true; }
    return false;
  }, 'input[name="username"]').catch(()=>false);

  if (!submitted) {
    try { await page.click('button[type="submit"]'); } catch (_) {}
  }

  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }).catch(()=>{});

  await page.evaluate(() => {
    const clickByText = (arr) => {
      const btns = Array.from(document.querySelectorAll("button"));
      const hit = btns.find(b => arr.some(t => (b.textContent||"").toLowerCase().includes(t)));
      if (hit) hit.click();
    };
    clickByText(["not now","bukan sekarang","later"]);
  }).catch(()=>{});

  try {
    const cookies = await page.cookies();
    const b64 = Buffer.from(JSON.stringify(cookies), 'utf8').toString('base64');
    console.log("🍪 session cookies (base64):", b64.slice(0, 80) + '...');
  } catch {}
}

async function waitForAnySelectorInFrames(page, selectors, opts = {}) {
  const attempts = opts.attempts ?? 5;
  const perTryTimeout = opts.timeout ?? 10000;
  for (let i = 0; i < attempts; i++) {
    const frames = page.frames();
    for (const sel of selectors) {
      for (const f of frames) {
        try {
          const handle = await f.waitForSelector(sel, { visible: true, timeout: perTryTimeout });
          if (handle) return { handle, frame: f, selector: sel };
        } catch (_) {}
      }
    }
    await sleep(1500);
  }
  throw new Error(`Element not found: one of ${selectors.join(', ')}`);
}

async function scrapeHashtagPosts(page, hashtag, maxPosts = 50) {
  const url = `https://www.instagram.com/explore/tags/${hashtag}/`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await acceptCookies(page);

  const posts = [];
  let previousHeight;

  while (posts.length < maxPosts) {
    // Scroll down to load more posts
    previousHeight = await page.evaluate('document.body.scrollHeight');
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await sleep(2000);

    // Check if new posts loaded
    const newHeight = await page.evaluate('document.body.scrollHeight');
    if (newHeight === previousHeight) break; // No more posts

    // Extract post links
    const postLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('article a[href*="/p/"]'));
      return links.map(link => link.href).filter((href, index, arr) => arr.indexOf(href) === index); // Unique
    });

    for (const link of postLinks.slice(posts.length)) {
      if (posts.length >= maxPosts) break;
      try {
        const postData = await scrapePost(page, link);
        if (postData) {
          posts.push({ hashtag, ...postData });
        }
      } catch (e) {
        console.warn(`⚠️ Failed to scrape post ${link}:`, e.message);
      }
    }
  }

  return posts.slice(0, maxPosts);
}

async function scrapePost(page, postUrl) {
  await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  return await page.evaluate(() => {
    const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || null;

    const caption = getText('div[data-testid="post-comment-root"] h1') || getText('div[role="button"] span') || null;
    const likes = getText('button[data-testid="like-button"] span') || getText('span[data-testid="like-count"]') || null;
    const comments = getText('span[data-testid="comment-count"]') || null;
    const timestamp = getAttr('time', 'datetime') || null;
    const username = getText('a[data-testid="user-avatar-link"]') || getText('a[href*="/"] span') || null;

    return { url: window.location.href, username, caption, likes, comments, timestamp };
  });
}

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: node scrape-hashtag-posts.js <hashtag> [maxPosts] [more_hashtags...]");
    console.error("Example: node scrape-hashtag-posts.js TelyutizenMuda 100");
    process.exit(1);
  }

  const hashtags = [];
  let maxPosts = 50;

  for (const arg of args) {
    if (!isNaN(arg)) {
      maxPosts = parseInt(arg);
    } else if (arg.startsWith('#')) {
      hashtags.push(arg.slice(1));
    } else {
      hashtags.push(arg);
    }
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--ignore-certificate-errors",
      "--ignore-ssl-errors",
      "--disable-features=VizDisplayCompositor",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "--lang=en-US"
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  try { await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" }); } catch {}
  await loadCookies(page);

  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image','media','font'].includes(type)) return req.abort();
      req.continue();
    });
  } catch {}
  page.setDefaultTimeout(60000);

  const allPosts = [];

  for (const hashtag of hashtags) {
    console.log(`🔍 Scraping posts for #${hashtag} (max ${maxPosts})`);
    try {
      const posts = await scrapeHashtagPosts(page, hashtag, maxPosts);
      console.log(`📊 Found ${posts.length} posts for #${hashtag}`);
      allPosts.push(...posts);
    } catch (err) {
      console.error(`❌ Failed for #${hashtag}:`, err?.message || err);
    }
  }

  // Save to CSV
  const csvFile = path.join(process.cwd(), "hashtag-posts.csv");
  const header = "hashtag,url,username,caption,likes,comments,timestamp\n";
  const csvLines = allPosts.map(post => 
    `"${post.hashtag}","${post.url}","${post.username || ''}","${(post.caption || '').replace(/"/g, '""')}","${post.likes || ''}","${post.comments || ''}","${post.timestamp || ''}"`
  ).join('\n');

  if (!fs.existsSync(csvFile)) {
    fs.writeFileSync(csvFile, header);
  }
  fs.appendFileSync(csvFile, csvLines + '\n');
  console.log(`📝 Saved ${allPosts.length} posts to ${csvFile}`);

  await browser.close();
})();