function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

async function capture() {
  let stream;
  try {
     stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { 
          exact: "user", // or environment
        },
        frameRate: { min: 30, ideal: 60, max: 60 },
        width: { min: 1080, ideal: 1920, max: 1920 },
        height: { min: 720, ideal: 1080, max: 1080 }
      },
    });
  } catch (err) {
    document.getElementById('status').innerHTML = `Error opening video capture (may be your cam have too low resolution): ${err.name} ${err.message}`;
    throw err
  }
  document.getElementById('capture').classList.add("hidden");
  
  const track = stream.getVideoTracks()[0];
  trackSetting = track.getSettings()
  document.getElementById('status').innerHTML = `Using video device: ${track.label} ${trackSetting.width}x${trackSetting.height}@${trackSetting.frameRate}`;

  document.getElementById('video_hand').srcObject = stream;
}

const handCommTarget = new EventTarget();

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

  const channel_hand = pc.createDataChannel("hand")

  const toServerCb = async function (evt) {
    channel_hand.send(evt.detail)
  }

  channel_hand.addEventListener('open', function (evt) {
    handCommTarget.addEventListener('toServer', toServerCb);

    channel_hand.addEventListener('message', function (evt) {
      handCommTarget.dispatchEvent(new CustomEvent("fromServer", { detail: evt.data }))
    })
  })

  channel_hand.addEventListener('close', function (evt) {
    handCommTarget.removeEventListener('toServer', toServerCb);
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
    response = await fetch('/offer-hand-' + hand_type, {
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

let hand_type = null;

window.addEventListener('load', function () {
  // Notice: autoplay is restricted when user is not clicked the page
  // start()

  hand_type = window.location.hash.substring(1);
  if (hand_type === "left") {
    document.getElementById('which-hand').innerHTML = 'Left ';
  } else if (hand_type === "right") {
    document.getElementById('which-hand').innerHTML = 'Right ';
  } else {
    document.getElementById('status').innerHTML = "Hand type must be 'left' or 'right'";
    document.getElementById('start').classList.add("hidden");
    hand_type = null;
    return;
  }
})