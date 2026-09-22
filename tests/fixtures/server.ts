import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export async function fixtureServer(root: string) {
  await mkdir(root, { recursive: true });
  const images = [];
  for (const [name, color] of [
    ['first.png', '#f45d48'],
    ['second.png', '#285dd8'],
    ['output.png', '#86558a'],
    ['followup.png', '#11986b'],
  ] as const) {
    const file = path.join(root, name);
    await writeFile(
      file,
      await sharp({ create: { width: 48, height: 32, channels: 4, background: color } })
        .png()
        .toBuffer(),
    );
    images.push(file);
  }
  const output = await readFile(images[2]!);
  const followupOutput = await readFile(images[3]!);
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Web Image Bridge fixture</title>
    <style>body{font:16px system-ui;max-width:900px;margin:40px auto}textarea{width:95%;height:120px}article{padding:16px;border:1px solid #ccc;margin:12px 0}img{width:96px}.text{white-space:pre-wrap}</style>
    <h1>Local fixture</h1><p>Deterministic local upload / response / file download. No remote generation.</p>
    <div id="messages"></div><form><div id="attachments"></div><input type="file" accept="image/*" multiple>
    <textarea id="prompt"></textarea><button type="button" id="send">Send</button></form>
    <script>
      const engineMode=new URLSearchParams(location.search).has('engine') || location.pathname.startsWith('/c/engine-');
      const stored=engineMode && location.pathname.startsWith('/c/') ? JSON.parse(localStorage.getItem(location.pathname)||'null') : null;
      let count = stored?.count||0; let attachments = []; let sends = stored?.sends||0;
      const behavior=stored?.behavior||new URLSearchParams(location.search).get('case')||'';
      const useViewer = new URLSearchParams(location.search).has('viewer') || behavior==='viewer';
      window.fixtureOriginalAnchorClick=HTMLAnchorElement.prototype.click;
      window.fixtureOriginalRevoke=URL.revokeObjectURL;
      const chips = document.querySelector('#attachments');
      const input = document.querySelector('input'); const editor = document.querySelector('#prompt');
      const messages = document.querySelector('#messages');
      if(stored){messages.innerHTML=stored.html;document.body.dataset.sends=String(sends);}
      const persist=()=>{if(engineMode)localStorage.setItem(location.pathname,JSON.stringify({count,sends,html:messages.innerHTML,behavior}));};
      document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('[role="dialog"]')?.remove();});
      input.onchange = () => {
        chips.dataset.uploading = 'true';
        const files = [...input.files];
        setTimeout(() => {
          for (const file of files) { attachments.push(file.name); const chip = document.createElement('span');
            chip.dataset.filename = file.name; chip.textContent = file.name; chips.append(chip); }
          chips.dataset.uploading = 'false'; input.value = '';
        }, 80);
      };
      document.querySelector('#send').onclick = () => {
        if (!editor.value || chips.dataset.uploading === 'true') return;
        sends++; document.body.dataset.sends = String(sends);
        if(engineMode)void fetch('/sent',{method:'POST'});
        const user = document.createElement('article'); user.dataset.messageId = 'user-' + (++count); user.dataset.messageAuthorRole = 'user';
        const text = document.createElement('div'); text.className = 'text'; text.textContent = editor.value; user.append(text);
        for (const name of attachments) { const chip = document.createElement('span'); chip.dataset.filename = name; user.append(chip); }
        messages.append(user); editor.value = ''; attachments = []; chips.replaceChildren();
        history.replaceState(null, '', engineMode ? (location.pathname.startsWith('/c/engine-')?location.pathname:'/c/engine-'+crypto.randomUUID()) : '/c/fixture');
        persist(); document.body.dataset.generating = 'true';
        document.querySelector('#send').disabled = true;
        const pending=behavior==='delayed-image'?document.createElement('article'):null;
        if(pending){pending.dataset.messageId='assistant-'+count;pending.dataset.messageAuthorRole='assistant';
          const done=document.createElement('button');done.dataset.responseComplete='true';pending.append(done);messages.append(pending);
          document.body.dataset.generating='false';}
        setTimeout(() => {
          const reply = pending || document.createElement('article'); reply.dataset.messageId = 'assistant-' + count; reply.dataset.messageAuthorRole = 'assistant';
          const finished=document.createElement('span');finished.dataset.responseComplete='true';reply.append(finished);
          if(behavior==='text' || behavior==='limit' || behavior==='reject'){
            const text=document.createElement('div');text.className='text';text.dataset.responseComplete='true';
            text.textContent=behavior==='text'?'Please clarify the requested image':behavior==='limit'?'image generation limit':'generation rejected';
            if(behavior!=='text')text.setAttribute('role','alert');reply.append(text);messages.append(reply);
            document.body.dataset.generating='false';document.querySelector('#send').disabled=false;persist();return;
          }
          const image = document.createElement('img'); if(engineMode)image.loading='lazy'; image.src = '/output.png?output=' + count; reply.append(image);
          const download = document.createElement('a'); download.dataset.download = 'true'; download.textContent = 'Download';
          download.href = '/download?output=' + count; download.download = 'fixture.png';
          if(useViewer){
            image.alt='생성된 이미지: fixture';
            const opener=document.createElement('div');opener.setAttribute('role','button');opener.append(image);reply.append(opener);
            const complete=document.createElement('button');complete.dataset.testid='copy-turn-action-button';reply.append(complete);
            const outputNumber=count;
            opener.onclick=()=>{
              const dialog=document.createElement('div');dialog.setAttribute('role','dialog');
              const close=document.createElement('button');close.setAttribute('aria-label','전체 화면 닫기');close.onclick=()=>dialog.remove();dialog.append(close);
              const thumbnail=document.createElement('img');thumbnail.src='/output.png?output=2';thumbnail.alt='';dialog.append(thumbnail);
              const full=document.createElement('img');full.src=image.src;full.alt='fixture result';dialog.append(full);
              const save=document.createElement('button');save.setAttribute('aria-label','저장');save.textContent='Save';
              save.onclick=async()=>{
                document.body.dataset.saves=String(Number(document.body.dataset.saves||0)+1);
                const blob=await (await fetch('/download?output='+outputNumber)).blob();
                const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.download='original.png';anchor.href=url;
                anchor.click();URL.revokeObjectURL(url);
              };
              dialog.append(save);document.body.append(dialog);
            };
          }else reply.append(download);
          if(behavior==='multi'){const second=image.cloneNode();second.src='/output.png?output=2';reply.append(second);const another=download.cloneNode(true);another.href='/download?output=2';reply.append(another);}
          messages.append(reply); document.body.dataset.generating = 'false'; document.querySelector('#send').disabled = false;
          persist();
        }, 600);
      };
    </script></html>`;
  const metrics = { sends: 0, downloads: 0 };
  const server = createServer((request, response) => {
    if (request.url === '/sent') {
      metrics.sends++;
      response.writeHead(204).end();
      return;
    }
    if (
      request.url?.startsWith('/download?output=') ||
      request.url?.startsWith('/output.png?output=')
    ) {
      if (request.url.startsWith('/download')) metrics.downloads++;
      const bytes = request.url.endsWith('=2') ? followupOutput : output;
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': bytes.length,
        ...(request.url.startsWith('/download')
          ? { 'Content-Disposition': 'attachment; filename="fixture.png"' }
          : {}),
      });
      response.end(bytes);
    } else {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'",
      });
      response.end(html);
    }
  });
  const portFile = path.join(root, 'port.json');
  const savedPort = await readFile(portFile, 'utf8')
    .then((value) => JSON.parse(value) as number)
    .catch(() => 0);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(savedPort, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('FIXTURE_FAILED');
  await writeFile(portFile, JSON.stringify(address.port));
  return {
    origin: `http://127.0.0.1:${address.port}`,
    images,
    metrics,
    close: () => server.close(),
  };
}
