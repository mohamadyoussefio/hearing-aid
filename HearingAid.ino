#include <Arduino.h>
#include <Audio.h>
#include <Wire.h>
#include <SPI.h>
#include "config.h"
#include "audio_pipeline.h"
#include "calibration.h"

// ============================================================================
// HearingAid.ino  —  Audio Shield (SGTL5000 / I2S) version
//
// What changed from the PWM version
// -----------------------------------
//  • The IntervalTimer + audioISR() are gone.  The Teensy Audio Library owns
//    the sample clock (44100 Hz, 128 samples/block via I2S DMA).
//  • analogWriteResolution / analogWriteFrequency / analogReadResolution are
//    gone.  Pin 21 is now the I2S BCLK and must not be touched.
//  • AudioMemory() and the five AudioConnection objects below replace the old
//    RC-filter PWM output path.
//  • AudioPipeline::init() calls sgtl5000.enable() and sets volume/mic-gain.
//    Everything else (EQ, calibration, Serial commands) is identical.
//
// Audio graph
// -----------
//
//   audio.i2sIn  (L) ──► audio.inputMixer (ch 0) ──► audio.eqStream ──► audio.i2sOut (L)
//   audio.toneGen    ──► audio.inputMixer (ch 1)                     └──► audio.i2sOut (R)
//
//   inputMixer ch 0 gain = 1 → mic/line active  (NORMAL, PASSTHROUGH, ADC_PRINT)
//   inputMixer ch 1 gain = 1 → tone active       (TONE / calibration)
//   AudioPipeline::setDebugMode() switches gains automatically.
//
// Hardware wiring (Audio Shield)
// --------------------------------
//  The shield stacks directly on the Teensy.  Do NOT add any external wiring
//  on pins 7, 13, 18, 19, 20, 21, 22, 23 — they are used by the shield.
//
//  BUTTON_PIN (0) — touch a wire from pin 0 to GND during the 3-second boot
//                   window to enter calibration.  Uses INPUT_PULLUP.
//
//  Microphone — plug into the 3.5 mm MIC jack on the Audio Shield, or connect
//               an electret capsule to the MIC header.  Set AUDIO_INPUT and
//               SGTL5000_MIC_GAIN in config.h to match.
//
//  Headphones — plug into the 3.5 mm headphone jack on the Audio Shield.
//               Adjust SGTL5000_VOLUME in config.h (0.0–1.0).
//
// Serial commands (115200 baud)
// -----------------------------
//  SET_GAIN band=<0-5> gain=<dB>   — adjust one EQ band at runtime
//  PROFILE                         — print the current EQ profile table
//  DEBUG_MODE NORMAL               — full EQ pipeline (default)
//  DEBUG_MODE PASSTHROUGH          — mic → headphones, EQ bypassed
//  DEBUG_MODE TONE                 — internal 1 kHz sine → headphones
//  DEBUG_MODE ADC_PRINT            — print raw mic values, headphones muted
//  DIAG                            — print diagnostics immediately
//  CALIBRATE                       — run the audiometry sequence at any time
//  HELP                            — list all commands
// ============================================================================

// ----------------------------------------------------------------------------
// Global objects
// ----------------------------------------------------------------------------
AudioPipeline audio;
Calibration   calibration(audio);

// ----------------------------------------------------------------------------
// Audio Library connection graph
//
// These objects MUST be declared after 'audio' so the AudioPipeline member
// objects (i2sIn, toneGen, inputMixer, eqStream, i2sOut) already exist when
// the AudioConnection constructors run.
//
// Channel mapping for inputMixer:
//   ch 0 ← i2sIn  left channel  (microphone / line-in)
//   ch 1 ← toneGen              (calibration / debug tone)
// ----------------------------------------------------------------------------
AudioConnection  patchMicToMixer   (audio.i2sIn,     0, audio.inputMixer, 0);
AudioConnection  patchToneToMixer  (audio.toneGen,   0, audio.inputMixer, 1);
AudioConnection  patchMixerToEQ    (audio.inputMixer, 0, audio.eqStream,  0);
AudioConnection  patchEQToOutLeft  (audio.eqStream,  0, audio.i2sOut,    0);
AudioConnection  patchEQToOutRight (audio.eqStream,  0, audio.i2sOut,    1);

// ----------------------------------------------------------------------------
// printHelp
// ----------------------------------------------------------------------------
static void printHelp() {
    Serial.println(F(""));
    Serial.println(F("============ COMMANDS ============"));
    Serial.println(F("  SET_GAIN band=<0-5> gain=<dB>"));
    Serial.println(F("      Adjust one EQ band gain."));
    Serial.println(F("      Example: SET_GAIN band=4 gain=10.5"));
    Serial.println(F(""));
    Serial.println(F("  PROFILE"));
    Serial.println(F("      Print the current EQ profile table."));
    Serial.println(F(""));
    Serial.println(F("  DEBUG_MODE <mode>"));
    Serial.println(F("      NORMAL      — full EQ pipeline (default)"));
    Serial.println(F("      PASSTHROUGH — mic -> headphones, EQ bypassed"));
    Serial.println(F("      TONE        — internal 1 kHz test tone -> headphones"));
    Serial.println(F("      ADC_PRINT   — print raw mic values, headphones muted"));
    Serial.println(F(""));
    Serial.println(F("  DIAG"));
    Serial.println(F("      Print diagnostics immediately."));
    Serial.println(F(""));
    Serial.println(F("  CALIBRATE"));
    Serial.println(F("      Run the full audiometry calibration sequence."));
    Serial.println(F(""));
    Serial.println(F("  HELP"));
    Serial.println(F("      Show this message."));
    Serial.println(F("=================================="));
    Serial.println(F(""));
}

// ----------------------------------------------------------------------------
// handleSetGain
// Parses: SET_GAIN band=<0-5> gain=<dB>
// ----------------------------------------------------------------------------
static void handleSetGain(const String &cmd) {
    int bandIdx = cmd.indexOf(F("band="));
    int gainIdx = cmd.indexOf(F("gain="));

    if (bandIdx == -1 || gainIdx == -1) {
        Serial.println(F("ERR: usage: SET_GAIN band=<0-5> gain=<dB>"));
        return;
    }

    int bandEnd = cmd.indexOf(' ', bandIdx + 5);
    int band    = (bandEnd == -1)
                  ? cmd.substring(bandIdx + 5).toInt()
                  : cmd.substring(bandIdx + 5, bandEnd).toInt();

    float gain = cmd.substring(gainIdx + 5).toFloat();

    if (band < 0 || band >= NUM_BANDS) {
        Serial.print(F("ERR: band must be 0 - "));
        Serial.println(NUM_BANDS - 1);
        return;
    }

    audio.setGain(band, gain);
    // ACK is printed inside AudioPipeline::setGain()
}

// ----------------------------------------------------------------------------
// handleDebugMode
// Parses: DEBUG_MODE <NORMAL|PASSTHROUGH|TONE|ADC_PRINT>
// ----------------------------------------------------------------------------
static void handleDebugMode(const String &cmd) {
    String arg = cmd.substring(10);
    arg.trim();

    if (arg.equalsIgnoreCase(F("NORMAL"))) {
        audio.setDebugMode(DebugMode::NORMAL);
    } else if (arg.equalsIgnoreCase(F("PASSTHROUGH"))) {
        audio.setDebugMode(DebugMode::PASSTHROUGH);
    } else if (arg.equalsIgnoreCase(F("TONE"))) {
        audio.setToneParams(1000.0f, 0.5f);
        audio.setDebugMode(DebugMode::TONE);
    } else if (arg.equalsIgnoreCase(F("ADC_PRINT"))) {
        audio.setDebugMode(DebugMode::ADC_PRINT);
    } else {
        Serial.print(F("ERR: unknown mode '"));
        Serial.print(arg);
        Serial.println(F("'  Valid: NORMAL PASSTHROUGH TONE ADC_PRINT"));
    }
}

// ----------------------------------------------------------------------------
// Diagnostics timer
// ----------------------------------------------------------------------------
static uint32_t lastDiagMs = 0;

// ----------------------------------------------------------------------------
// setup
// ----------------------------------------------------------------------------
void setup() {
    Serial.begin(115200);
    delay(500);   // allow USB Serial to enumerate

    // --- Allocate Audio Library block memory ---
    // Must be called before any AudioStream objects start running.
    AudioMemory(AUDIO_MEMORY_BLOCKS);

    // --- Calibration button ---
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // --- Initialise the pipeline (SGTL5000 codec + default EQ profile) ---
    // AudioConnection objects are already wired above at static-init time.
    audio.init();

    // --- Boot banner ---
    Serial.println(F(""));
    Serial.println(F("============================================"));
    Serial.println(F("      Teensy Hearing Aid  (Audio Shield)"));
    Serial.println(F("============================================"));
    Serial.println(F("  Hold BUTTON_PIN to GND within 3 seconds"));
    Serial.println(F("  to run audiometry calibration."));
    Serial.println(F("  Otherwise normal mode starts automatically."));
    Serial.println(F("============================================"));

    // --- 3-second boot window for calibration ---
    uint32_t bootDeadline = millis() + 3000;
    bool     doCalibrate  = false;

    while (millis() < bootDeadline) {
        if (calibration.isRequested()) {
            doCalibrate = true;
            break;
        }
        delay(10);
    }

    if (doCalibrate) {
        calibration.run();
    } else {
        Serial.println(F("  Starting in NORMAL mode with default profile."));
        audio.setDebugMode(DebugMode::NORMAL);
        audio.printCurrentProfile();
    }

    lastDiagMs = millis();

    Serial.println(F(""));
    Serial.println(F("  Auto diagnostics every 2 s.  Type HELP for commands."));
    Serial.println(F("============================================"));
    Serial.println(F(""));
}

// ----------------------------------------------------------------------------
// loop
//
// Audio processing runs entirely inside the Audio Library's DMA interrupt.
// loop() handles:
//   1. Flushing ADC_PRINT output to Serial.
//   2. Periodic diagnostic reports.
//   3. Serial command parsing.
// ----------------------------------------------------------------------------
void loop() {

    // --- ADC_PRINT: forward buffered mic samples to Serial ---
    audio.flushAdcPrint();

    // --- Periodic diagnostics ---
    uint32_t now = millis();
    if (now - lastDiagMs >= DIAG_INTERVAL_MS) {
        audio.printDiagnostics(now - lastDiagMs);
        lastDiagMs = now;
    }

    // --- Serial command parser ---
    if (!Serial.available()) return;

    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.length() == 0) return;

    Serial.print(F("> "));
    Serial.println(cmd);

    if (cmd.startsWith(F("SET_GAIN"))) {
        handleSetGain(cmd);
        return;
    }

    if (cmd.equalsIgnoreCase(F("PROFILE"))) {
        audio.printCurrentProfile();
        return;
    }

    if (cmd.startsWith(F("DEBUG_MODE"))) {
        handleDebugMode(cmd);
        return;
    }

    if (cmd.equalsIgnoreCase(F("DIAG"))) {
        uint32_t elapsed = millis() - lastDiagMs;
        audio.printDiagnostics(elapsed > 0 ? elapsed : 1);
        lastDiagMs = millis();
        return;
    }

    if (cmd.equalsIgnoreCase(F("CALIBRATE"))) {
        calibration.run();
        lastDiagMs = millis();
        return;
    }

    if (cmd.equalsIgnoreCase(F("HELP"))) {
        printHelp();
        return;
    }

    Serial.print(F("ERR: unknown command '"));
    Serial.print(cmd);
    Serial.println(F("'  Type HELP for a list of commands."));
}
