// Smoke test for index.html against the sample chats.
//
// Needs Chrome and puppeteer-core, which is not a dependency of the viewer itself:
//   npm install --no-save puppeteer-core
//   node tests/smoke.cjs
// Set CHROME_PATH if Chrome is not in the default macOS location.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.opus': 'audio/ogg', '.pdf': 'application/pdf' };

// A static server with plain folder listings. With `manifests` off it hides
// manifest.json, which forces the viewer onto the listing path.
function serve({ manifests }) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || (!manifests && rel.endsWith('manifest.json'))) {
      res.writeHead(404).end('not found');
    } else if (fs.statSync(file).isDirectory()) {
      const links = fs.readdirSync(file, { withFileTypes: true })
        .map((d) => `<a href="${encodeURIComponent(d.name)}${d.isDirectory() ? '/' : ''}">${d.name}</a>`);
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(links.join('\n'));
    } else {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const chatTitles = (page) => page.$$eval('#chats .chat-title', (els) => els.map((e) => e.textContent).sort());
const SAMPLE_TITLES = ['Dad', 'Maple Street Neighbors', 'Maya Chen', 'Sam Okafor', 'Summer Trip 2027'];

// Counts of what the open chat rendered, after its media has loaded.
async function openAndCount(page, title) {
  await page.evaluate((t) => {
    [...document.querySelectorAll('#chats li')].find((li) => li.querySelector('.chat-title').textContent === t).click();
  }, title);
  await page.waitForFunction((t) => document.querySelector('.header-title')?.textContent === t, {}, title);
  return page.evaluate(async () => {
    const box = document.getElementById('messages');
    const imgs = [...box.querySelectorAll('.media img')];
    imgs.forEach((img) => { img.loading = 'eager'; });
    await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
    const media = [...box.querySelectorAll('video, audio')];
    await Promise.all(media.map((m) => m.readyState >= 1 || new Promise((ok) => {
      m.addEventListener('loadedmetadata', ok, { once: true });
      m.addEventListener('error', ok, { once: true });
      setTimeout(ok, 5000);
    })));
    return {
      mine: box.querySelectorAll('.msg.me').length,
      images: imgs.filter((img) => img.naturalWidth > 0).length,
      playable: media.filter((m) => m.readyState >= 1).length,
      files: box.querySelectorAll('a.file').length,
      missing: box.querySelectorAll('.file.missing').length,
      polls: box.querySelectorAll('.poll').length,
      system: box.querySelectorAll('.sys').length,
    };
  });
}

const MAYA = { mine: 12, images: 4, playable: 2, files: 0, missing: 0, polls: 0, system: 1 };
const TRIP = { mine: 2, images: 5, playable: 0, files: 1, missing: 0, polls: 1, system: 7 };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const problems = [];
  const newPage = async () => {
    const page = await browser.newPage();
    page.on('pageerror', (err) => problems.push(String(err)));
    page.on('console', (msg) => { if (msg.type() === 'error' && !/404/.test(msg.text())) problems.push(msg.text()); });
    return page;
  };

  for (const manifests of [true, false]) {
    const mode = manifests ? 'manifest' : 'folder listing';
    const server = await serve({ manifests });
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await newPage();
    await page.goto(`${base}/index.html?dir=samples`);
    await page.waitForSelector('#chats li');
    check(`server, ${mode}: chat list`, await chatTitles(page), SAMPLE_TITLES);
    check(`server, ${mode}: Maya Chen`, await openAndCount(page, 'Maya Chen'), MAYA);
    check(`server, ${mode}: Summer Trip 2027`, await openAndCount(page, 'Summer Trip 2027'), TRIP);
    await page.close();
    server.close();
  }

  // Opened straight from disk, with the folder chosen through the folder input.
  const page = await newPage();
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  await page.waitForSelector('.placeholder button.primary');
  check('file: welcome shown, no chats', await chatTitles(page), []);
  await (await page.$('#picker')).uploadFile(path.join(ROOT, 'samples'));
  await page.waitForSelector('#chats li');
  check('local folder: chat list', await chatTitles(page), SAMPLE_TITLES);
  check('local folder: Maya Chen', await openAndCount(page, 'Maya Chen'), MAYA);
  check('local folder: Summer Trip 2027', await openAndCount(page, 'Summer Trip 2027'), TRIP);
  check('local folder: media uses object URLs', await page.$$eval('.media img', (els) => els.every((e) => e.src.startsWith('blob:'))), true);

  // A request to another origin must be refused by the Content-Security-Policy.
  const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => false, () => true));
  check('CSP blocks requests to other origins', blocked, true);
  problems.splice(0, problems.length, ...problems.filter((p) => !/example\.com/.test(p)));
  await page.close();

  check('no page errors', problems, []);
  await browser.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
