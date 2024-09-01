import sounddevice as sd
import websocket
import numpy as np
import threading
from dotenv import load_dotenv
import os

# Load environment variables from .env file
load_dotenv()

# WebSocket Configuration from environment variables
WEBSOCKET_URL = os.getenv('WEBSOCKET_URL')

# Audio configuration
RATE = 8000  # Twilio sends audio at 8kHz
CHANNELS = 1

def on_message(ws, message):
    """Handle incoming WebSocket messages containing audio data."""
    audio_data = np.frombuffer(message, dtype=np.int16)
    sd.play(audio_data, samplerate=RATE, blocking=True)

def on_error(ws, error):
    """Handle WebSocket errors."""
    print(f"Error: {error}")

def on_close(ws, close_status_code, close_msg):
    """Handle WebSocket connection closure."""
    print("WebSocket closed")

def on_open(ws):
    """Handle WebSocket connection opening."""
    print("WebSocket connection opened")

def start_websocket():
    """Start the WebSocket client and connect to the specified URL."""
    ws = websocket.WebSocketApp(WEBSOCKET_URL,
                                on_open=on_open,
                                on_message=on_message,
                                on_error=on_error,
                                on_close=on_close)
    ws.run_forever()

# Start WebSocket in a separate thread
ws_thread = threading.Thread(target=start_websocket)
ws_thread.start()

# Wait until the WebSocket thread finishes
ws_thread.join()

