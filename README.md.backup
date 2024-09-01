# Twilio-Echo-App
## Real-Time Audio Streaming

This project allows you to play a Twilio phone call in real-time on your laptop. It is designed for development and debugging purposes, specifically to test latency and audio quality.
By: ©oding-kangaroo

## Prerequisites

- **Python 3.7+**: Ensure Python is installed on your system.
- **Twilio Account**: With an active phone number and API credentials.
- **ngrok**: To expose your local server to a public URL.

## Setup

### 1. Clone the Repository

Clone the repository to your local machine:

```bash
git clone https://github.com/your-username/twilio-audio-streaming.git
cd twilio-audio-streaming
```


## 2. Create and Activate a Virtual Environment

Create a Python virtual environment to keep dependencies isolated:
```bash
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

```


## 3. Install Dependencies

Install all required Python packages from requirements.txt:

```bash
pip install -r requirements.txt
```


## 4. Create a .env File

Create a .env file in the root directory of the project and add the following entries:

```plaintext
# Twilio API Credentials
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_NUMBER=your_twilio_number

# WebSocket Configuration
WEBSOCKET_URL=wss://your-ngrok-url/stream
```

Replace the placeholders (your_twilio_account_sid, your_twilio_auth_token, your_twilio_number, your-ngrok-url) with your actual values.


## 5. Set Up and Run ngrok

Install ngrok to expose your local server through a publicly accessible URL:

1. **Download and install ngrok:** Follow the instructions on ngrok.com.

2. **Start ngrok:** Forward your local server to a public HTTP port:

	```bash
	ngrok http 8080
	```

	This will generate a public URL like https://abcdef1234.ngrok-free.app, which you will use in the next step.
	
	

## 6. Configure Twilio Webhook

1. **Open Twilio Console:** Go to the Twilio Console.

2. **Phone Numbers:** Select your active phone number.

3. **A Call Comes In:** Paste the ngrok URL with the /voice path.

4. **Example:**

    ```plaintext
    https://abcdef1234.ngrok-free.app/voice
    ```
    Ensure that the HTTP method is set to POST.

## 7. Run the Application

Start the script main.py to launch the server and handle incoming calls:

```bash
python main.py
```


## 8. Test the Call

Call your Twilio number. The call should be played back in real-time on your laptop, allowing you to assess latency and audio quality.


## Purpose of the Application

This application is intended for development and debugging of real-time audio streaming. It helps in testing the latency and audio quality of calls processed by Twilio and played back on a local system.


## Notes

1. ngrok: Remember that the ngrok URL changes every time ngrok is restarted. You will need to update the Twilio configuration accordingly.

2. Troubleshooting: If you encounter underrun errors (ALSA lib pcm.c:8526:(snd_pcm_recover) underrun occurred), consider increasing the blocksize in the sounddevice stream configuration.



