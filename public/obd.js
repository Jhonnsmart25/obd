'use strict';
// Lógica OBD-II: decodifica respuestas del adaptador ELM327 y simula uno para el Modo Demo.
// Se usa en el navegador (self.OBD) y en las pruebas (require). Es SOLO LECTURA: no borra ni escribe nada en el auto.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OBD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var LETTERS = ['P', 'C', 'B', 'U'];

  // 2 bytes -> "P0301"
  function dtcFromBytes(b1, b2) {
    var letter = LETTERS[(b1 >> 6) & 3];
    var d1 = (b1 >> 4) & 3;
    return letter + d1.toString(16).toUpperCase() + (b1 & 15).toString(16).toUpperCase() +
      ((b2 >> 4) & 15).toString(16).toUpperCase() + (b2 & 15).toString(16).toUpperCase();
  }

  // Respuesta del modo 03 (códigos guardados), después del encabezado 43:
  //   CAN (isCan = true):    "43 01 03 01 00 00 00"  -> 1 byte de cantidad y luego pares de bytes
  //   CAN, varios cuadros:   "0: 43 02 03 01 1: 04 20 .."
  //   Protocolos antiguos (isCan = false): "43 03 01 04 20 00 00" -> pares de bytes sin cantidad
  function decodeDtcResponse(text, isCan) {
    if (isCan === undefined) isCan = true; // casi todos los autos desde 2008 usan CAN
    var lines = String(text || '').toUpperCase().split(/[\r\n]+/).map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !/^(SEARCHING|BUS INIT|OK|>)/.test(l) && l.indexOf('NO DATA') < 0; });
    var out = [];
    var multi = [];
    var payloads = [];
    lines.forEach(function (line) {
      var hex = line.replace(/\d+:/g, ' ').replace(/[^0-9A-F]/g, '');
      var parts = hex.match(/../g) || [];
      if (/^\d:/.test(line)) { multi = multi.concat(parts); return; }
      var i = parts.indexOf('43');
      if (i >= 0) payloads.push(parts.slice(i + 1));
    });
    var mi = multi.indexOf('43');
    if (mi >= 0) payloads.push(multi.slice(mi + 1));
    payloads.forEach(function (p) {
      if (isCan) p = p.slice(1); // CAN: el primer byte es la cantidad de códigos
      for (var k = 0; k + 1 < p.length; k += 2) {
        var a = parseInt(p[k], 16), b = parseInt(p[k + 1], 16);
        if (isNaN(a) || isNaN(b) || (a === 0 && b === 0)) continue;
        var code = dtcFromBytes(a, b);
        if (out.indexOf(code) < 0) out.push(code);
      }
    });
    return out;
  }

  // "41 0C 1A F8" -> RPM
  function parsePid(text, pid) {
    var hex = String(text || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    var i = hex.indexOf('41' + pid);
    if (i < 0) return null;
    var d = hex.slice(i + 4);
    var a = parseInt(d.slice(0, 2), 16), b = parseInt(d.slice(2, 4), 16);
    if (pid === '0C') return isNaN(b) ? null : Math.round((a * 256 + b) / 4);
    if (pid === '05') return isNaN(a) ? null : a - 40;
    if (pid === '0D') return isNaN(a) ? null : a;
    return null;
  }

  // Devuelve la gravedad más alta de una lista de códigos traducidos
  var ORDER = { verde: 1, amarillo: 2, rojo: 3 };
  function worst(items) {
    return items.reduce(function (w, it) { return ORDER[it.gravedad] > ORDER[w] ? it.gravedad : w; }, 'verde');
  }

  // Traduce un código usando la base JSON; si no existe, usa el genérico de su letra
  function translate(code, db) {
    var c = String(code || '').toUpperCase();
    var hit = db.codes[c];
    if (hit) return Object.assign({ codigo: c, conocido: true }, hit);
    var g = db.genericos[c.charAt(0)] || db.genericos.P;
    return Object.assign({ codigo: c, conocido: false }, g);
  }

  /* ---------- Simulador: responde como lo haría un ELM327 ---------- */
  var SCENARIOS = {
    sano: { nombre: 'Auto sano', detalle: 'Sin fallas guardadas', dtcs: [], rpm: 800, temp: 90 },
    tapa: { nombre: 'Luz de motor encendida', detalle: 'Fuga mínima de vapores (P0456)', dtcs: ['P0456'], rpm: 780, temp: 88 },
    varios: { nombre: 'Varias fallas', detalle: 'P0420, P0171 y P0301', dtcs: ['P0420', 'P0171', 'P0301'], rpm: 900, temp: 95 },
    grave: { nombre: 'Falla seria', detalle: 'P0300 y P0335', dtcs: ['P0300', 'P0335'], rpm: 1100, temp: 102 },
  };

  function encodeDtc(code) {
    var l = LETTERS.indexOf(code.charAt(0));
    var d1 = parseInt(code.charAt(1), 16);
    var b1 = (l << 6) | (d1 << 4) | parseInt(code.charAt(2), 16);
    var b2 = (parseInt(code.charAt(3), 16) << 4) | parseInt(code.charAt(4), 16);
    var h = function (n) { return (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); };
    return h(b1) + ' ' + h(b2);
  }

  function hex2(n) { n = Math.max(0, Math.round(n)); return (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); }

  // Transporte de simulación. Misma interfaz que el de Bluetooth: send(cmd) -> Promise<string>
  function SimTransport(scenarioKey) {
    var sc = SCENARIOS[scenarioKey] || SCENARIOS.sano;
    return {
      name: 'Simulador · ' + sc.nombre,
      simulated: true,
      connect: function () { return Promise.resolve(); },
      close: function () { return Promise.resolve(); },
      send: function (cmd) {
        var c = String(cmd).replace(/\s+/g, '').toUpperCase();
        var wait = function (v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 180); }); };
        if (c === 'ATZ') return wait('ELM327 v1.5 (simulado)');
        if (c.indexOf('AT') === 0) return wait('OK');
        if (c === '0100') return wait('41 00 BE 3E B8 11');
        if (c === 'ATDPN') return wait('A6');
        if (c === '03') {
          if (!sc.dtcs.length) return wait('43 00');
          var body = sc.dtcs.map(encodeDtc).join(' ');
          return wait('43 ' + hex2(sc.dtcs.length) + ' ' + body);
        }
        if (c === '010C') return wait('41 0C ' + hex2((sc.rpm * 4) >> 8) + ' ' + hex2((sc.rpm * 4) & 255));
        if (c === '0105') return wait('41 05 ' + hex2(sc.temp + 40));
        if (c === '010D') return wait('41 0D 00');
        return wait('NO DATA');
      },
    };
  }

  /* ---------- Bluetooth LE (Web Bluetooth) con adaptadores ELM327 BLE ---------- */
  // Los adaptadores BLE usan servicios distintos según el fabricante
  var BLE_PROFILES = [
    { service: 0xfff0, notify: 0xfff1, write: 0xfff2 },
    { service: 0xffe0, notify: 0xffe1, write: 0xffe1 },
    { service: '000018f0-0000-1000-8000-00805f9b34fb', notify: '00002af0-0000-1000-8000-00805f9b34fb', write: '00002af1-0000-1000-8000-00805f9b34fb' },
  ];

  function BleTransport() {
    var device, writeChar, buffer = '', waiting = null;
    var enc = new TextEncoder(), dec = new TextDecoder();
    function onData(e) {
      buffer += dec.decode(e.target.value);
      if (buffer.indexOf('>') >= 0 && waiting) { var w = waiting; waiting = null; var out = buffer.replace('>', '').trim(); buffer = ''; clearTimeout(w.t); w.resolve(out); }
    }
    return {
      name: 'Adaptador Bluetooth',
      simulated: false,
      connect: async function () {
        if (!navigator.bluetooth) throw new Error('Este navegador no permite Bluetooth. Usa Chrome en Android.');
        device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: BLE_PROFILES.map(function (p) { return p.service; }),
        });
        this.name = device.name || 'Adaptador Bluetooth';
        var server = await device.gatt.connect();
        for (var i = 0; i < BLE_PROFILES.length; i++) {
          var p = BLE_PROFILES[i];
          try {
            var svc = await server.getPrimaryService(p.service);
            var notify = await svc.getCharacteristic(p.notify);
            writeChar = p.write === p.notify ? notify : await svc.getCharacteristic(p.write);
            await notify.startNotifications();
            notify.addEventListener('characteristicvaluechanged', onData);
            return;
          } catch (e) { /* prueba el siguiente perfil */ }
        }
        throw new Error('No reconocimos este adaptador. Necesita ser un ELM327 con Bluetooth de bajo consumo (BLE).');
      },
      close: async function () { try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) { /* nada */ } },
      send: function (cmd) {
        return new Promise(function (resolve, reject) {
          if (!writeChar) return reject(new Error('Adaptador no conectado.'));
          buffer = '';
          var t = setTimeout(function () { waiting = null; reject(new Error('El auto no respondió a tiempo.')); }, 9000);
          waiting = { resolve: resolve, t: t };
          writeChar.writeValue(enc.encode(cmd + '\r')).catch(function (e) { clearTimeout(t); waiting = null; reject(e); });
        });
      },
    };
  }

  // Lectura completa: inicia el adaptador y pide los códigos guardados (modo 03, solo lectura)
  async function readAll(transport, onStep) {
    var step = onStep || function () {};
    step('Preparando el adaptador…');
    for (var cmd of ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']) await transport.send(cmd);
    step('Conectando con la computadora del auto…');
    await transport.send('0100'); // el adaptador busca el protocolo del auto
    var proto = String(await transport.send('ATDPN')).replace(/[^0-9A-F]/gi, '').slice(-1);
    var isCan = proto ? parseInt(proto, 16) >= 6 : true; // protocolos 6 a 9 son CAN
    step('Leyendo las fallas guardadas…');
    var raw = await transport.send('03');
    var codes = decodeDtcResponse(raw, isCan);
    var live = {};
    try {
      step('Leyendo datos del motor…');
      live.rpm = parsePid(await transport.send('010C'), '0C');
      live.temp = parsePid(await transport.send('0105'), '05');
    } catch (e) { /* los datos en vivo son un extra */ }
    return { codes: codes, live: live };
  }

  return {
    dtcFromBytes: dtcFromBytes, decodeDtcResponse: decodeDtcResponse, parsePid: parsePid, translate: translate, worst: worst,
    SCENARIOS: SCENARIOS, SimTransport: SimTransport, BleTransport: BleTransport, readAll: readAll, encodeDtc: encodeDtc,
  };
});
