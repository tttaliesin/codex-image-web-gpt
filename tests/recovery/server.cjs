const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
exports.recoveryServer = async function () {
  const image = await sharp({
    create: { width: 48, height: 32, channels: 4, background: '#3276aa' },
  })
    .png()
    .toBuffer();
  const records = new Map(),
    metrics = new Map(),
    timers = new Set();
  const counts = (name) => {
    if (!metrics.has(name)) metrics.set(name, { sends: 0, downloads: 0 });
    return metrics.get(name);
  };
  const page = (
    initial,
    name,
  ) => `<!doctype html><meta charset="utf-8"><title>M3 recovery fixture</title><div id="messages"></div><form><div id="attachments"></div><input type="file" multiple><textarea id="prompt"></textarea><button id="send" type="button">Send</button></form><script>
    const name=${JSON.stringify(name)}, initial=${JSON.stringify(initial).replace(/</g, '\\u003c')};
    let files=[],id=initial?.id; const messages=document.querySelector('#messages'), editor=document.querySelector('#prompt'),chips=document.querySelector('#attachments');
    document.querySelector('input').onchange=e=>{for(const f of e.target.files){files.push(f.name);const chip=document.createElement('span');chip.dataset.filename=f.name;chips.append(chip);}e.target.value='';};
    function render(state){if(!state)return;messages.replaceChildren();document.body.dataset.generating=String(!state.done);document.querySelector('#send').disabled=!state.done;
      const user=document.createElement('article');user.dataset.messageId='user-1';user.dataset.messageAuthorRole='user';const text=document.createElement('div');text.className='text';text.style.whiteSpace='pre-wrap';text.textContent=state.prompt;user.append(text);
      for(const f of state.files){const chip=document.createElement('span');chip.dataset.filename=f;user.append(chip);}messages.append(user);
      if(state.done){const reply=document.createElement('article');reply.dataset.messageId='assistant-1';reply.dataset.messageAuthorRole='assistant';const done=document.createElement('span');done.dataset.responseComplete='true';reply.append(done);
        for(let i=0;i<state.count;i++){const img=document.createElement('img');img.src='/image';reply.append(img);const link=document.createElement('a');link.dataset.download='true';link.href='/download?case='+encodeURIComponent(state.name)+'&ordinal='+i;link.download='output.png';link.textContent='Download';reply.append(link);}messages.append(reply);}}
    render(initial);
    document.querySelector('#send').onclick=async()=>{if(!editor.value)return;const prompt=editor.value,attached=files.slice();document.querySelector('#send').disabled=true;const r=await fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,prompt,files:attached})});const state=await r.json();id=state.id;history.replaceState(null,'','/c/'+id);editor.value='';files=[];chips.replaceChildren();render(state);};
    setInterval(async()=>{if(id)try{const r=await fetch('/state/'+id);const state=await r.json();if(document.body.dataset.generating!=='false')render(state);}catch{}},100);
  </script>`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/send') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const value = JSON.parse(raw);
      counts(value.name).sends++;
      const record = {
        ...value,
        id: 'engine-' + randomUUID(),
        done: false,
        count: value.name.startsWith('export-') ? 2 : 1,
      };
      records.set(record.id, record);
      const timer = setTimeout(() => {
        record.done = true;
        timers.delete(timer);
      }, 1000);
      timers.add(timer);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(record));
      return;
    }
    if (url.pathname.startsWith('/state/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(records.get(url.pathname.split('/').pop())));
      return;
    }
    if (url.pathname === '/download' || url.pathname === '/image') {
      const name = url.searchParams.get('case');
      const download = url.pathname === '/download';
      if (download) counts(name).downloads++;
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': image.length,
        ...(download ? { 'Content-Disposition': 'attachment; filename="output.png"' } : {}),
      });
      if (
        download &&
        ['download-mid', 'shutdown-download'].includes(name) &&
        counts(name).downloads === 1
      ) {
        res.write(image.subarray(0, 32));
        const timer = setTimeout(() => {
          res.end(image.subarray(32));
          timers.delete(timer);
        }, 20000);
        timers.add(timer);
        res.on('close', () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
      } else res.end(image);
      return;
    }
    const record = records.get(url.pathname.split('/').pop());
    res.setHeader('Content-Type', 'text/html');
    res.end(page(record ?? null, record?.name ?? url.searchParams.get('case')));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    counts,
    async close() {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
};
