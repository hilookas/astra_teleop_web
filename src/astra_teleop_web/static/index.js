function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

const channel = {
  pedal: null,
}

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
        document.getElementById('video_head').srcObject = new MediaStream([evt.track]);
      } else if (evt.transceiver.mid === '1') {
        document.getElementById('video_wrist_left').srcObject = new MediaStream([evt.track]);
      } else if (evt.transceiver.mid === '2') {
        document.getElementById('video_wrist_right').srcObject = new MediaStream([evt.track]);
      } else {
        console.error("Unsupported mid")
      }
    }
  });

  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });

  const channel_pedal = pc.createDataChannel("pedal")

  channel_pedal.addEventListener('open', function (evt) {
    channel.pedal = channel_pedal
  })

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

  const response = await fetch('/offer', {
    body: JSON.stringify({
      sdp: offer.sdp,
      type: offer.type,
    }),
    headers: {
      'Content-Type': 'application/json'
    },
    method: 'POST'
  });
  const answer = await response.json();

  await pc.setRemoteDescription(answer);

  document.getElementById('status').innerHTML = "Connected";
  document.getElementById('stop').classList.remove("hidden");
  document.getElementById('connect-pedal').classList.remove("hidden");
  const step = 100
  for (let i = 1000; i > 0; i -= step) {
    document.getElementById('status').innerHTML = `Please select the pedal connected in next popup.   ${i / 1000.0}s`;
    await sleep(step);
  }
  document.getElementById('connect-pedal').click();
}

// window.addEventListener('load', function () {
//   // Notice: autoplay is restricted when user is not clicked the page
//   start()
// })

async function connect_pedal() {
  const usbVendorId = 0x10c4; // Silicon Labs
  const port = await navigator.serial.requestPort({ filters: [{ usbVendorId }] })
  await port.open({ baudRate: 921600 });

  document.getElementById('connect-pedal').classList.add("hidden");
  document.getElementById('status').innerHTML = 'Pedel connected.';

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const writer = port.writable.getWriter();

  channel.pedal.addEventListener('message', async function (evt) {
    console.dir(evt.data)
    await writer.write(evt.data)
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
        channel.pedal.send(buffer)
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
}