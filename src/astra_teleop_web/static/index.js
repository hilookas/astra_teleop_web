function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

const pedalCommTarget = new EventTarget();

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
    } else if (pc.connectionState === 'disconnected') {
      document.getElementById('status').innerHTML = `Lost connection.`;
      clearInterval(showPing)
      document.getElementById('pc-ping').innerHTML = "INF";
      pc.close()
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

async function connectPedal() {
  const usbVendorId = 0x10c4; // Silicon Labs
  const port = await navigator.serial.requestPort({ filters: [{ usbVendorId }] })
  await port.open({ baudRate: 921600 });

  document.getElementById('connect-pedal').classList.add("hidden");
  document.getElementById('status').innerHTML = 'Pedel connected.';

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const writer = port.writable.getWriter();

  pedalCommTarget.addEventListener('fromServer', async function (evt) {
    console.dir(evt.detail)
    await writer.write(evt.detail)
  })

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

        const pkg = new Uint8Array(buffer)
        // console.dir(pkg)
        pedalCommTarget.dispatchEvent(new CustomEvent("toServer", { detail: buffer }))
      }
    } catch (error) {
      console.error("opps")
      console.error(error)
      // Handle |error|...
    } finally {
      reader.releaseLock();
    }
  }
  writer.releaseLock();

  document.getElementById('connect-pedal').classList.remove("hidden");
  document.getElementById('status').innerHTML = 'Pedel disconnected.';
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
})