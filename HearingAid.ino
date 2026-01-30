#include <Arduino.h>
#include <Audio.h>
#include <Wire.h>
#include <SPI.h>
#include "config.h"
#include "audio_pipeline.h"

AudioPipeline audio;

AudioConnection patchMicToMixer   (audio.i2sIn,     0, audio.inputMixer, 0);
AudioConnection patchToneToMixer  (audio.toneGen,   0, audio.inputMixer, 1);
AudioConnection patchMixerToEQ    (audio.inputMixer, 0, audio.eqStream,  0);
AudioConnection patchEQToOutLeft  (audio.eqStream,  0, audio.i2sOut,    0);
AudioConnection patchEQToOutRight (audio.eqStream,  0, audio.i2sOut,    1);

static void printHelp() {
    Serial.println(F(""));
    Serial.println(F("============ COMMANDS ============"));
    Serial.println(F("  SET_GAIN band=<0-5> gain=<dB>"));
    Serial.println(F("  PROFILE"));
    Serial.println(F("  DEBUG_MODE <mode>"));
    Serial.println(F("  DIAG"));
    Serial.println(F("  HELP"));
    Serial.println(F("=================================="));
}

static void handleSetGain(const String &cmd) {
    int bandIdx = cmd.indexOf(F("band="));
    int gainIdx = cmd.indexOf(F("gain="));
    if (bandIdx == -1 || gainIdx == -1) return;

    int bandEnd = cmd.indexOf(' ', bandIdx + 5);
    int band = (bandEnd == -1) ? cmd.substring(bandIdx + 5).toInt() : cmd.substring(bandIdx + 5, bandEnd).toInt();
    float gain = cmd.substring(gainIdx + 5).toFloat();

    if (band >= 0 && band < NUM_BANDS) {
        audio.setGain(band, gain);
    }
}

static void handleDebugMode(const String &cmd) {
    String arg = cmd.substring(10);
    arg.trim();
    if (arg.equalsIgnoreCase(F("NORMAL"))) audio.setDebugMode(DebugMode::NORMAL);
    else if (arg.equalsIgnoreCase(F("PASSTHROUGH"))) audio.setDebugMode(DebugMode::PASSTHROUGH);
    else if (arg.equalsIgnoreCase(F("TONE"))) {
        audio.setToneParams(1000.0f, 0.5f);
        audio.setDebugMode(DebugMode::TONE);
    } else if (arg.equalsIgnoreCase(F("ADC_PRINT"))) audio.setDebugMode(DebugMode::ADC_PRINT);
}

static uint32_t lastDiagMs = 0;

void setup() {
    Serial.begin(115200);
    delay(500);

    AudioMemory(AUDIO_MEMORY_BLOCKS);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    audio.init();

    Serial.println(F("============================================"));
    Serial.println(F("      Teensy Hearing Aid  (Audio Shield)    "));
    Serial.println(F("============================================"));
    audio.setDebugMode(DebugMode::NORMAL);
    audio.printCurrentProfile();
    lastDiagMs = millis();
}

void loop() {
    audio.flushAdcPrint();

    uint32_t now = millis();
    if (now - lastDiagMs >= DIAG_INTERVAL_MS) {
        audio.printDiagnostics(now - lastDiagMs);
        lastDiagMs = now;
    }

    if (!Serial.available()) return;
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.length() == 0) return;

    if (cmd.startsWith(F("SET_GAIN"))) handleSetGain(cmd);
    else if (cmd.equalsIgnoreCase(F("PROFILE"))) audio.printCurrentProfile();
    else if (cmd.startsWith(F("DEBUG_MODE"))) handleDebugMode(cmd);
    else if (cmd.equalsIgnoreCase(F("DIAG"))) audio.printDiagnostics(millis() - lastDiagMs);
    else if (cmd.equalsIgnoreCase(F("HELP"))) printHelp();
}
