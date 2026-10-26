(() => {
  const txt = document.body.innerText, bad = [];
  ['undefined', 'NaN', 'null', 'Infinity', '[object'].forEach(w => { let i = -1; while ((i = txt.indexOf(w, i + 1)) >= 0) bad.push(w + ': …' + txt.slice(Math.max(0, i - 40), i + 30).replace(/\s+/g, ' ')); });
  const over = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && !e.closest('.tablebox,.subnav,.ls,.boxpanel,.tabs,.leaves'); }).slice(0, 6).map(e => e.tagName + '.' + String(e.className).slice(0, 30));
  const t = id => (document.getElementById(id) || {}).innerText || '';
  return { docW: document.documentElement.scrollWidth, vw: innerWidth, model: !!window.PSModel, bad, over,
    chip: t('statusTxt'), stamp: t('mcStamp'), hero: t('heroGame').replace(/\s+/g, ' ').slice(0, 300), bars: t('mcBars').replace(/\s+/g, ' '),
    series: t('serGames').replace(/\s+/g, ' ').slice(0, 300) };
})()
