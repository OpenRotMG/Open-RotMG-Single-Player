import {connect} from 'cloudflare:sockets';
// Connects back only to the caller's own address, so this cannot be used to scan third parties.
export default {
  async fetch(request) {
    const url = new URL(request.url), ip = request.headers.get('cf-connecting-ip');
    const port = Number(url.searchParams.get('port')), nonce = url.searchParams.get('nonce') ?? '';
    if (!ip) return Response.json({error: 'missing cf-connecting-ip'}, {status: 500});
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[0-9a-f]{32}$/.test(nonce)) return Response.json({error: 'port 1024-65535 and 32-hex nonce required'}, {status: 400});
    const started = Date.now();
    try {
      const socket = connect({hostname: ip, port});
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode(`GET /reachability/${nonce} HTTP/1.0\r\nHost: ${ip.includes(':') ? `[${ip}]` : ip}:${port}\r\n\r\n`));
      const reader = socket.readable.getReader(), decoder = new TextDecoder();
      let body = '';
      const deadline = new Promise((_, bad) => setTimeout(() => bad(new Error('no reply within 5s')), 5000));
      while (!body.includes(nonce) && body.length < 4096) {
        const {value, done} = await Promise.race([reader.read(), deadline]);
        if (done) break;
        body += decoder.decode(value, {stream: true});
      }
      socket.close();
      return Response.json({ip, port, reachable: body.includes(nonce), ms: Date.now() - started, ...(body.includes(nonce) ? {} : {reply: body.slice(0, 200)})});
    } catch (error) {
      return Response.json({ip, port, reachable: false, ms: Date.now() - started, error: String(error)});
    }
  },
};
