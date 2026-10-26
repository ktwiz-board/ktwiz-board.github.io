// 화면 점검: 헤드리스 크롬으로 페이지를 열고 점검 스크립트 실행·스크린샷
// node tools/screencheck/cdp.js <url> <width> <height> <evalFile|-> [shot.png|-] [light|dark]
// env: LOCALDATA=<live.json 경로>(데이터 주입), WAIT(ms), FULL(전체 높이 상한)
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const [,, url, w = '390', h = '800', evalFile = '-', shot = '-', scheme = 'light'] = process.argv;
const CH = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9300 + Math.floor(Math.random() * 500), prof = path.join(os.tmpdir(), 'cdpprof' + port);
const chrome = spawn(CH, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--window-size=' + w + ',' + h, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let list; for (let i = 0; i < 40; i++) { try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); break; } catch (e) { await sleep(250); } }
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {};
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; }
    if (d.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(d.params.exceptionDetails).slice(0, 500));
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') console.log('CONSOLE.ERROR', JSON.stringify(d.params.args.map(a => a.value || a.description)).slice(0, 400)); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 700 });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*googletagmanager.com*', '*google-analytics.com*'] });
  if (process.env.LOCALDATA) {
    const json = fs.readFileSync(process.env.LOCALDATA, 'utf8');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: "(()=>{const D=" + JSON.stringify(json) + ";const rf=window.fetch.bind(window);window.fetch=(u,o)=>String(u).includes('live.json')?Promise.resolve(new Response(D,{status:200})):rf(u,o);})()" });
  }
  await send('Page.navigate', { url });
  await sleep(+process.env.WAIT || 10000);
  if (evalFile !== '-') { const r = await send('Runtime.evaluate', { expression: fs.readFileSync(evalFile, 'utf8'), returnByValue: true }); console.log(JSON.stringify(r.result.result.value, null, 1)); }
  if (shot !== '-') {
    let clip; if (process.env.FULL) { const m = await send('Page.getLayoutMetrics'); clip = { x: 0, y: 0, width: +w, height: Math.min(+process.env.FULL, Math.ceil(m.result.cssContentSize.height)), scale: 1 }; }
    const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip, captureBeyondViewport: true } : { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(r.result.data, 'base64')); console.log('shot', shot);
  }
  ws.close(); chrome.kill(); setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {} process.exit(0); }, 600);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
