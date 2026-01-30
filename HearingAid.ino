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
}

void loop() {
    delay(10);
}
