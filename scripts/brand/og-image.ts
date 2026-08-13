/**
 * Regenerates `public/og.png`, the social preview card.
 *
 * A link pasted into Discord, Telegram or X renders whatever this image says,
 * so it is the first thing most people will see of the site. Built by
 * screenshotting a small HTML card with Playwright — which is already a
 * devDependency for the visual-regression work — rather than by committing a
 * binary nobody can reproduce.
 *
 * **Nothing on the card is a live number.** An earlier draft read "1,749 eras
 * of history" and "131 operators tracked", both true on the day and both wrong
 * within a week: the image is static and regenerates only when someone runs
 * this. Anything that drifts belongs on the page, not on the card.
 *
 *   npm run og
 */
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const WIDTH = 1200;
const HEIGHT = 630;

const CARD = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${WIDTH}px; height:${HEIGHT}px; background:#fbfbfd; font-family:Inter,system-ui,sans-serif;
         color:#16161a; display:flex; flex-direction:column; justify-content:space-between;
         padding:72px 80px; position:relative; overflow:hidden; }
  .glow { position:absolute; width:900px; height:900px; right:-320px; top:-380px; border-radius:50%;
          background:radial-gradient(circle, rgba(236,70,115,.16) 0%, rgba(236,70,115,0) 68%); }
  .mark { display:flex; align-items:center; gap:14px; font-size:26px; font-weight:600; color:#5c5c66; }
  .dot { width:16px; height:16px; border-radius:50%; background:#ec4673; }
  h1 { font-size:78px; line-height:1.04; font-weight:700; letter-spacing:-.028em; max-width:16ch; }
  p { font-size:30px; line-height:1.42; color:#5c5c66; max-width:32ch; margin-top:26px; }
  .row { display:flex; gap:56px; align-items:flex-end; }
  .stat { display:flex; flex-direction:column; gap:6px; }
  .stat b { font-size:32px; font-weight:700; letter-spacing:-.02em; white-space:nowrap; }
  .stat span { font-size:20px; color:#5c5c66; white-space:nowrap; }
  .url { font-size:22px; color:#5c5c66; white-space:nowrap; }
</style></head><body>
  <div class="glow"></div>
  <div class="mark"><span class="dot"></span>Polymesh Staking</div>
  <div>
    <h1>Polymesh staking, in the open</h1>
    <p>Operator performance, network returns, and your own position.</p>
  </div>
  <div class="row">
    <div class="stat"><b>Whole history</b><span>every era since genesis</span></div>
    <div class="stat"><b>Every operator</b><span>ranked and compared</span></div>
    <div class="stat"><b>Every formula</b><span>written down</span></div>
    <div class="stat" style="margin-left:auto"><span class="url">f-obrien.github.io</span></div>
  </div>
</body></html>`;

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'og-'));
  const html = join(dir, 'card.html');
  await writeFile(html, CARD, 'utf8');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.goto(`file://${html}`, { waitUntil: 'networkidle' });
    // The webfont arrives over the network; screenshotting before it lands
    // renders the card in a fallback face.
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'public/og.png' });
  } finally {
    await browser.close();
  }

  console.log('Wrote public/og.png');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
