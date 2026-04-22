#!/usr/bin/env node
// rclaw — RemoteClaw CLI

const http = require("http");

const SERVER = "https://remote.momomo.dev";
const TOKEN = "rclaw-4847bbe08bda2c785f4e4e6bc05e4815";
const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 7890;
const CHUNK_SIZE = 512 * 1024; // 512KB per chunk

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = `${SERVER}${path}`;
    const headers = { Host: new URL(SERVER).hostname, Authorization: `Bearer ${TOKEN}` };
    if (body) { headers["Content-Type"] = "application/json"; }
    const data = body ? JSON.stringify(body) : null;
    if (data) headers["Content-Length"] = Buffer.byteLength(data);

    const req = http.request({
      hostname: PROXY_HOST, port: PROXY_PORT, method,
      path: url, headers, timeout: 60000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "-h") {
    console.log(`rclaw — RemoteClaw CLI

Usage:
  rclaw devices                     List online devices
  rclaw exec <device> <command>     Execute command (sync, waits for result)
  rclaw exec <device> -a <command>  Execute command (async, returns taskId)
  rclaw task <taskId>               Check async task status
  rclaw shell [device]               Interactive shell (TUI)
  rclaw push <local-file> <device>:<remote-path>   Push file to device
  rclaw pull <device>:<remote-path> <local-file>   Pull file from device
  rclaw history [limit]             Command history`);
    return;
  }

  if (cmd === "devices" || cmd === "d") {
    const { data } = await api("GET", "/devices");
    if (!Array.isArray(data) || !data.length) { console.log("No devices online"); return; }
    for (const d of data) {
      const dur = d.connectedFor < 60 ? `${d.connectedFor}s` : d.connectedFor < 3600 ? `${Math.floor(d.connectedFor/60)}m` : `${Math.floor(d.connectedFor/3600)}h`;
      console.log(`  ${d.name}  [${(d.capabilities||[]).join(",")}]  up ${dur}`);
    }
    return;
  }

  if (cmd === "exec" || cmd === "e") {
    const device = args[1];
    if (!device) { console.error("Usage: rclaw exec <device> <command>"); process.exit(1); }
    const async_ = args[2] === "-a";
    const command = (async_ ? args.slice(3) : args.slice(2)).join(" ");
    if (!command) { console.error("Usage: rclaw exec <device> <command>"); process.exit(1); }

    const { data } = await api("POST", "/exec", {
      device, command, oneshot: !async_, timeout: 55000,
    });

    if (data.error) { console.error("Error:", data.error); process.exit(1); }

    if (async_) {
      console.log(`Task: ${data.taskId}  Status: ${data.status}`);
      return;
    }

    // Sync result
    if (data.stdout) process.stdout.write(data.stdout);
    if (data.stderr) process.stderr.write(data.stderr);
    process.exit(data.exitCode || 0);
  }

  if (cmd === "task" || cmd === "t") {
    const id = args[1];
    if (!id) { console.error("Usage: rclaw task <taskId>"); process.exit(1); }
    const { data } = await api("GET", `/task/${id}`);
    if (data.error) { console.error("Error:", data.error); process.exit(1); }
    console.log(`Status: ${data.status}  Exit: ${data.exitCode}`);
    if (data.stdout) process.stdout.write(data.stdout);
    if (data.stderr) process.stderr.write(data.stderr);
    return;
  }

  if (cmd === "history" || cmd === "h") {
    const limit = args[1] || 20;
    const { data } = await api("GET", `/history?limit=${limit}`);
    if (!Array.isArray(data) || !data.length) { console.log("No history"); return; }
    for (const h of data) {
      const dur = h.duration ? `${(h.duration/1000).toFixed(1)}s` : "—";
      const time = new Date(h.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      console.log(`  ${time}  ${h.device}  ${h.status}  ${dur}  ${h.command.slice(0,60)}`);
    }
    return;
  }

  if (cmd === "shell" || cmd === "s") {
    await shell(args[1]);
    return;
  }

  if (cmd === "push") {
    await pushFile(args[1], args[2]);
    return;
  }

  if (cmd === "pull") {
    await pullFile(args[1], args[2]);
    return;
  }

  console.error(`Unknown command: ${cmd}. Run 'rclaw help' for usage.`);
  process.exit(1);
}

async function shell(deviceArg) {
  const readline = require("readline");

  // Pick device
  let device = deviceArg;
  if (!device) {
    const { data } = await api("GET", "/devices");
    if (!Array.isArray(data) || !data.length) { console.log("No devices online"); return; }
    if (data.length === 1) {
      device = data[0].id;
    } else {
      console.log("Online devices:");
      data.forEach((d, i) => console.log(`  ${i + 1}) ${d.name}  [${(d.capabilities||[]).join(",")}]`));
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const choice = await new Promise(r => rl.question("Select device [1]: ", a => { rl.close(); r(a); }));
      const idx = parseInt(choice || "1") - 1;
      device = data[idx]?.id || data[0].id;
    }
  }

  console.log(`Connected to \x1b[36m${device}\x1b[0m. Type commands, 'exit' to quit, Ctrl+C to abort.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `\x1b[36m${device}\x1b[0m$ `,
    historySize: 100,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const cmd = line.trim();
    if (!cmd) { rl.prompt(); return; }
    if (cmd === "exit" || cmd === "quit") { rl.close(); return; }
    if (cmd === "clear") { console.clear(); rl.prompt(); return; }
    if (cmd === "devices") {
      const { data } = await api("GET", "/devices");
      if (Array.isArray(data)) data.forEach(d => console.log(`  ${d.name}  up ${d.connectedFor}s`));
      rl.prompt(); return;
    }
    if (cmd.startsWith("switch ")) {
      device = cmd.slice(7).trim();
      rl.setPrompt(`\x1b[36m${device}\x1b[0m$ `);
      console.log(`Switched to ${device}`);
      rl.prompt(); return;
    }

    try {
      const { data } = await api("POST", "/exec", { device, command: cmd, oneshot: true, timeout: 55000 });
      if (data.error) { console.error(`\x1b[31m${data.error}\x1b[0m`); }
      else {
        if (data.stdout) process.stdout.write(data.stdout);
        if (data.stderr) process.stderr.write(`\x1b[31m${data.stderr}\x1b[0m`);
        const dur = data.completedAt && data.createdAt ? ((data.completedAt - data.createdAt) / 1000).toFixed(1) : null;
        if (data.exitCode !== 0) console.log(`\x1b[33mexit ${data.exitCode}${dur ? " · " + dur + "s" : ""}\x1b[0m`);
      }
    } catch (e) {
      console.error(`\x1b[31m${e.message}\x1b[0m`);
    }
    rl.prompt();
  });

  rl.on("close", () => { console.log(); process.exit(0); });
}

main().catch((e) => { console.error(e.message); process.exit(1); });

// ── File Transfer ──

async function pushFile(localPath, target) {
  if (!localPath || !target || !target.includes(":")) {
    console.error("Usage: rclaw push <local-file> <device>:<remote-path>");
    process.exit(1);
  }
  const [device, remotePath] = [target.split(":")[0], target.split(":").slice(1).join(":")];
  const fs = require("fs");
  const path = require("path");

  if (!fs.existsSync(localPath)) { console.error(`File not found: ${localPath}`); process.exit(1); }
  const stat = fs.statSync(localPath);
  const totalSize = stat.size;
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
  const filename = path.basename(localPath);

  console.log(`Pushing ${filename} (${(totalSize / 1024 / 1024).toFixed(1)}MB) to ${device}:${remotePath}`);
  console.log(`${totalChunks} chunks @ ${CHUNK_SIZE / 1024}KB each`);

  // Upload chunks to Worker
  const fd = fs.openSync(localPath, "r");
  const buf = Buffer.alloc(CHUNK_SIZE);
  let transferId = null;

  for (let i = 0; i < totalChunks; i++) {
    const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, i * CHUNK_SIZE);
    const chunk = buf.slice(0, bytesRead).toString("base64");
    const { data } = await api("POST", "/transfer/upload", {
      filename, chunk, chunkIndex: i, totalChunks, totalSize,
      transferId: transferId || undefined,
    });
    if (data.error) { console.error("Upload error:", data.error); process.exit(1); }
    if (!transferId) transferId = data.transferId;
    process.stdout.write(`\r  chunk ${i + 1}/${totalChunks}`);
  }
  fs.closeSync(fd);
  console.log("\n  uploaded to relay.");

  // Tell target device to download from relay
  const { data: devicesData } = await api("GET", "/devices");
  const conn = Array.isArray(devicesData) && devicesData.find(d => d.name === device || d.id === device);
  if (!conn) { console.error(`Device ${device} not connected. Transfer ${transferId} available for 5 min.`); return; }

  // Send download command via exec
  const { data: execData } = await api("POST", "/exec", {
    device, command: `__RCLAW_DOWNLOAD__ ${transferId} ${remotePath} ${totalChunks}`, oneshot: false, timeout: 300000,
  });
  console.log(`  download requested on ${device} (task: ${execData.taskId || "sent"})`);
  console.log(`  transfer: ${transferId}`);
}

async function pullFile(source, localPath) {
  if (!source || !source.includes(":") || !localPath) {
    console.error("Usage: rclaw pull <device>:<remote-path> <local-file>");
    process.exit(1);
  }
  const [device, remotePath] = [source.split(":")[0], source.split(":").slice(1).join(":")];
  const fs = require("fs");
  const path = require("path");

  console.log(`Pulling ${device}:${remotePath} -> ${localPath}`);

  // Tell device to upload the file
  const { data } = await api("POST", "/transfer/push", { device, remotePath });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  const transferId = data.transferId;
  console.log(`  upload requested (transfer: ${transferId})`);

  // Poll until transfer is complete
  let info;
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    const { data: infoData } = await api("GET", `/transfer/info/${transferId}`);
    if (infoData.error) continue;
    info = infoData;
    if (info.chunks > 0 && info.chunks >= Math.ceil(info.total_size / CHUNK_SIZE)) break;
    process.stdout.write(`\r  waiting... ${info.chunks || 0} chunks`);
  }

  if (!info || !info.chunks) { console.error("\n  Transfer timed out or failed"); process.exit(1); }
  const totalChunks = Math.ceil(info.total_size / CHUNK_SIZE);
  console.log(`\n  downloading ${totalChunks} chunks...`);

  // Download chunks
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(localPath, "w");

  for (let i = 0; i < totalChunks; i++) {
    const { data: chunkData } = await api("GET", `/transfer/download/${transferId}?chunk=${i}`);
    if (chunkData.error) { console.error(`\n  chunk ${i} error: ${chunkData.error}`); process.exit(1); }
    const buf = Buffer.from(chunkData.chunk, "base64");
    fs.writeSync(fd, buf, 0, buf.length);
    process.stdout.write(`\r  chunk ${i + 1}/${totalChunks}`);
  }
  fs.closeSync(fd);
  console.log(`\n  done: ${localPath} (${(info.total_size / 1024 / 1024).toFixed(1)}MB)`);
}
