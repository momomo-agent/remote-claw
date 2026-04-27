const WebSocket = require('ws');
const url = 'ws://127.0.0.1:9223/devtools/page/' + process.argv[2];
const expr = process.argv[3];
const ws = new WebSocket(url);
ws.on('open', () => {
  ws.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true }}));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id === 1) {
    console.log(JSON.stringify(msg.result?.result?.value ?? msg.result ?? msg, null, 2));
    process.exit(0);
  }
});
setTimeout(() => process.exit(1), 5000);
