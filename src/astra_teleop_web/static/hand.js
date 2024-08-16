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
        width: { min: 640, ideal: 1280, max: 1280 },
        height: { min: 480, ideal: 720, max: 720 }
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
  
  const width = Math.max($video.videoWidth, $video.videoHeight);
  const height = Math.min($video.videoWidth, $video.videoHeight);

  const cv2 = await cv;

  const $inCanvas = document.createElement('canvas');
  const inCtx = $inCanvas.getContext('2d', { willReadFrequently: true });
  $inCanvas.width = width;
  $inCanvas.height = height;

  let $inRotateCanvas = null;
  let inRotateCtx = null;
  let inRotateFrame = null;

  function imread(mat) {
    if ($video.videoWidth > $video.videoHeight) {
      inCtx.drawImage($video, 0, 0, $video.videoWidth, $video.videoHeight);
      mat.data.set(inCtx.getImageData(0, 0, $video.videoWidth, $video.videoHeight).data)
    } else {
      if (!$inRotateCanvas) { // handle rotation issue
        $inRotateCanvas = document.createElement('canvas');
        inRotateCtx = $inRotateCanvas.getContext('2d', { willReadFrequently: true });
        $inRotateCanvas.width = $video.videoWidth;
        $inRotateCanvas.height = $video.videoHeight;
        
        inRotateFrame = new cv2.Mat($video.videoHeight, $video.videoWidth, cv2.CV_8UC4);
      }
      inRotateCtx.drawImage($video, 0, 0, $video.videoWidth, $video.videoHeight);
      inRotateFrame.data.set(inRotateCtx.getImageData(0, 0, $video.videoWidth, $video.videoHeight).data)
      cv2.rotate(inRotateFrame, mat, cv2.ROTATE_90_CLOCKWISE)
    }
  }

  const $outCanvas = document.getElementById('canvas-imshow');
  const outCtx = $outCanvas.getContext("2d");
  $outCanvas.width = 960;
  $outCanvas.height = 540;
  
  const outFrame = new cv2.Mat();

  function imshow(mat) {
    cv2.resize(mat, mat, new cv2.Size(960, 540), 0, 0, cv2.INTER_LINEAR) // lower resolution for faster output
    const depth = mat.type() % 8;
    const scale = depth <= cv2.CV_8S ? 1 : depth <= cv2.CV_32S ? 1 / 256 : 255;
    const shift = depth === cv2.CV_8S || depth === cv2.CV_16S ? 128 : 0;
    mat.convertTo(outFrame, cv2.CV_8U, scale, shift);
    switch (outFrame.type()) {
    case cv2.CV_8UC1:
      cv2.cvtColor(outFrame, outFrame, cv2.COLOR_GRAY2RGBA);
      break;
    case cv2.CV_8UC3:
      cv2.cvtColor(outFrame, outFrame, cv2.COLOR_RGB2RGBA);
      break;
    case cv2.CV_8UC4:
      break;
    default:
      throw new Error("Bad number of channels (Source image must have 1, 3 or 4 channels)");
    }
    const imgData = new ImageData(new Uint8ClampedArray(outFrame.data), outFrame.cols, outFrame.rows);
    outCtx.putImageData(imgData, 0, 0);
  }

  const frame = new cv2.Mat(height, width, cv2.CV_8UC4);
  const dstFrame = new cv2.Mat();

  const aruco_dict = cv2.getPredefinedDictionary(cv2.DICT_6X6_250)
  const aruco_detection_parameters = new cv2.aruco_DetectorParameters()
  // aruco_detection_parameters.cornerRefinementMethod = cv2.CORNER_REFINE_APRILTAG
  const detector = new cv2.aruco_ArucoDetector(aruco_dict, aruco_detection_parameters, new cv2.aruco_RefineParameters(10, 3, true))
  
  const corners = new cv2.MatVector();
  const ids = new cv2.Mat();
  const rejected = new cv2.MatVector();

  function tick(){
    if ($video.readyState === $video.HAVE_ENOUGH_DATA){
      imread(frame)
  
      const start = performance.now();
      detector.detectMarkers(frame, corners, ids, rejected)
      const end = performance.now();
      document.getElementById('aruco-timing').innerHTML = Math.round(end - start);
      
      // frame.copyTo(dstFrame)
  
      cv2.cvtColor(frame, dstFrame, cv2.COLOR_RGBA2RGB);
      cv2.drawDetectedMarkers(dstFrame, corners, ids)
  
      imshow(dstFrame)
    }
    requestAnimationFrame(tick);
  }
  
  requestAnimationFrame(tick);
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