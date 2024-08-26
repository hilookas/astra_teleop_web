function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

const pedalCommTarget = new EventTarget();
const controlCommTarget = new EventTarget();

async function start() {
  document.getElementById('start').classList.add("hidden");
  document.getElementById('status').innerHTML = "Connecting...";

  const pc = new RTCPeerConnection({
    sdpSemantics: 'unified-plan'
  });

  // connect audio / video
  pc.addEventListener('track', function (evt) {
    if (evt.track.kind === 'video') {
      if (evt.transceiver.mid === '0') {
        document.getElementById('video-head').srcObject = new MediaStream([evt.track]);
        document.getElementById('video-head').play();
      } else if (evt.transceiver.mid === '1') {
        document.getElementById('video-wrist-left').srcObject = new MediaStream([evt.track]);
        document.getElementById('video-wrist-left').play();
      } else if (evt.transceiver.mid === '2') {
        document.getElementById('video-wrist-right').srcObject = new MediaStream([evt.track]);
        document.getElementById('video-wrist-right').play();
      } else {
        console.error("Unsupported mid")
      }
    }
  });

  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });

  const pedalChannel = pc.createDataChannel("pedal")
  const controlChannel = pc.createDataChannel("control")

  const toServerCb = async function (evt) {
    pedalChannel.send(evt.detail)
  }

  pedalChannel.addEventListener('open', function (evt) {
    pedalCommTarget.addEventListener('toServer', toServerCb);

    pedalChannel.addEventListener('message', function (evt) {
      pedalCommTarget.dispatchEvent(new CustomEvent("fromServer", { detail: evt.data }))
    })
  })

  pedalChannel.addEventListener('close', function (evt) {
    pedalCommTarget.removeEventListener('toServer', toServerCb);
  })

  const controlToServerCb = async function (evt) {
    controlChannel.send(evt.detail)
  }

  controlChannel.addEventListener('open', function (evt) {
    controlCommTarget.addEventListener('toServer', controlToServerCb);

    controlChannel.addEventListener('message', function (evt) {
      controlCommTarget.dispatchEvent(new CustomEvent("fromServer", { detail: evt.data }))
    })
  })

  controlChannel.addEventListener('close', function (evt) {
    controlCommTarget.removeEventListener('toServer', controlToServerCb);
  })

  // Display statistics
  const showPing = async () => {
    const results = await pc.getStats(null)
    
    results.forEach(res => {
      if (res.type === "candidate-pair" && res.nominated) {
        document.getElementById('pc-ping').innerHTML = res.currentRoundTripTime * 1000;
      }
    });
  }
  setInterval(showPing, 1000);

  pc.addEventListener('connectionstatechange', () => {
    document.getElementById('pc-status').innerHTML = pc.connectionState;
    if (pc.connectionState === 'connected') {
      document.getElementById('status').innerHTML = 'Connected.';
      document.getElementById('player').classList.remove("hidden");
    } else if (pc.connectionState === 'disconnected') {
      document.getElementById('status').innerHTML = `Lost connection.`;
      clearInterval(showPing)
      document.getElementById('pc-ping').innerHTML = "INF";
      pc.close()
      document.getElementById('player').classList.add("hidden");
      document.getElementById('start').classList.remove("hidden");
    }
  });

  const offer = await pc.createOffer();

  await pc.setLocalDescription(offer);

  // wait for ICE gathering to complete
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
    } else {
      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', checkState);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', checkState);
    }
  });

  let response;
  try {
    response = await fetch('/offer', {
      body: JSON.stringify({
        sdp: offer.sdp,
        type: offer.type,
      }),
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'POST'
    });
    if (!response.ok) {
      throw new Error(`Server response with code ${response.status} message '${await response.text()}'`);
    }
  } catch (err) {
    document.getElementById('status').innerHTML = `Network error: ${err.message}`;
    pc.close()
    document.getElementById('start').classList.remove("hidden");
  }
  const answer = await response.json();

  await pc.setRemoteDescription(answer);
}

async function getSerial() {
  const usbVendorId = 0x10c4; // Silicon Labs
  const port = await navigator.serial.requestPort({ filters: [{ usbVendorId }] })
  await port.open({ baudRate: 921600 });
  
  const writer = port.writable.getWriter();

  async function* gen() {
    let isClose;
    while (port.readable) {
      // see: https://web.dev/articles/streams?hl=zh-cn#creating_a_readable_byte_stream
      const reader = port.readable.getReader({ mode: "byob" });
      try {
        while (true) {
          // fixed length 
          let buffer = new ArrayBuffer(16 + 2); // package length = 16
          let offset = 0

          const { value, done } = await reader.read(new Uint8Array(buffer, 0, 1));
          if (done) throw Error('done'); // |reader| has been canceled.
          console.assert(value.byteLength > 0);

          buffer = value.buffer;

          // syncing
          while ((new Uint8Array(buffer, 0, 1))[0] != 0x5a) {
            console.log("syncing..." + (new Uint8Array(buffer, 0, 1))[0]);
            const { value, done } = await reader.read(new Uint8Array(buffer, 0, 1));
            if (done) throw Error('done'); // |reader| has been canceled.
            console.assert(value.byteLength > 0);

            buffer = value.buffer;
          }
          offset += 1;

          // read remain package
          while (offset < buffer.byteLength) {
            const { value, done } = await reader.read(new Uint8Array(buffer, offset, buffer.byteLength - offset));
            if (done) throw Error('done'); // |reader| has been canceled.
            console.assert(value.byteLength > 0);

            buffer = value.buffer;
            offset += value.byteLength;
          }
          
          isClose = yield buffer;
          if (isClose) throw Error('Close');
        }
      } catch (error) {
        console.error("opps")
        console.error(error)
        // Handle |error|...
      } finally {
        reader.releaseLock();
      }
      if (isClose) break;
    }
    writer.releaseLock();

    port.close();
  }
  
  const g = await gen();

  return { serialRead: (close) => g.next(close), serialWrite: writer.write };
}

const PEDAL_MAX = 4096;

const pedalNames = ["angular-pos", "angular-neg", "linear-neg", "linear-pos"];
const pedalIds = [0, 1, 2, 3];

function getPedalValues(buffer) {
  let pedalValues = [];
  const data = new DataView(buffer, 2);
  for (const i in pedalNames) {
    pedalValues.push(data.getUint16(2 * pedalIds[i], false) / PEDAL_MAX);
  }
  return pedalValues;
}

async function connectPedal() {
  if (localStorage.getItem("pedalMin") === null) {
    document.getElementById('status').innerHTML = `You need calibrate pedal first`;
    return;
  }
  const pedalMin = JSON.parse(localStorage.getItem("pedalMin"));
  const pedalMax = JSON.parse(localStorage.getItem("pedalMax"));

  const { serialRead, serialWrite } = await getSerial();
  
  document.getElementById('connect-pedal').classList.add("hidden");
  document.getElementById('calibrate-pedal').classList.add("hidden");
  document.getElementById('status').innerHTML = 'Pedel connected.';
  
  document.getElementById('pedal-status').innerHTML = 'connected';

  const fromServerCb = async function (evt) {
    console.dir(evt.detail);
    await serialWrite(evt.detail);
  }

  pedalCommTarget.addEventListener('fromServer', fromServerCb);

  while (true) {
    const { value: buffer, done } = await serialRead();
    if (done) break;

    // see: https://stackoverflow.com/questions/7869752/javascript-typed-arrays-and-endianness
    const pedalValues = getPedalValues(buffer);
    for (const i in pedalNames) {
      document.getElementById('pedal-' + pedalNames[i]).value = pedalValues[i] * 100;
    }

    const pedalRealValues = [];
    for (const i in pedalNames) {
      pedalRealValues.push((pedalValues[i] - pedalMin[i]) / (pedalMax[i] - pedalMin[i]));
    }
    
    pedalCommTarget.dispatchEvent(new CustomEvent("toServer", { detail: JSON.stringify(pedalRealValues) }))
  }

  pedalCommTarget.removeEventListener('fromServer', fromServerCb);
  
  document.getElementById('pedal-status').innerHTML = 'disconnected';

  document.getElementById('connect-pedal').classList.remove("hidden");
  document.getElementById('calibrate-pedal').classList.remove("hidden");
  document.getElementById('status').innerHTML = 'Pedel disconnected.';
}

async function calibratePedal() {
  const { serialRead } = await getSerial();
  
  document.getElementById('connect-pedal').classList.add("hidden");
  document.getElementById('calibrate-pedal').classList.add("hidden");
  document.getElementById('status').innerHTML = 'Pedel connected.';
  
  document.getElementById('pedal-status').innerHTML = 'connected';

  async function wait() {
    let buffer;
    const start = performance.now();
    while (true) {
      if (performance.now() - start > 2000) break;
      ({ value: buffer, done } = await serialRead());
      if (done) throw new Error;

      // see: https://stackoverflow.com/questions/7869752/javascript-typed-arrays-and-endianness
      const pedalValues = getPedalValues(buffer);
      for (const i in pedalNames) {
        document.getElementById('pedal-' + pedalNames[i]).value = pedalValues[i] * 100;
      }
      
      await new Promise(requestAnimationFrame);
    }
    return buffer;
  }

  document.getElementById('status').innerHTML = 'Release all the pedals.';
  buffer = await wait();

  const pedalMin = getPedalValues(buffer);
  console.dir(pedalMin);
    
  document.getElementById('status').innerHTML = 'Min value saved.';
  await wait();

  const pedalMax = [];
  
  for (const i in pedalNames) {
    document.getElementById('status').innerHTML = `Press pedal ${pedalNames[i]}.`;
    buffer = await wait();

    const pedalValues = getPedalValues(buffer);
    pedalMax.push(pedalValues[i]);
    console.dir(pedalMax);
    
    document.getElementById('status').innerHTML = `Release pedal ${pedalNames[i]}.`;
    await wait();
  }
    
  localStorage.setItem("pedalMin", JSON.stringify(pedalMin));
  localStorage.setItem("pedalMax", JSON.stringify(pedalMax));

  document.getElementById('status').innerHTML = `Pedal calibration saved. <br>Min: ${pedalMin}<br>Max: ${pedalMax}`;

  await serialRead(true);
  
  document.getElementById('pedal-status').innerHTML = 'disconnected';

  document.getElementById('connect-pedal').classList.remove("hidden");
  document.getElementById('calibrate-pedal').classList.remove("hidden");
}

window.addEventListener('load', function () {
  // Notice: autoplay is restricted when user is not clicked the page
  // start()

  const leftHandURL = location.protocol + '//' + location.host + "/hand.html#left";

  new QRCode("qrcode-left", {
    text: leftHandURL,
    width: 128,
    height: 128,
    correctLevel : QRCode.CorrectLevel.L
  });
  
  document.getElementById('link-left').href = leftHandURL;

  const rightHandURL = location.protocol + '//' + location.host + "/hand.html#right";
  
  new QRCode("qrcode-right", {
    text: rightHandURL,
    width: 128,
    height: 128,
    correctLevel : QRCode.CorrectLevel.L
  });
  
  document.getElementById('link-right').href = leftHandURL;



  document.addEventListener(
    "keydown",
    (event) => {
      const keyName = event.key;
  
      if (keyName === "Control") {
        // do not alert when only Control key is pressed.
        return;
      }
  
      if (event.ctrlKey) {
        // Even though event.key is not 'Control' (e.g., 'a' is pressed),
        // event.ctrlKey may be true if Ctrl key is pressed at the same time.
        // alert(`Combination of ctrlKey + ${keyName}`);
        return;
      } else {
        if (keyName == 'z') {
          controlCommTarget.dispatchEvent(new CustomEvent("toServer", { detail: JSON.stringify("disable_arm_teleop") }))
        } else if (keyName == 'x') {
          controlCommTarget.dispatchEvent(new CustomEvent("toServer", { detail: JSON.stringify("enable_arm_teleop") }))
        } else if (keyName == 'r') {
          controlCommTarget.dispatchEvent(new CustomEvent("toServer", { detail: JSON.stringify("reset") }))
        } else if (keyName == 'f') {
          controlCommTarget.dispatchEvent(new CustomEvent("toServer", { detail: JSON.stringify("done") }))
        }
      }
    },
    false,
  );

  controlCommTarget.addEventListener('fromServer', async function (evt) {
    document.getElementById('status').innerHTML = JSON.parse(evt.detail);
  });
})