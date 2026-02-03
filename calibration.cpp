#include "calibration.h"
#include "config.h"
#include <Arduino.h>
#include <math.h>

Calibration::Calibration(AudioPipeline &pipeline) : _pipeline(pipeline) {
    pinMode(BUTTON_PIN, INPUT_PULLUP);
}

bool Calibration::isRequested() {
    return (digitalRead(BUTTON_PIN) == LOW);
}

bool Calibration::waitForButton(uint32_t timeoutMs) {
    uint32_t deadline = millis() + timeoutMs;
    while (millis() < deadline) {
        if (digitalRead(BUTTON_PIN) == LOW) {
            delay(CAL_DEBOUNCE_MS);
            if (digitalRead(BUTTON_PIN) == LOW) {
                while (digitalRead(BUTTON_PIN) == LOW) { delay(10); }
                delay(CAL_DEBOUNCE_MS);
                return true;
            }
        }
    }
    return false;
}

float Calibration::measureThreshold(float freqHz) {
    float amp = CAL_START_AMP;
    while (amp <= CAL_MAX_AMP + 1e-6f) {
        _pipeline.setToneParams(freqHz, amp);
        _pipeline.setDebugMode(DebugMode::TONE);

        if (waitForButton(CAL_TONE_MS)) return amp;

        _pipeline.setToneParams(freqHz, 0.0f);
        if (waitForButton(CAL_SILENCE_MS)) return amp;

        amp += CAL_STEP_AMP;
    }
    return 0.0f;
}
