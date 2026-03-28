// Backend server za bager - WebSocket + MQTT bridge


const WebSocket = require("ws");
const mqtt      = require("mqtt");
const http      = require("http");
const fs        = require("fs");
const path      = require("path");

// Konfiguracija - sve iz environment varijabli da ne stoji hardcoded
const PORT      = process.env.PORT      || 3000;
const API_TOKEN = process.env.API_TOKEN || "dev-token-insecure";
const MQTT_HOST = process.env.MQTT_HOST || "365e11b3797543a59f900b24b7046974.s1.eu.hivemq.cloud";
const MQTT_PORT = process.env.MQTT_PORT || 8883;
const MQTT_USER = process.env.MQTT_USER || "bager_esp32";
const MQTT_PASS = process.env.MQTT_PASS || "Esp32#2025!";

// MQTT topici - svaki motor/aktuator ima svoj topic
const TOPICS = {
  gusjenica_lijevo : "bager/motor/gusjenica_lijevo",
  gusjenica_desno  : "bager/motor/gusjenica_desno",
  ruka1            : "bager/motor/ruka1",
  ruka2            : "bager/motor/ruka2",
  ruka3            : "bager/motor/ruka3",
  ruka4            : "bager/motor/ruka4",
  rotacija         : "bager/motor/rotacija",
  servo_kasika     : "bager/servo/kasika",
  svjetlo          : "bager/svjetlo",
};

const TOPIC_STATUS = "bager/status";
const TOPIC_TEMP   = "bager/temperatura";

// HTTP server koji servira index.html
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("index.html not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

// WebSocket server na istom portu kao HTTP
const wss     = new WebSocket.Server({ server: httpServer });
const clients = new Set();

// Šalje poruku svim spojenim klijentima
function broadcast(msg) {
  const str = JSON.stringify(msg);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

wss.on("connection", (ws, req) => {
  // Provjera tokena - odbij ako ne odgovara
  const url   = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");

  if (token !== API_TOKEN) {
    ws.close(4001, "Unauthorized");
    console.warn("[WS] Odbijen klijent — pogrešan token.");
    return;
  }

  clients.add(ws);
  console.log(`[WS] Novi klijent. Ukupno: ${clients.size}`);

  // Pošalji trenutno stanje novom klijentu
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

      // Komanda za motor - prosljeđujemo na MQTT broker
      case "motor_command": {
        const topic = TOPICS[msg.motorId];
        if (!topic || !mqttConnected) return;
        mqttClient.publish(topic, JSON.stringify({ value: msg.value }), { qos: 1 });
        break;
      }

      // Emergency stop - sve na nulu odmah
      case "emergency_stop": {
        Object.entries(TOPICS).forEach(([key, topic]) => {
          const val = key === "servo_kasika" ? 90 : 0;
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

// MQTT konekcija na HiveMQ Cloud
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
  // Pratimo status bagera i temperaturu
  mqttClient.subscribe(TOPIC_STATUS, { qos: 1 });
  mqttClient.subscribe(TOPIC_TEMP,   { qos: 0 });
  broadcast({ type: "mqtt_status", connected: true });
});

mqttClient.on("error",     (err) => console.error("[MQTT] Greška:", err.message));
mqttClient.on("reconnect", ()    => {
  mqttConnected = false;
  broadcast({ type: "mqtt_status", connected: false });
});

// Primanje poruka od ESP32
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

// Heartbeat svakih 10s da frontend zna je li bager još online
setInterval(() => {
  broadcast({ type: "heartbeat", bager: bagerOnline, mqtt: mqttConnected, temperatura: zadnjaTemp });
}, 10000);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] ✓ Pokrenut na portu ${PORT}`);
});
