import asyncio
import json
from pathlib import Path
import subprocess
import aiohttp.web
import aiortc.mediastreams
import aiortc
import aiortc.contrib.media
import av
import av.frame
import av.packet
import av.video
import PIL.Image
import fractions
import ssl

import threading
import queue

import time

import os

from typing import Set, Union

import logging
logger = logging.getLogger(__name__)

class FeedableVideoStreamTrack(aiortc.mediastreams.MediaStreamTrack):
    kind = 'video'

    def __init__(self, VIDEO_PTIME=1/32, VIDEO_CLOCK_RATE=90000):
        super().__init__()
        self.VIDEO_PTIME = VIDEO_PTIME
        self.VIDEO_CLOCK_RATE = VIDEO_CLOCK_RATE
        self.q = queue.LifoQueue(maxsize=1)

    async def recv(self) -> Union[av.frame.Frame, av.packet.Packet]:
        if self.readyState != "live":
            raise aiortc.mediastreams.MediaStreamError
        
        image = await asyncio.get_running_loop().run_in_executor(None, self.q.get)
        frame = av.video.VideoFrame.from_image(image)

        if hasattr(self, "_timestamp"):
            self._timestamp += int(self.VIDEO_PTIME * self.VIDEO_CLOCK_RATE)
        else:
            self._timestamp = 0

        frame.pts = self._timestamp
        frame.time_base = fractions.Fraction(1, self.VIDEO_CLOCK_RATE)

        return frame
    
    def feed(self, image: PIL.Image):
        try:
            self.q.put_nowait(image)
        except queue.Full:
            try:
                self.q.get_nowait()
                logger.warning('lost one message')
            except queue.Empty:
                logger.debug('times fly!')
                pass
            self.q.put_nowait(image) # Should not throw any error

def asyncio_run_thread_in_new_loop(coroutine):
    loop = asyncio.new_event_loop()
    loop.run_until_complete(coroutine)
    loop.run_forever()

class WebServer:
    def __init__(self):
        self.t = threading.Thread(target=asyncio_run_thread_in_new_loop, args=(self.run_server(), ), daemon=True)
        self.t.start()

    async def run_server(self):
        self.app = aiohttp.web.Application()

        self.pcs: Set[aiortc.RTCPeerConnection] = set()

        async def on_shutdown(app):
            # close peer connections
            await asyncio.gather(*[pc.close() for pc in self.pcs])
            self.pcs.clear()
        self.app.on_shutdown.append(on_shutdown)

        self.app.router.add_post("/offer", self.offer)

        script_dir = os.path.dirname(os.path.abspath(__file__))
        self.app.router.add_static('/', os.path.join(script_dir, 'static'), show_index=True)

        # aiohttp.web.run_self.app(self.app, host="0.0.0.0", port=8088, loop=asyncio.get_event_loop())
        # See: https://github.com/aiortc/aiortc/issues/1116

        if not Path("cert.pem").exists():
            print("generating certs")
            subprocess.check_call(
                "openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -sha256 -days 3650 -nodes -subj '/CN=astra-teleop-web'",
                shell=True
            )
        ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ssl_context.load_cert_chain('cert.pem', 'key.pem')

        runner = aiohttp.web.AppRunner(self.app)
        await runner.setup()

        site = aiohttp.web.TCPSite(runner, '0.0.0.0', 9443, ssl_context=ssl_context)
        await site.start()
        
        print("start teleop at https://localhost:9443/index.html")

    async def offer(self, request):
        params = await request.json()

        offer = aiortc.RTCSessionDescription(sdp=params["sdp"], type=params["type"])

        pc = aiortc.RTCPeerConnection()
        self.pcs.add(pc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            print("Connection state is %s" % pc.connectionState)
            if pc.connectionState == "failed":
                await pc.close()
                self.pcs.discard(pc)
                
        @pc.on("datachannel")
        def on_datachannel(channel):
            logger.info("channel(%s) - %s" % (channel.label, repr("created by remote party")))
            if channel.label == "pedal":
                @channel.on("message")
                async def on_message(msg):
                    print(msg)
            else:
                raise Exception("Unknown label")

        track = FeedableVideoStreamTrack()
        pc.addTransceiver(track, "sendonly")

        await pc.setRemoteDescription(offer)

        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        return aiohttp.web.Response(
            content_type="application/json",
            text=json.dumps(
                {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
            ),
        )

def main():
    webserver = WebServer()
    
    while True:
        time.sleep(1)

if __name__ == '__main__':
    main()
