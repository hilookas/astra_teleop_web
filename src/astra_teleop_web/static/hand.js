function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

function waitFrame($video) {
  return new Promise((resolve) => {
    function tick() {
      if ($video.readyState === $video.HAVE_ENOUGH_DATA) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
}

async function getMedia() {
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
    throw err;
  }
  
  document.getElementById('capture').classList.add("hidden");
  document.getElementById('calibrate').classList.add("hidden");
  
  const track = stream.getVideoTracks()[0];
  trackSetting = track.getSettings();
  document.getElementById('status').innerHTML = `Using video device: ${track.label} ${trackSetting.width}x${trackSetting.height}@${trackSetting.frameRate}`;

  const $video = document.getElementById('video-hand');
  $video.srcObject = stream;
  $video.play(); // different from autoplay! When autoplay is set, video will be paused when the video is out of view

  return $video;
}

async function initOpenCV($video) {
  // wait for video element play
  await new Promise((resolve) => {
    $video.addEventListener('loadedmetadata', resolve)
  });
  
  const width = Math.max($video.videoWidth, $video.videoHeight);
  const height = Math.min($video.videoWidth, $video.videoHeight);

  window.cv2 = await cv;

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
    cv2.flip(mat, mat, 1)
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

  return { width, height, imread, imshow }
}

async function capture() {
  if (localStorage.getItem("camera_matrix") === null) {
    document.getElementById('status').innerHTML = `You need calibrate camera first`;
    return;
  }
  const camera_matrix_list = JSON.parse(localStorage.getItem("camera_matrix"));
  const distortion_coefficients_list = JSON.parse(localStorage.getItem("distortion_coefficients"));

  const $video = await getMedia();
  const { width, height, imread, imshow } = await initOpenCV($video);

  const frame = new cv2.Mat(height, width, cv2.CV_8UC4);
  const dstFrame = new cv2.Mat();

  const aruco_dict = cv2.getPredefinedDictionary(cv2.DICT_4X4_50);
  const aruco_detection_parameters = new cv2.aruco_DetectorParameters();
  aruco_detection_parameters.cornerRefinementMethod = cv2.CORNER_REFINE_SUBPIX; // Faster
  // aruco_detection_parameters.cornerRefinementMethod = cv2.CORNER_REFINE_APRILTAG; // Provide subpixel accuracy
  // aruco_detection_parameters.aprilTagQuadDecimate = 2; // Speed up for wasm
  const refine_parameters = new cv2.aruco_RefineParameters(10, 3, true)
  const detector = new cv2.aruco_ArucoDetector(aruco_dict, aruco_detection_parameters, refine_parameters);
  
  const fromServerCb = async function (evt) {
    console.dir(evt.detail);
  }

  handCommTarget.addEventListener('fromServer', fromServerCb);

  while (true) {
    await waitFrame($video);
    imread(frame)
    
    const corners = new cv2.MatVector();
    const ids = new cv2.Mat();
    const rejected = new cv2.MatVector();

    const start = performance.now();
    detector.detectMarkers(frame, corners, ids, rejected)
    const end = performance.now();
    document.getElementById('aruco-timing').innerHTML = Math.round(end - start);

    // for (let l = 0; l < corners.size(); ++l) {
    //   const temp_corners = corners.get(l);
    //   console.log(temp_corners.rows)
    //   console.log(temp_corners.cols)
    //   console.dir(temp_corners.type()) // type(): cv2.CV_32FC2
    //   console.dir(temp_corners.data32F)
    // }
    // console.dir(ids.type()) // type(): cv2.CV_32SC1
    // console.dir(ids.data32S) // type(): cv2.CV_32SC1
    
    const corners_list_list = [];
    for (let l = 0; l < corners.size(); ++l) {
      const temp_corners = corners.get(l);
      const corners_list = [];
      const rows = temp_corners.rows;
      const cols = temp_corners.cols;
      const channels = Math.trunc(temp_corners.type() / 8) + 1;
      for (let i = 0; i < rows; ++i) {
        const row = [];
        for (let j = 0; j < cols; ++j) {
          const point = [];
          for (let k = 0; k < channels; ++k) {
            point.push(temp_corners.data32F[(i * cols + j) * channels + k]);
          }
          row.push(point);
        }
        corners_list.push(row);
      }
      corners_list_list.push(corners_list);
    }
    
    const ids_list = [];
    for (let i = 0; i < ids.rows; ++i) {
      const row = [];
      for (let j = 0; j < ids.cols; ++j) {
        row.push(ids.data32S[i * ids.cols + j]);
      }
      ids_list.push(row);
    }

    // console.dir(corners_list_list)
    // console.dir(ids_list)
    
    handCommTarget.dispatchEvent(new CustomEvent("toServer", { detail: JSON.stringify([
      camera_matrix_list,
      distortion_coefficients_list,
      corners_list_list,
      ids_list
    ]) }))
    
    // frame.copyTo(dstFrame)

    cv2.cvtColor(frame, dstFrame, cv2.COLOR_RGBA2RGB);
    cv2.drawDetectedMarkers(dstFrame, corners, ids);

    imshow(dstFrame);

    corners.delete();
    ids.delete();
    rejected.delete();
  }

  handCommTarget.removeEventListener('fromServer', fromServerCb);

  frame.delete();
  dstFrame.delete();

  aruco_dict.delete();
  aruco_detection_parameters.delete();
  refine_parameters.delete();
  detector.delete();
}

async function calibrate() {
  const $video = await getMedia();
  const { width, height, imread, imshow } = await initOpenCV($video);

  const frame = new cv2.Mat(height, width, cv2.CV_8UC4);
  const dstFrame = new cv2.Mat();

  // Aruco Board
  const aruco_dict = cv2.getPredefinedDictionary(cv2.DICT_5X5_1000);
  const aruco_board = new cv2.aruco_CharucoBoard(new cv2.Size(5, 7), 0.04, 0.02, aruco_dict, new cv2.Mat());

  const charuco_parameters = new cv2.aruco_CharucoParameters();
  const detector_parameters = new cv2.aruco_DetectorParameters();
  const refine_parameters = new cv2.aruco_RefineParameters(10, 3, true);
  const charuco_detector = new cv2.aruco_CharucoDetector(aruco_board, charuco_parameters, detector_parameters, refine_parameters);

  let number_of_points = 0;
  const all_object_points = new cv2.MatVector();
  const all_image_points = new cv2.MatVector();
  
  let cnt = 0;
  let last_cnt = performance.now();
  
  const max_cnt = 40;
  const min_cnt_interval = 500;
  
  while (cnt < max_cnt) {
    await waitFrame($video);
    imread(frame);
    cv2.cvtColor(frame, dstFrame, cv2.COLOR_RGBA2RGB);
    
    const charuco_corners = new cv2.Mat();
    const charuco_ids = new cv2.Mat();
    const marker_corners = new cv2.MatVector();
    const marker_ids = new cv2.Mat();
  
    const start = performance.now();
    charuco_detector.detectBoard(dstFrame, charuco_corners, charuco_ids, marker_corners, marker_ids);
    const end = performance.now();
    document.getElementById('aruco-timing').innerHTML = Math.round(end - start);
  
    // console.log('len(charuco_ids) =', charuco_ids.rows);
    
    if (charuco_ids.rows > 0) {
      // console.dir(charuco_corners.data32F) // type(): cv2.CV_32FC2
      // console.dir(charuco_ids.data32S) // type(): cv2.CV_32SC1
  
      // matchImagePoints require complicated type convert
      const detected_corners = new cv2.MatVector();
      for (let i = 0; i < charuco_corners.rows; ++i) {
        mat = new cv2.Mat(1, 1, cv2.CV_32FC2);
        mat.data.set(charuco_corners.data.subarray(i * 8, i * 8 + 8));
        detected_corners.push_back(mat);
      }
  
      const object_points = new cv2.Mat();
      const image_points = new cv2.Mat();
      aruco_board.matchImagePoints(detected_corners, charuco_ids, object_points, image_points);
      
      // console.log('len(object_points) =', object_points.rows);
  
      if (object_points.rows >= 8 && performance.now() - last_cnt > min_cnt_interval) {
        last_cnt = performance.now();
        ++cnt;
        number_of_points += object_points.rows;
        all_object_points.push_back(object_points);
        all_image_points.push_back(image_points);
        document.getElementById('status').innerHTML = `Collecting image (${cnt}/${max_cnt})`;
      }
  
      cv2.drawDetectedCornersCharuco(dstFrame, charuco_corners, charuco_ids);
      detected_corners.delete();
  
      object_points.delete();
      image_points.delete();
    }
    // aruco_board.generateImage(new cv2.Size(1280, 720), dstFrame, 0, 1);
    imshow(dstFrame);
  
    charuco_corners.delete();
    charuco_ids.delete();
    marker_corners.delete();
    marker_ids.delete();
  }
  
  // console.dir(number_of_points)
  
  document.getElementById('status').innerHTML = `Collection done. It may take about 3 minutes to do calibration. number_of_points: ${number_of_points}`;
  
  await sleep(100);
  
  const camera_matrix = new cv2.Mat();
  const distortion_coefficients = new cv2.Mat();
  const rotation_vectors = new cv2.MatVector();
  const translation_vectors = new cv2.MatVector();

  const projection_error = cv2.calibrateCameraExtended(
    all_object_points,
    all_image_points,
    new cv2.Size(width, height),
    camera_matrix, 
    distortion_coefficients, 
    rotation_vectors, 
    translation_vectors,
    new cv2.Mat(),
    new cv2.Mat(),
    new cv2.Mat()
  );

  // console.dir(camera_matrix.rows); // type(): cv2.CV_64FC1
  // console.dir(camera_matrix.cols); // type(): cv2.CV_64FC1
  // console.dir(camera_matrix.data64F); // type(): cv2.CV_64FC1
  // console.dir(distortion_coefficients.rows); // type(): cv2.CV_64FC1
  // console.dir(distortion_coefficients.cols); // type(): cv2.CV_64FC1
  // console.dir(distortion_coefficients.data64F); // type(): cv2.CV_64FC1
  // console.dir(projection_error);

  const camera_matrix_list = [];
  for (let i = 0; i < camera_matrix.rows; ++i) {
    const row = [];
    for (let j = 0; j < camera_matrix.cols; ++j) {
      row.push(camera_matrix.data64F[i * camera_matrix.cols + j]);
    }
    camera_matrix_list.push(row);
  }
  
  const distortion_coefficients_list = [];
  for (let i = 0; i < distortion_coefficients.rows; ++i) {
    const row = [];
    for (let j = 0; j < distortion_coefficients.cols; ++j) {
      row.push(distortion_coefficients.data64F[i * distortion_coefficients.cols + j]);
    }
    distortion_coefficients_list.push(row);
  }

  localStorage.setItem("camera_matrix", JSON.stringify(camera_matrix_list));
  localStorage.setItem("distortion_coefficients", JSON.stringify(distortion_coefficients_list));
  
  document.getElementById('status').innerHTML = `Calibration result saved! projection_error: ${projection_error}, camera_matrix: ${JSON.stringify(camera_matrix_list)}, distortion_coefficients ${JSON.stringify(distortion_coefficients_list)}`;

  frame.delete();
  dstFrame.delete();

  aruco_dict.delete();
  aruco_board.delete();

  charuco_parameters.delete();
  detector_parameters.delete();
  refine_parameters.delete();
  charuco_detector.delete();

  all_object_points.delete();
  all_image_points.delete();

  camera_matrix.delete();
  distortion_coefficients.delete();
  rotation_vectors.delete();
  translation_vectors.delete();

  document.getElementById('capture').classList.remove("hidden");
  document.getElementById('calibrate').classList.remove("hidden");
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
  } else if (handType === "both") {
    document.getElementById('which-hand').innerHTML = 'Both ';
  } else {
    document.getElementById('status').innerHTML = "Hand type must be 'left', 'right', or 'both'";
    document.getElementById('start').classList.add("hidden");
    handType = null;
    return;
  }

  document.getElementById('status').innerHTML = `Click the start stream button.`;
})