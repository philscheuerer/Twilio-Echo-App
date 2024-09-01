import asyncio
import json
import base64
import sounddevice as sd
import numpy as np
import audioop
from twilio.twiml.voice_response import VoiceResponse, Connect
from twilio.rest import Client
from aiohttp import web
from dotenv import load_dotenv
import os

# Load environment variables from .env file
load_dotenv()

# Twilio API credentials from environment variables
TWILIO_ACCOUNT_SID = os.getenv('TWILIO_ACCOUNT_SID')
TWILIO_AUTH_TOKEN = os.getenv('TWILIO_AUTH_TOKEN')
TWILIO_NUMBER = os.getenv('TWILIO_NUMBER')
WEBSOCKET_URL = os.getenv('WEBSOCKET_URL')

# Initialize Twilio client
twilio_client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

def decode_mu_law(audio_data):
    """Decode mu-law encoded audio to PCM 16-bit using audioop."""
    return audioop.ulaw2lin(audio_data, 2)

async def handle_twilio_stream(request):
    """
    Handle incoming WebSocket connections from Twilio and play audio in real-time.
    """
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    print("Incoming call detected...")

    # Open a sounddevice stream for continuous playback with low latency
    stream = sd.OutputStream(samplerate=8000, channels=1, dtype='int16', blocksize=0, latency='low')
    stream.start()

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                data = json.loads(msg.data)
                if data.get('event') == 'media':
                    # Decode and directly play the audio data
                    chunk = base64.b64decode(data['media']['payload'])
                    pcm_data = decode_mu_law(chunk)
                    stream.write(np.frombuffer(pcm_data, dtype=np.int16))

                elif data.get('event') == 'closed':
                    print("Call ended.")
                    break

            elif msg.type == web.WSMsgType.ERROR:
                print(f'WebSocket connection closed with exception {ws.exception()}')
    except Exception as e:
        print(f"Error in Twilio stream handling: {str(e)}")
    finally:
        stream.stop()
        stream.close()
        await ws.close()
        print("Connection closed.")

    return ws

async def handle_voice(request):
    """
    Handle incoming voice requests from Twilio and return TwiML to initiate a stream.
    """
    return web.Response(text=generate_twiml(), content_type='text/xml')

def generate_twiml():
    """
    Generate TwiML response to instruct Twilio to start streaming audio.
    """
    response = VoiceResponse()
    connect = Connect()
    connect.stream(url=WEBSOCKET_URL, content_type='audio/l16;rate=8000')
    response.append(connect)
    return str(response)

async def main():
    """
    Main entry point for the application, setting up the web server and routes.
    """
    app = web.Application()
    app.router.add_post('/voice', handle_voice)
    app.router.add_get('/stream', handle_twilio_stream)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, 'localhost', 8080)
    await site.start()

    print("Server started on http://localhost:8080")

    # Keep the server running
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())

