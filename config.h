#ifndef CONFIG_H
#define CONFIG_H

// ============================================================================
// HearingAid — config.h
// Single source of truth for every compile-time constant in the project.
// Change values here; every file that includes this header picks them up.
// ============================================================================

// ----------------------------------------------------------------------------
// Audio sample rate
// The Teensy Audio Library runs at exactly 44100 Hz.
// ----------------------------------------------------------------------------
#define SAMPLE_RATE         44100.0f

// ----------------------------------------------------------------------------
// EQ band count
// Must match the number of entries in DEFAULT_PROFILE (profile.cpp).
// ----------------------------------------------------------------------------
#define NUM_BANDS           6

// ----------------------------------------------------------------------------
// Pin assignments
//
//  BUTTON_PIN — calibration button: connect a wire from this pin to GND
//               and touch it to GND to press. Uses INPUT_PULLUP.
//
// Audio Shield I2S pins are managed automatically by the Teensy Audio Library
// and must NOT be configured manually:
//   Pin 7  — I2S MCLK
//   Pin 20 — I2S LRCLK
//   Pin 21 — I2S BCLK   ← do NOT analogWrite here
//   Pin 22 — I2S TX (Teensy → codec DAC → headphones)
//   Pin 13 — I2S RX (codec ADC mic/line → Teensy)
//   Pin 18 — I2C SDA  (SGTL5000 control)
//   Pin 19 — I2C SCL  (SGTL5000 control)
// ----------------------------------------------------------------------------
#define BUTTON_PIN          0

// ----------------------------------------------------------------------------
// Teensy Audio Shield — SGTL5000 codec settings
//
//  SGTL5000_VOLUME   — headphone output volume, 0.0 (mute) to 1.0 (max)
//                      0.7 is a safe starting point; reduce if distorted.
//  SGTL5000_MIC_GAIN — microphone pre-amp gain in dB (0–63 dB).
//                      36 dB suits most small electret capsules on the shield.
//  AUDIO_INPUT       — AUDIO_INPUT_MIC  for the shield's onboard mic header
//                      AUDIO_INPUT_LINEIN for a line-level source
// ----------------------------------------------------------------------------
#define SGTL5000_VOLUME     0.7f
#define SGTL5000_MIC_GAIN   36
#define AUDIO_INPUT         AUDIO_INPUT_MIC

// ----------------------------------------------------------------------------
// Audio Library memory
// The Teensy Audio Library needs a pool of 128-sample audio blocks.
// Each block costs 256 bytes of RAM.  12 blocks = 3 kB, enough for this
// simple graph (input → mixer → EQ → output) with headroom.
// ----------------------------------------------------------------------------
#define AUDIO_MEMORY_BLOCKS 12

// ----------------------------------------------------------------------------
// Output limiter ceiling  (normalised, 0.0–1.0)
// Samples whose absolute value exceeds this are hard-clipped before being
// handed back to the Audio Library output stream.
// ----------------------------------------------------------------------------
#define MAX_OUTPUT          0.95f

// ----------------------------------------------------------------------------
// Calibration parameters
//
//  CAL_START_AMP   — tone amplitude at the start of each sweep (0.0–1.0)
//  CAL_STEP_AMP    — amplitude increment per step
//  CAL_MAX_AMP     — sweep stops here even if user never presses the button
//  CAL_TONE_MS     — how long the tone plays before each amplitude step (ms)
//  CAL_SILENCE_MS  — silence gap between tone bursts so the user can react (ms)
//  CAL_DEBOUNCE_MS — button debounce time (ms)
//  CAL_MAX_GAIN_DB — computed gain is capped to this value (dB)
// ----------------------------------------------------------------------------
#define CAL_START_AMP       0.02f
#define CAL_STEP_AMP        0.02f
#define CAL_MAX_AMP         0.80f
#define CAL_TONE_MS         400
#define CAL_SILENCE_MS      700
#define CAL_DEBOUNCE_MS     50
#define CAL_MAX_GAIN_DB     30.0f

// ----------------------------------------------------------------------------
// Diagnostics
// Auto-print interval in the main loop (milliseconds).
// ----------------------------------------------------------------------------
#define DIAG_INTERVAL_MS    2000

#endif // CONFIG_H
