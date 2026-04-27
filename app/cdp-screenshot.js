const WebSocket = require('ws');
const fs = require('fs');
const url = 'ws://127.0.0.1:9223/devtools/page/' + process.argv[2];
const out = process.argv[3];
const ws = new WebSocket(url);
ws.on('open', () => {
  ws.send(JSON.stringify({id: 1, method: 'Page.captureScreenshot', params: { format: 'png' }}));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id === 1) {
    if (msg.result?.data) {
      fs.writeFileSync(out, Buffer.from(msg.result.data, 'base64'));
      console.log('saved', out);
    } else {
      console.log('err', JSON.stringify(msg));
    }
    process.exit(0);
  }
});
setTimeout(() => process.exit(1), 5000);
