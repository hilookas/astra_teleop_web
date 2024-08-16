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
        width: { min: 640, ideal: 1920, max: 1920 },
        height: { min: 480, ideal: 1080, max: 1080 }
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

  const $video = document.getElementById('video-hand')
  $video.srcObject = stream;
  $video.play() // different from autoplay! When autoplay is set, video will be paused when the video is out of view

  // wait for video element play
  await new Promise((resolve) => {
    $video.addEventListener('loadedmetadata', resolve)
  });

  const { videoWidth, videoHeight } = $video;

  const $inCanvas = document.createElement('canvas');
  const inCtx = $inCanvas.getContext('2d');
  $inCanvas.width = videoWidth;
  $inCanvas.height = videoHeight;

  const $outCanvas = document.getElementById('canvas-imshow');
  const outCtx = $outCanvas.getContext("2d");
  $outCanvas.width = videoWidth;
  $outCanvas.height = videoHeight;

  function imread(mat) {
    inCtx.drawImage($video, 0, 0, videoWidth, videoHeight);
    mat.data.set(inCtx.getImageData(0, 0, videoWidth, videoHeight).data)
  }
  
  const outFrame = new cv.Mat;

  function imshow(mat) {
    const depth = mat.type() % 8;
    const scale = depth <= cv.CV_8S ? 1 : depth <= cv.CV_32S ? 1 / 256 : 255;
    const shift = depth === cv.CV_8S || depth === cv.CV_16S ? 128 : 0;
    mat.convertTo(outFrame, cv.CV_8U, scale, shift);
    switch (outFrame.type()) {
    case cv.CV_8UC1:
      cv.cvtColor(outFrame, outFrame, cv.COLOR_GRAY2RGBA);
      break;
    case cv.CV_8UC3:
      cv.cvtColor(outFrame, outFrame, cv.COLOR_RGB2RGBA);
      break;
    case cv.CV_8UC4:
      break;
    default:
      throw new Error("Bad number of channels (Source image must have 1, 3 or 4 channels)");
    }
    const imgData = new ImageData(new Uint8ClampedArray(outFrame.data), outFrame.cols, outFrame.rows);
    outCtx.putImageData(imgData, 0, 0);
  }

  const srcFrame = new cv.Mat(videoHeight, videoWidth, cv.CV_8UC4);
  const dstFrame = new cv.Mat(videoHeight, videoWidth, cv.CV_8UC1);

  while (true) {
    imread(srcFrame)
    cv.cvtColor(srcFrame, dstFrame, cv.COLOR_RGBA2GRAY);

    imshow(dstFrame)
    await sleep(1);
  }
}

const handCommTarget = new EventTarget();

async function start() {
  document.getElementById('start').classList.add("hidden");
  document.getElementById('status').innerHTML = "Connecting...";

  const pc = new RTCPeerConnection({
    sdpSemantics: 'unified-plan'
  });

  const handChannel = pc.createDataChannel("hand")

  const toServerCb = async function (evt) {
    handChannel.send(evt.detail)
  }

  handChannel.addEventListener('open', function (evt) {
    handCommTarget.addEventListener('toServer', toServerCb);

    handChannel.addEventListener('message', function (evt) {
      handCommTarget.dispatchEvent(new CustomEvent("fromServer", { detail: evt.data }))
    })
  })

  handChannel.addEventListener('close', function (evt) {
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
    response = await fetch('/offer-hand-' + handType, {
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

let handType = null;

window.addEventListener('load', function () {
  // Notice: autoplay is restricted when user is not clicked the page
  // start()

  handType = window.location.hash.substring(1);
  if (handType === "left") {
    document.getElementById('which-hand').innerHTML = 'Left ';
  } else if (handType === "right") {
    document.getElementById('which-hand').innerHTML = 'Right ';
  } else {
    document.getElementById('status').innerHTML = "Hand type must be 'left' or 'right'";
    document.getElementById('start').classList.add("hidden");
    handType = null;
    return;
  }

  document.getElementById('status').innerHTML = `Click the start stream button.`;
})