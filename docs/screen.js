// RemoteClaw Screen — screenshot stream + remote input
(() => {
  const $ = (s) => document.querySelector(s);
  const canvas = $("#screen-canvas");
  const ctx = canvas.getContext("2d");
  const wrap = $("#canvas-wrap");

  let ws = null;
  let streaming = false;
  let deviceName = "";
  let frameCount = 0;
  let lastFrameTime = 0;
  let currentFps = 0;
  let frameBytes = 0;

  // ── Connection ──

  $("#btn-connect").addEventListener("click", toggleConnect);
  $("#btn-start").addEventListener("click", startStream);
  $("#btn-stop").addEventListener("click", stopStream);

  function toggleConnect() {
    if (ws && ws.readyState <= 1) {
      ws.close();
      return;
    }
    const server = $("#server-url").value.trim();
    const token = $("#token").value.trim();
    if (!server || !token) return;

    setStatus("connecting");
    // Connect as a "viewer" device
    const viewerId = "viewer-" + Math.random().toString(36).slice(2, 8);
    ws = new WebSocket(`${server}/ws?device=${viewerId}&token=${encodeURIComponent(token)}`);

    ws.onopen = () => {
      setStatus("connected");
      $("#btn-connect").textContent = "Disconnect";
      // Fetch device list
      fetch(`${server.replace("wss://", "https://").replace("ws://", "http://")}/devices`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((devices) => {
          const sel = $("#device-select");
          sel.innerHTML = '<option value="">—</option>';
          devices.forEach((d) => {
            if (d.id.startsWith("viewer-")) return; // skip other viewers
            const opt = document.createElement("option");
            opt.value = d.id;
            opt.textContent = d.name || d.id;
            sel.appendChild(opt);
          });
          $("#btn-start").disabled = false;
        })
        .catch(() => {});
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "screen-frame") onFrame(msg);
      } catch {}
    };

    ws.onclose = () => {
      setStatus("disconnected");
      $("#btn-connect").textContent = "Connect";
      $("#btn-start").disabled = true;
      $("#btn-stop").disabled = true;
      streaming = false;
      wrap.classList.remove("interactive");
    };

    ws.onerror = () => ws.close();
  }

  // ── Streaming ──

  function startStream() {
    deviceName = $("#device-select").value;
    if (!deviceName || !ws) return;

    const fps = parseInt($("#fps-select").value);
    const quality = parseInt($("#quality-select").value);

    ws.send(JSON.stringify({
      type: "screen-start",
      to: deviceName,
      sessionId: "screen-" + Date.now(),
      fps,
      quality,
    }));

    streaming = true;
    frameCount = 0;
    frameBytes = 0;
    lastFrameTime = Date.now();
    $("#btn-start").disabled = true;
    $("#btn-stop").disabled = false;
    $("#stats").style.display = "block";
    wrap.classList.add("interactive");
    setStatus("streaming");
    bindInput();
  }

  function stopStream() {
    if (!ws || !deviceName) return;
    ws.send(JSON.stringify({
      type: "screen-stop",
      to: deviceName,
      sessionId: "screen-" + Date.now(),
    }));
    streaming = false;
    $("#btn-start").disabled = false;
    $("#btn-stop").disabled = true;
    wrap.classList.remove("interactive");
    setStatus("connected");
    unbindInput();
  }

  // ── Frame rendering ──

  const img = new Image();
  img.onload = () => {
    if (canvas.width !== img.width || canvas.height !== img.height) {
      canvas.width = img.width;
      canvas.height = img.height;
    }
    ctx.drawImage(img, 0, 0);
  };

  function onFrame(msg) {
    frameCount++;
    const now = Date.now();
    const dt = now - lastFrameTime;
    if (dt > 0) currentFps = (0.8 * currentFps + 0.2 * (1000 / dt));
    lastFrameTime = now;
    frameBytes = msg.data.length * 0.75; // approx decoded size

    // Update stats
    const kb = (frameBytes / 1024).toFixed(0);
    const bw = ((frameBytes * currentFps) / 1024).toFixed(0);
    $("#stats").textContent = `${currentFps.toFixed(1)} fps · ${kb} KB/frame · ${bw} KB/s`;

    // Render
    img.src = "data:image/jpeg;base64," + msg.data;
  }

  // ── Input handling ──

  let inputBound = false;
  const handlers = {};

  function bindInput() {
    if (inputBound) return;
    inputBound = true;

    handlers.mousedown = (e) => sendMouse("mousedown", e);
    handlers.mouseup = (e) => sendMouse("mouseup", e);
    handlers.mousemove = (e) => {
      if (e.buttons > 0) sendMouse("mousemove", e); // only during drag
    };
    handlers.click = (e) => sendMouse("click", e);
    handlers.dblclick = (e) => sendMouse("doubleclick", e);
    handlers.contextmenu = (e) => { e.preventDefault(); sendMouse("rightclick", e); };
    handlers.wheel = (e) => {
      e.preventDefault();
      sendInput({ action: "scroll", deltaY: e.deltaY });
    };

    canvas.addEventListener("mousedown", handlers.mousedown);
    canvas.addEventListener("mouseup", handlers.mouseup);
    canvas.addEventListener("mousemove", handlers.mousemove);
    canvas.addEventListener("dblclick", handlers.dblclick);
    canvas.addEventListener("contextmenu", handlers.contextmenu);
    canvas.addEventListener("wheel", handlers.wheel, { passive: false });

    // Keyboard — capture on document level
    handlers.keydown = (e) => {
      if (!streaming) return;
      e.preventDefault();
      sendInput({ action: "keydown", key: e.key });
    };
    handlers.keyup = (e) => {
      if (!streaming) return;
      e.preventDefault();
      sendInput({ action: "keyup", key: e.key });
    };
    document.addEventListener("keydown", handlers.keydown);
    document.addEventListener("keyup", handlers.keyup);
  }

  function unbindInput() {
    if (!inputBound) return;
    inputBound = false;
    canvas.removeEventListener("mousedown", handlers.mousedown);
    canvas.removeEventListener("mouseup", handlers.mouseup);
    canvas.removeEventListener("mousemove", handlers.mousemove);
    canvas.removeEventListener("dblclick", handlers.dblclick);
    canvas.removeEventListener("contextmenu", handlers.contextmenu);
    canvas.removeEventListener("wheel", handlers.wheel);
    document.removeEventListener("keydown", handlers.keydown);
    document.removeEventListener("keyup", handlers.keyup);
  }

  function sendMouse(action, e) {
    const rect = canvas.getBoundingClientRect();
    // Map canvas display coords to actual screen coords
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    sendInput({ action, x, y, button: e.button === 2 ? "right" : "left" });
  }

  function sendInput(data) {
    if (!ws || !streaming || !deviceName) return;
    ws.send(JSON.stringify({
      type: "screen-input",
      to: deviceName,
      ...data,
    }));
  }

  // ── Status ──

  function setStatus(s) {
    const dot = $("#status-dot");
    const text = $("#status-text");
    dot.className = "status-dot";
    if (s === "connected") { dot.classList.add("on"); text.textContent = "Connected"; }
    else if (s === "streaming") { dot.classList.add("streaming"); text.textContent = "Streaming"; }
    else if (s === "connecting") { text.textContent = "Connecting..."; }
    else { text.textContent = "Disconnected"; }
  }

  // ── Keyboard shortcut: Escape to stop ──
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && streaming) stopStream();
  });
})();
