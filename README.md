# Teensy 4.0 Digital Hearing Aid

## Project Overview

This repository implements a real-time digital hearing aid prototype based on the PJRC Teensy 4.0 microcontroller (ARM Cortex-M7 running at 600 MHz) and the SGTL5000-based Teensy Audio Shield (Rev D). The system performs low-latency audio acquisition, multi-band parametric equalization via cascaded second-order IIR (Biquad) peaking filters, dynamic output limiting, and automated in-situ pure-tone audiometry calibration.

A companion browser-based interface connects via the Web Serial API (115200 baud) to provide interactive audiogram plotting (ISO 8253-1 compliant), live frequency band gain adjustment, hardware telemetry monitoring, and SVG export.

## Hardware & Pinout Configuration

### Target Hardware
- Microcontroller: PJRC Teensy 4.0 (NXP i.MX RT1062, 600 MHz Cortex-M7, 1024 KB RAM, 2048 KB Flash)
- Audio Codec: Teensy Audio Shield Rev D (NXP SGTL5000 24-bit audio codec)
- Transducers: 3.5 mm electret condenser microphone or line-in, 3.5 mm stereo headphone output
- Tactile Input: Momentary push button connected between pin 0 and GND (configured with internal `INPUT_PULLUP`)

### Audio Shield Pin Assignment (Teensy 4.0 I2S Bus)
The Audio Shield connects directly to the Teensy 4.0 header pins using the standard PJRC footprint:

| Pin | Function | Direction | Description |
|---|---|---|---|
| 7 | I2S MCLK | Output | Master Clock (SGTL5000 SYS_MCLK) |
| 13 | I2S RX | Input | Audio Data from SGTL5000 ADC to Teensy |
| 18 | I2C SDA | Bidirectional | SGTL5000 control interface data line |
| 19 | I2C SCL | Output | SGTL5000 control interface clock line |
| 20 | I2S LRCLK | Output | Frame Clock / Word Select (44.1 kHz) |
| 21 | I2S BCLK | Output | Bit Clock (64 * fs = 2.8224 MHz) |
| 22 | I2S TX | Output | Audio Data from Teensy to SGTL5000 DAC |
| 23 | Reset | Output | Codec hardware reset (active low) |
| 0 | BUTTON_PIN | Input | Calibration trigger (INPUT_PULLUP to GND) |

Do not attach external analog or digital signals to pins 7, 13, 18, 19, 20, 21, 22, or 23.

### Compile-Time Constants (`config.h`)
The firmware constants are defined in `config.h`:

- `SAMPLE_RATE`: 44100.0 Hz (Teensy Audio Library standard clock)
- `NUM_BANDS`: 6 frequency bands (250 Hz, 500 Hz, 1000 Hz, 2000 Hz, 4000 Hz, 8000 Hz)
- `AUDIO_MEMORY_BLOCKS`: 12 blocks (each block contains 128 16-bit PCM samples, costing 256 bytes; 12 blocks = 3 KB RAM)
- `BUTTON_PIN`: Pin 0 (debounced active-low button for manual audiometry response)
- `SGTL5000_VOLUME`: 0.70 normalized headphone output level
- `SGTL5000_MIC_GAIN`: 36 dB analog microphone pre-amplifier gain
- `AUDIO_INPUT`: `AUDIO_INPUT_MIC` (swappable to `AUDIO_INPUT_LINEIN`)
- `MAX_OUTPUT`: 0.95 normalized hard-limiting threshold (-0.45 dBFS)
- `CAL_START_AMP`: 0.02 normalized initial tone amplitude (-34 dBFS)
- `CAL_STEP_AMP`: 0.02 amplitude increment per audiometric step
- `CAL_MAX_AMP`: 0.80 sweep ceiling (-1.9 dBFS)
- `CAL_TONE_MS`: 400 ms stimulus duration
- `CAL_SILENCE_MS`: 700 ms response window
- `CAL_DEBOUNCE_MS`: 50 ms button debounce delay
- `CAL_MAX_GAIN_DB`: 30.0 dB maximum compensation gain clamp
- `DIAG_INTERVAL_MS`: 2000 ms periodic telemetry reporting period

## Signal Processing Architecture

### Audio Pipeline Graph
The Teensy Audio Library manages audio transfers through Direct Memory Access (DMA) at block increments of 128 samples (~2.9 ms per block at 44.1 kHz).

```
   [AudioInputI2S] (Mic L) ────► [AudioMixer4: ch0] ────► [AudioEQStream] ────► [AudioOutputI2S] (L)
   [AudioSynthWaveformSine] ───► [AudioMixer4: ch1]                        └────► [AudioOutputI2S] (R)
```

The system operates across four discrete execution modes managed by `AudioPipeline::setDebugMode()`:
- `NORMAL`: Mixer ch0 enabled (gain 1.0), ch1 disabled (gain 0.0). Filter bank active.
- `PASSTHROUGH`: Mixer ch0 enabled, ch1 disabled. Filter bank bypassed (`y[n] = x[n]`).
- `TONE`: Mixer ch0 disabled, ch1 enabled with synthetic sine generator. Filter bank bypassed.
- `ADC_PRINT`: Mixer ch0 enabled, output muted. Live 16-bit ADC samples logged via Serial.

### Biquad Peaking Filter Implementation (`peak_eq.cpp`, `peak_eq.h`)
Each of the 6 equalizer bands is implemented as a Direct Form II Transposed second-order IIR peaking filter using the Robert Bristow-Johnson (RBJ) Audio EQ Cookbook formulae.

Transfer function normalized to a0 = 1:
```
        b0 + b1*z^-1 + b2*z^-2
 H(z) = -----------------------
         1 + a1*z^-1 + a2*z^-2
```

Coefficient calculation for band center frequency f0, quality factor Q, gain G_dB, and sample rate fs:
```
w0    = 2 * pi * f0 / fs
A     = 10^(G_dB / 40)
alpha = sin(w0) / (2 * Q)

b0_raw =  1 + alpha * A
b1_raw = -2 * cos(w0)
b2_raw =  1 - alpha * A
a0_raw =  1 + alpha / A
a1_raw = -2 * cos(w0)
a2_raw =  1 - alpha / A

b0 = b0_raw / a0_raw
b1 = b1_raw / a0_raw
b2 = b2_raw / a0_raw
a1 = a1_raw / a0_raw
a2 = a2_raw / a0_raw
```

Difference equation (Direct Form II Transposed per sample x[n]):
```
y[n] = b0 * x[n] + z1[n-1]
z1[n] = b1 * x[n] - a1 * y[n] + z2[n-1]
z2[n] = b2 * x[n] - a2 * y[n]
```

Direct Form II Transposed requires only two memory state registers (z1, z2) per filter stage and provides superior numerical stability compared to Direct Form I when executed on single-precision floating-point hardware.

### Default Audiometric Profile (`profile.cpp`)
When uncalibrated, the device defaults to a baseline profile configured for high-frequency sensorineural hearing loss:

| Band | Center Frequency | Quality Factor (Q) | Default Gain (dB) |
|---|---|---|---|
| 0 | 250 Hz | 1.2 | +6.0 dB |
| 1 | 500 Hz | 1.3 | +4.0 dB |
| 2 | 1000 Hz | 1.4 | 0.0 dB |
| 3 | 2000 Hz | 1.5 | -2.0 dB |
| 4 | 4000 Hz | 1.6 | +7.0 dB |
| 5 | 8000 Hz | 1.8 | +10.0 dB |

### In-Situ Calibration Sequence (`calibration.cpp`)
The automated calibration sequence determines individual hearing detection thresholds across all 6 bands:
1. For each band i in [0, 5], the pipeline generates an ascending pure-tone sweep at f0.
2. The amplitude starts at `CAL_START_AMP` (0.02) and increments by `CAL_STEP_AMP` (0.02) up to `CAL_MAX_AMP` (0.80).
3. At each step, the tone sounds for 400 ms followed by a 700 ms observation window.
4. When the user confirms detection (either via physical button closure or serial `HEARD` command), threshold amplitude A_thresh is recorded.
5. Compensation gain is computed relative to the baseline detection floor:
   ```
   gainDB = min(20 * log10(A_thresh / CAL_START_AMP), CAL_MAX_GAIN_DB)
   ```
   If A_thresh <= CAL_START_AMP, gainDB = 0.0 dB. If the tone is not heard during the sweep, gainDB = 0.0 dB.
6. The updated profile is applied atomically using `AudioEQStream::loadProfile()`.

## Serial Communication Protocol

The firmware communicates over USB Serial at 115200 baud, 8-N-1. Line endings are newline (`\n` or `\r\n`).

### Firmware Command Reference

| Command | Arguments | Description | Response Example |
|---|---|---|---|
| `SET_GAIN` | `band=<0-5> gain=<dB>` | Set gain for a single EQ band | `ACK  band=4  gain=7.0 dB` |
| `PROFILE` | None | Print tabular summary of all 6 bands | ASCII table formatted |
| `DEBUG_MODE` | `NORMAL` \| `PASSTHROUGH` \| `TONE` \| `ADC_PRINT` | Switch audio pipeline routing | `Mode -> NORMAL (...)` |
| `DIAG` | None | Trigger immediate telemetry dump | Diagnostics report block |
| `CALIBRATE` | None | Initiate automated audiometry sweep | Step-by-step sweep output |
| `HEARD` | None | Audiometry response confirmation | Registered during calibration |
| `HELP` | None | List available commands | Command list |

### Diagnostics Telemetry Format
The `DIAG` command outputs:
- Execution mode (`NORMAL`, `PASSTHROUGH`, `TONE`, `ADC_PRINT`)
- Audio processor utilization percentage (current and peak)
- Audio block memory usage (current, peak, and total allocated)
- Input and output peak normalized amplitudes with 20-character ASCII level meters
- Limiter activation counter (number of clamped samples)
- Hardware self-check status indicators (`[OK]`, `[WARN]`, or `[FAIL]`)

## Web Calibration Interface

The `web/` directory contains a standalone interface running on HTML5, CSS3, ES Modules, and D3.js v7.

### Architecture
- `serial.js`: Asynchronous Web Serial API wrapper handling connection, disconnection, stream decoding, and debounced transmissions.
- `audiogram.js`: D3-based ISO 8253-1 clinical audiogram renderer. Displays frequency on a logarithmic scale (125 Hz to 8000 Hz) and hearing level in dB HL on an inverted vertical axis (-10 dB HL at top to 120 dB HL at bottom) with WHO severity classifications (Normal, Mild, Moderate, Severe, Profound).
- `eqPanel.js`: Interactive 6-band parametric equalizer controls with bidirectional serial synchronization.
- `calibration.js`: Asynchronous state machine orchestrating the audiometry sequence, stimulus progress tracking, and gain calculation.
- `diagnostics.js`: Real-time telemetry parser with rolling history sparklines for CPU load and signal peaks.
- `server.py` / `serve.sh`: Local HTTP server providing required Cross-Origin-Opener-Policy (COOP) and Cross-Origin-Embedder-Policy (COEP) headers for Web Serial execution.

### Launching the Web Interface
1. Launch the local server:
   ```bash
   cd web
   ./serve.sh 8080
   ```
   Or invoke Python directly:
   ```bash
   python3 web/server.py 8080
   ```
2. Navigate to `http://localhost:8080` in Google Chrome or Microsoft Edge (version 89+ required for Web Serial support).
3. Click "Connect Device", select the USB Serial port corresponding to Teensy 4.0, and proceed with live equalization or audiometry calibration.

## Build and Flash Instructions

### Prerequisites
- Teensy Loader application or `teensy_loader_cli`
- Arduino IDE 2.x with the Teensyduino add-on installed, or PlatformIO Core

### Option 1: Arduino IDE with Teensyduino
1. Open Arduino IDE and install Teensy support via Boards Manager (`teensy` package by Paul Stoffregen).
2. Open `HearingAid.ino`.
3. Select Tools > Board > Teensyduino > Teensy 4.0.
4. Select Tools > USB Type > Serial.
5. Select Tools > CPU Speed > 600 MHz.
6. Select Tools > Optimize > Faster.
7. Click Verify (Compile) to validate the build.
8. Connect the Teensy 4.0 via USB and click Upload.

### Option 2: CLI Build via PlatformIO
If using PlatformIO Core (`pio`):
```ini
[env:teensy40]
platform = teensy
board = teensy40
framework = arduino
build_flags = -O2 -DUSB_SERIAL
```
Execute:
```bash
pio run --target upload
```
