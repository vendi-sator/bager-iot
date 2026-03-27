/**
 * BAGER IoT — Node.js Backend v1.2.0
 * + ruka4, svjetlo, temperatura
 */

const WebSocket = require("ws");
const mqtt      = require("mqtt");
const http      = require("http");
const fs        = require("fs");
const path      = require("path");

const PORT      = process.env.PORT      || 3000;
const API_TOKEN = process.env.API_TOKEN || "dev-token-insecure";
const MQTT_HOST = process.env.MQTT_HOST || "365e11b3797543a59f900b24b7046974.s1.eu.hivemq.cloud";
const MQTT_PORT = process.env.MQTT_PORT || 8883;
const MQTT_USER = process.env.MQTT_USER || "bager_esp32";
const MQTT_PASS = process.env.MQTT_PASS || "Esp32#2025!";

const TOPICS = {
  gusjenica_lijevo : "profesor/bager/motor_gusjenica_lijevo",
  gusjenica_desno  : "profesor/bager/motor_gusjenica_desno",
  ruka1            : "profesor/bager/motor_ruka1",
  ruka2            : "profesor/bager/motor_ruka2",
  ruka3            : "profesor/bager/motor_ruka3",
  ruka4            : "profesor/bager/motor_ruka4",
  rotacija         : "profesor/bager/motor_rotacija",
  servo_kasika     : "profesor/bager/servo_kasika",
  svjetlo          : "profesor/bager/svjetlo",
};

const TOPIC_STATUS = "bager/status";
const TOPIC_TEMP   = "profesor/bager/temperatura";

// ── HTTP SERVER ────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("index.html not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

// ── WEBSOCKET ──────────────────────────────────────────
const wss     = new WebSocket.Server({ server: httpServer });
const clients = new Set();

function broadcast(msg) {
  const str = JSON.stringify(msg);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

wss.on("connection", (ws, req) => {
  const url   = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");

  if (token !== API_TOKEN) {
    ws.close(4001, "Unauthorized");
    console.warn("[WS] Odbijen klijent — pogrešan token.");
    return;
  }

  clients.add(ws);
  console.log(`[WS] Novi klijent. Ukupno: ${clients.size}`);

  ws.send(JSON.stringify({
    type        : "init",
    mqtt        : mqttConnected,
    bager       : bagerOnline,
    temperatura : zadnjaTemp,
  }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case "motor_command": {
        const topic = TOPICS[msg.motorId];
        if (!topic || !mqttConnected) return;
        mqttClient.publish(topic, JSON.stringify({ value: msg.value }), { qos: 1 });
        break;
      }

      case "emergency_stop": {
        Object.entries(TOPICS).forEach(([key, topic]) => {
          const val = key === "servo_kasika" ? 90 : key === "svjetlo" ? 0 : 0;
          mqttClient.publish(topic, JSON.stringify({ value: val }), { qos: 1 });
        });
        broadcast({ type: "emergency_stop" });
        console.log("[WS] ⚠ EMERGENCY STOP!");
        break;
      }

      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WS] Klijent odspojen. Ukupno: ${clients.size}`);
  });
});

// ── MQTT ───────────────────────────────────────────────
let mqttConnected = false;
let bagerOnline   = false;
let zadnjaTemp    = null;

console.log("[MQTT] Spajanje na broker...");

const mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username          : MQTT_USER,
  password          : MQTT_PASS,
  rejectUnauthorized: false,
});

mqttClient.on("connect", () => {
  mqttConnected = true;
  console.log("[MQTT] ✓ Spojen!");
  mqttClient.subscribe(TOPIC_STATUS, { qos: 1 });
  mqttClient.subscribe(TOPIC_TEMP,   { qos: 0 });
  broadcast({ type: "mqtt_status", connected: true });
});

mqttClient.on("error",     (err) => console.error("[MQTT] Greška:", err.message));
mqttClient.on("reconnect", ()    => { mqttConnected = false; broadcast({ type: "mqtt_status", connected: false }); });

mqttClient.on("message", (topic, payload) => {
  try {
    const data = JSON.parse(payload.toString());

    if (topic === TOPIC_STATUS) {
      bagerOnline = data.status === "online";
      broadcast({ type: "bager_status", online: bagerOnline, data });
      console.log("[MQTT] Bager:", data.status);
    }

    if (topic === TOPIC_TEMP) {
      zadnjaTemp = data;
      broadcast({ type: "temperatura", temp: data.temp, hum: data.hum });
      console.log(`[MQTT] Temp: ${data.temp}°C | Vlaga: ${data.hum}%`);
    }
  } catch (e) {}
});

// Heartbeat
setInterval(() => {
  broadcast({ type: "heartbeat", bager: bagerOnline, mqtt: mqttConnected, temperatura: zadnjaTemp });
}, 10000);

// ── START ──────────────────────────────────────────────
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] ✓ Pokrenut na portu ${PORT}`);
});
